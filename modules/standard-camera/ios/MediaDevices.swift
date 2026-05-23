import AVFoundation
import ExpoModulesCore

// @ref LLP 0002 — getUserMedia subset
// The TypeScript layer flattens spec-shaped constraints (which may be boolean or
// ConstrainDOMString objects) into the simple optionals below before calling
// native. See modules/standard-camera/src/MediaDevices.ts for the normalizer.

internal struct GetUserMediaConstraints: Record {
  @Field
  var video: FlatVideoConstraints?

  @Field
  var audioRequested: Bool = false
}

internal struct FlatVideoConstraints: Record {
  @Field var deviceId: String?
  @Field var facingMode: String?
  @Field var width: Int?
  @Field var height: Int?
  @Field var frameRate: Double?
  @Field var aspectRatio: Double?
}

// MARK: - DOMException-shaped throws
// @ref LLP 0002#gum-error-mapping — error.name must match the spec; we encode
// the OverconstrainedError constraint into the message as "...: <name>" so the
// TS layer can parse it onto .constraint.

// Expo Modules Core SDK 56 surfaces `Exception(name:description:)` to JS as a
// plain `Error` with name "Error" — the spec name does not round-trip through
// `error.name` or `error.code`. We encode the spec name as a "[<Name>] "
// prefix on the description so the TS-side `rewrapNativeError` can recover
// it. Same trick already in use for OverconstrainedError's constraint name.
private func spec(_ name: String, _ description: String) -> Exception {
  Exception(name: name, description: "[\(name)] \(description)")
}

// @ref LLP 0008#error-notallowederror — user denied permission
private func notAllowed() -> Exception {
  spec("NotAllowedError", "Permission denied")
}

// @ref LLP 0008#error-notfounderror — no suitable device matching constraints
private func notFound() -> Exception {
  spec("NotFoundError", "Requested device not found")
}

// @ref LLP 0008#error-overconstrainederror — required constraint unsatisfiable;
//   carries the offending constraint name in the message for TS to parse onto .constraint.
private func overconstrained(_ constraint: String) -> Exception {
  spec("OverconstrainedError", "Constraint cannot be satisfied: \(constraint)")
}

// @ref LLP 0008#error-notreadableerror — hardware/system level capture failure
private func notReadable(_ underlying: Error) -> Exception {
  spec("NotReadableError", "Camera could not be opened: \(underlying.localizedDescription)")
}

// MARK: - Implementation
// @ref LLP 0008#dom-mediadevices-getusermedia — spec algorithm
// @ref LLP 0002 — our subset of the algorithm

internal func getUserMedia(constraints: GetUserMediaConstraints) async throws -> MediaStream {
  // @ref LLP 0002#gum-validate-constraints
  guard let videoConstraints = constraints.video else {
    if constraints.audioRequested {
      throw overconstrained("audio")
    }
    throw spec("TypeError", "At least one of audio and video must be requested")
  }

  // @ref LLP 0002#gum-request-permission
  let status = AVCaptureDevice.authorizationStatus(for: .video)
  switch status {
  case .authorized:
    break
  case .notDetermined:
    let granted = await AVCaptureDevice.requestAccess(for: .video)
    if !granted { throw notAllowed() }
  case .denied, .restricted:
    throw notAllowed()
  @unknown default:
    throw notAllowed()
  }

  // @ref LLP 0002#gum-pick-device
  let device = try pickDevice(constraints: videoConstraints)

  // @ref LLP 0002#gum-build-session — build session and add FrameSink atomically
  // so the data-output connection is available when the track is constructed.
  let frameSink = FrameSink()
  let (session, trackConnection, settings) = try await buildSession(
    device: device,
    constraints: videoConstraints,
    frameSink: frameSink
  )

  let source = CaptureSource(
    session: session,
    device: device,
    frameSink: frameSink,
    connection: trackConnection
  )

  let track = MediaStreamTrack(
    id: UUID().uuidString,
    kind: "video",
    label: device.localizedName,
    settings: settings,
    constraints: constraintsAsDictionary(videoConstraints),
    source: source
  )

  return MediaStream(id: UUID().uuidString, tracks: [track])
}

