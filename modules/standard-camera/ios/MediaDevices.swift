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

// @ref LLP 0008#error-notallowederror — user denied permission
private func notAllowed() -> Exception {
  Exception(name: "NotAllowedError", description: "Permission denied")
}

// @ref LLP 0008#error-notfounderror — no suitable device matching constraints
private func notFound() -> Exception {
  Exception(name: "NotFoundError", description: "Requested device not found")
}

// @ref LLP 0008#error-overconstrainederror — required constraint unsatisfiable;
//   carries the offending constraint name in the message for TS to parse onto .constraint.
private func overconstrained(_ constraint: String) -> Exception {
  Exception(name: "OverconstrainedError", description: "Constraint cannot be satisfied: \(constraint)")
}

// @ref LLP 0008#error-notreadableerror — hardware/system level capture failure
private func notReadable(_ underlying: Error) -> Exception {
  Exception(name: "NotReadableError", description: "Camera could not be opened: \(underlying.localizedDescription)")
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
    throw Exception(name: "TypeError", description: "At least one of audio and video must be requested")
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

  let track = MediaStreamTrack(
    id: UUID().uuidString,
    label: device.localizedName,
    settings: settings,
    constraints: constraintsAsDictionary(videoConstraints)
  )
  track.connection = trackConnection

  return MediaStream(id: UUID().uuidString, session: session, tracks: [track], frameSink: frameSink)
}

private func pickDevice(constraints: FlatVideoConstraints) throws -> AVCaptureDevice {
  if let deviceId = constraints.deviceId, !deviceId.isEmpty {
    if let device = AVCaptureDevice(uniqueID: deviceId) {
      return device
    }
    throw overconstrained("deviceId")
  }

  // @ref LLP 0002#gum-pick-device — default to back camera when no facingMode is
  // specified. AVCaptureDevice.DiscoverySession with .unspecified returns devices
  // in undefined order; back is the better default for a "camera demo" surface.
  let facingModeRequested = constraints.facingMode != nil
  let position: AVCaptureDevice.Position
  switch constraints.facingMode {
  case "user": position = .front
  case "environment": position = .back
  default: position = .back
  }

  let discovery = AVCaptureDevice.DiscoverySession(
    deviceTypes: [.builtInWideAngleCamera],
    mediaType: .video,
    position: position
  )

  if let device = discovery.devices.first {
    return device
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

      let preset = pickPreset(width: constraints.width, height: constraints.height)
      if session.canSetSessionPreset(preset) {
        session.sessionPreset = preset
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
      let frameRate = device.activeFormat.videoSupportedFrameRateRanges.first?.maxFrameRate ?? 30

      let settings: [String: Any] = [
        "deviceId": device.uniqueID,
        "groupId": device.uniqueID,
        "facingMode": positionToFacingMode(device.position),
        "width": width,
        "height": height,
        "frameRate": frameRate,
        "aspectRatio": Double(width) / Double(max(height, 1))
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