private func pickDevice(constraints: FlatVideoConstraints) throws -> AVCaptureDevice {
  if let deviceId = constraints.deviceId, !deviceId.isEmpty {
    if let device = AVCaptureDevice(uniqueID: deviceId) {
      return device
    }
    throw overconstrained("deviceId")
  }

  // @ref LLP 0002#gum-pick-device — default to back camera when no facingMode is
  // specified. Back is the better default for a "camera demo" surface.
  // If facingMode was explicitly requested and isn't one of the spec's "user" /
  // "environment" values, reject with OverconstrainedError — the JS normalizer
  // collapses `{exact: X}` into a flat scalar, so any explicit value is exact.
  let facingModeRequested = constraints.facingMode != nil
  let position: AVCaptureDevice.Position
  switch constraints.facingMode {
  case nil: position = .back
  case "user": position = .front
  case "environment": position = .back
  default: throw overconstrained("facingMode")
  }

  // Prefer the system's virtual auto-switching multi-lens devices when present
  // (Triple → DualWide → Dual), then fall back to the single wide-angle, then
  // ultra-wide / telephoto / TrueDepth. The discovery session returns them in
  // an undefined order, so we filter and pick by priority ourselves.
  let priorityTypes: [AVCaptureDevice.DeviceType] = [
    .builtInTripleCamera,
    .builtInDualWideCamera,
    .builtInDualCamera,
    .builtInWideAngleCamera,
    .builtInTrueDepthCamera,
    .builtInUltraWideCamera,
    .builtInTelephotoCamera,
    .builtInLiDARDepthCamera,
  ]
  let discovery = AVCaptureDevice.DiscoverySession(
    deviceTypes: priorityTypes,
    mediaType: .video,
    position: position
  )
  for type in priorityTypes {
    if let device = discovery.devices.first(where: { $0.deviceType == type }) {
      return device
    }
  }

  // @ref LLP 0002#gum-pick-device — If the caller explicitly asked for a
  // facingMode and we can't honor it, fail instead of silently substituting
  // the other camera. The JS-side normalizer collapses `{exact: ...}` and the
  // basic-constraint forms into the same flat string, so we treat any
  // explicit facingMode as a hard requirement.
  if facingModeRequested {
    throw overconstrained("facingMode")
  }

  // No explicit facingMode — fall back to whatever video device the system has.
  if let fallback = AVCaptureDevice.default(for: .video) {
    return fallback
  }
  throw notFound()
}

private func buildSession(
  device: AVCaptureDevice,
  constraints: FlatVideoConstraints,
  frameSink: FrameSink
) async throws -> (AVCaptureSession, AVCaptureConnection?, [String: Any]) {
  return try await withCheckedThrowingContinuation { continuation in
    MediaStream.sessionQueue.async {
      let session = AVCaptureSession()
      session.beginConfiguration()

      // Are we picking a specific device format, or letting AVCaptureSession
      // manage it via a preset? The two paths are mutually exclusive per the
      // AVCaptureSession docs — setting `sessionPreset` overrides any
      // `device.activeFormat` we picked, and setting `activeFormat` requires
      // `sessionPreset == .inputPriority` to opt out of session-managed
      // selection. Sequencing also matters: the device must be locked when we
      // write `activeFormat`, and that has to happen *after* the device is
      // added to the session, otherwise `addInput` re-applies the preset's
      // chosen format on top of our pick.
      let chosenFormat: (format: AVCaptureDevice.Format, frameRate: Double)? = {
        if constraints.width == nil && constraints.height == nil && constraints.frameRate == nil {
          return nil
        }
        return pickActiveFormat(device: device, constraints: constraints)
      }()

      if chosenFormat != nil {
        // .inputPriority — "the session does not change the active capture
        // device's settings." Required when we manage the active format below.
        session.sessionPreset = .inputPriority
      } else {
        let preset = pickPreset(width: constraints.width, height: constraints.height)
        if session.canSetSessionPreset(preset) {
          session.sessionPreset = preset
        }
      }

      let input: AVCaptureDeviceInput
      do {
        input = try AVCaptureDeviceInput(device: device)
      } catch {
        session.commitConfiguration()
        continuation.resume(throwing: notReadable(error))
        return
      }
      guard session.canAddInput(input) else {
        session.commitConfiguration()
        continuation.resume(throwing: notReadable(
          NSError(domain: "StandardCamera", code: -1,
                  userInfo: [NSLocalizedDescriptionKey: "Cannot add input"])
        ))
        return
      }
      session.addInput(input)

      // Now that the device is part of the session, write activeFormat under
      // the device lock. This is the only point at which the session won't
      // immediately overwrite us, because we're holding the device's
      // configuration lock and the session is in .inputPriority.
      if let chosen = chosenFormat {
        do {
          try device.lockForConfiguration()
          device.activeFormat = chosen.format
          let timescale = CMTimeScale(chosen.frameRate.rounded())
          device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: timescale)
          device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: timescale)
          device.unlockForConfiguration()
        } catch {
          // Lock failed — leave the session in .inputPriority with whatever
          // format the device defaulted to when added. Better than throwing,
          // because the stream still works at the device's default rate.
        }
      }

      // Add the FrameSink output inside the same configuration block so the
      // data-output connection comes up in one atomic transaction.
      if session.canAddOutput(frameSink.output) {
        session.addOutput(frameSink.output)
      }

      session.commitConfiguration()
      session.startRunning()

      let dims = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
      let width = Int(dims.width)
      let height = Int(dims.height)
      // Report the actually-configured frame rate (via the device's
      // `activeVideoMinFrameDuration`) rather than the format's max — the
      // settings dict must reflect what the consumer is going to observe.
      let configuredDuration = device.activeVideoMinFrameDuration
      let frameRate: Double = {
        if configuredDuration.isValid && configuredDuration.value > 0 {
          return Double(configuredDuration.timescale) / Double(configuredDuration.value)
        }
        return device.activeFormat.videoSupportedFrameRateRanges.first?.maxFrameRate ?? 30
      }()

      let settings: [String: Any] = [
        "deviceId": device.uniqueID,
        "groupId": device.uniqueID,
        "facingMode": positionToFacingMode(device.position),
        "width": width,
        "height": height,
        "frameRate": frameRate,
        "aspectRatio": Double(width) / Double(max(height, 1)),
        // We don't crop or scale; we always serve the camera's active-format
        // dimensions. WPT tests assert this string is present on
        // `track.getSettings()`.
        "resizeMode": "none",
      ]

      // Hand back the AVCaptureConnection from the input to the data output so
      // MediaStreamTrack.enabled can gate frame delivery to FrameSink.
      let trackConnection = frameSink.output.connection(with: .video)
      continuation.resume(returning: (session, trackConnection, settings))
    }
  }
}

private func pickPreset(width: Int?, height: Int?) -> AVCaptureSession.Preset {
  let target = max(width ?? 0, height ?? 0)
  if target >= 1080 { return .hd1920x1080 }
  if target >= 720 { return .hd1280x720 }
  if target >= 480 { return .vga640x480 }
  return .high
}

// @ref LLP 0002#gum-pick-device — Pick the device format whose dimensions and
// frame-rate range satisfy the caller's constraints. Iterates `device.formats`
// scoring (width, height, frameRate) against the request; the lowest score
// wins. Returns nil if no format covers the requested frame rate (so the
// caller falls back to the preset path).
private func pickActiveFormat(
  device: AVCaptureDevice,
  constraints: FlatVideoConstraints
) -> (format: AVCaptureDevice.Format, frameRate: Double)? {
  let targetWidth = constraints.width ?? 1280
  let targetHeight = constraints.height ?? 720
  let targetFrameRate = constraints.frameRate ?? 30

  var bestScore = Double.greatestFiniteMagnitude
  var bestFormat: AVCaptureDevice.Format?
  var bestRate: Double = targetFrameRate

  for format in device.formats {
    let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
    let width = Int(dims.width)
    let height = Int(dims.height)
    guard let range = format.videoSupportedFrameRateRanges.first(where: {
      targetFrameRate >= $0.minFrameRate && targetFrameRate <= $0.maxFrameRate
    }) ?? format.videoSupportedFrameRateRanges.max(by: { $0.maxFrameRate < $1.maxFrameRate }) else {
      continue
    }
    // Skip formats whose max frame rate is too low to satisfy the request.
    if range.maxFrameRate + 0.01 < targetFrameRate { continue }
    let deliverable = min(max(targetFrameRate, range.minFrameRate), range.maxFrameRate)
    let widthDiff = abs(Double(width - targetWidth))
    let heightDiff = abs(Double(height - targetHeight))
    let fpsDiff = abs(deliverable - targetFrameRate) * 100
    let score = widthDiff + heightDiff + fpsDiff
    if score < bestScore {
      bestScore = score
      bestFormat = format
      bestRate = deliverable
    }
  }

  guard let chosen = bestFormat else { return nil }
  return (chosen, bestRate)
}

private func positionToFacingMode(_ position: AVCaptureDevice.Position) -> String {
  switch position {
  case .front: return "user"
  case .back: return "environment"
  default: return "environment"
  }
}

private func constraintsAsDictionary(_ c: FlatVideoConstraints) -> [String: Any] {
  var dict: [String: Any] = [:]
  if let v = c.deviceId { dict["deviceId"] = v }
  if let v = c.facingMode { dict["facingMode"] = v }
  if let v = c.width { dict["width"] = v }
  if let v = c.height { dict["height"] = v }
  if let v = c.frameRate { dict["frameRate"] = v }
  if let v = c.aspectRatio { dict["aspectRatio"] = v }
  return dict
}
