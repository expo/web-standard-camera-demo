import AVFoundation
import ExpoModulesCore

// @ref LLP 0003 — getUserMedia subset
// The TypeScript layer flattens spec-shaped constraints (which may be boolean or
// ConstrainDOMString objects) into the simple optionals below before calling
// native. See modules/standard-camera/src/MediaDevices.ts for the normalizer.

internal struct GetUserMediaConstraints: Record {
  @Field
  var video: FlatVideoConstraints?

  @Field
  var audio: FlatAudioConstraints?
}

internal struct FlatVideoConstraints: Record {
  @Field var deviceId: String?
  @Field var facingMode: String?
  @Field var width: Int?
  @Field var height: Int?
  @Field var frameRate: Double?
  @Field var aspectRatio: Double?
  // @ref LLP 0001#video-properties — One of `"none"` / `"crop-and-scale"`.
  // JS-side `flattenVideo` already rejects any other `{exact}` value with
  // OverconstrainedError; native trusts the value here. When
  // `"crop-and-scale"` is set together with `width` / `height`, FrameSink
  // applies a center-crop + bilinear rescale (see LLP 0002's
  // "`resizeMode: \"crop-and-scale\"` is in scope" callout).
  @Field var resizeMode: String?
}

// @ref LLP 0008#audio-build-session — Flat audio constraints from JS. The
// spec's `echoCancellation` is `boolean | "all" | "remote-only"`; we split it
// into two fields at the bridge so the Record can stay strongly typed.
// `echoCancellationMode` is set only when the caller supplies the enum string.
internal struct FlatAudioConstraints: Record {
  @Field var deviceId: String?
  @Field var groupId: String?
  @Field var sampleRate: Double?
  @Field var sampleSize: Int?
  @Field var channelCount: Int?
  @Field var latency: Double?
  @Field var echoCancellation: Bool?
  @Field var echoCancellationMode: String?
  @Field var autoGainControl: Bool?
  @Field var noiseSuppression: Bool?
  @Field var voiceIsolation: Bool?
}

// MARK: - DOMException-shaped throws
// @ref LLP 0003#gum-error-mapping — error.name must match the spec; we encode
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

// @ref LLP 0001#error-notallowederror — user denied permission
private func notAllowed() -> Exception {
  spec("NotAllowedError", "Permission denied")
}

// @ref LLP 0001#error-notfounderror — no suitable device matching constraints
private func notFound() -> Exception {
  spec("NotFoundError", "Requested device not found")
}

// @ref LLP 0001#error-overconstrainederror — required constraint unsatisfiable;
//   carries the offending constraint name in the message for TS to parse onto .constraint.
private func overconstrained(_ constraint: String) -> Exception {
  spec("OverconstrainedError", "Constraint cannot be satisfied: \(constraint)")
}

// @ref LLP 0001#error-notreadableerror — hardware/system level capture failure
private func notReadable(_ underlying: Error) -> Exception {
  spec("NotReadableError", "Camera could not be opened: \(underlying.localizedDescription)")
}

// MARK: - Implementation
// @ref LLP 0001#dom-mediadevices-getusermedia — spec algorithm
// @ref LLP 0003 — our subset of the algorithm
// @ref LLP 0008 — audio implementation

internal func getUserMedia(constraints: GetUserMediaConstraints) async throws -> MediaStream {
  let gumStartedAt = CFAbsoluteTimeGetCurrent()
  standardCameraTrace("native-gum-start", [
    "audio": constraints.audio != nil,
    "facingMode": constraints.video?.facingMode,
    "frameRate": constraints.video?.frameRate,
    "height": constraints.video?.height,
    "video": constraints.video != nil,
    "width": constraints.video?.width
  ])
  // @ref LLP 0003#gum-validate-constraints — at least one of audio/video required
  let videoConstraints = constraints.video
  let audioConstraints = constraints.audio
  if videoConstraints == nil && audioConstraints == nil {
    throw spec("TypeError", "At least one of audio and video must be requested")
  }

  // @ref LLP 0003#gum-request-permission — request for each requested type
  if videoConstraints != nil {
    try await requestPermission(for: .video)
  }
  if audioConstraints != nil {
    try await requestPermission(for: .audio)
  }

  // @ref LLP 0008#audio-pick-device
  let videoDevice = try videoConstraints.map { try pickDevice(constraints: $0) }
  let audioDevice = try audioConstraints.map { try pickAudioDevice(constraints: $0) }

  // @ref LLP 0003#gum-build-session, LLP 0008#audio-build-session — build the
  // shared session and attach inputs/outputs atomically.
  let frameSink = videoDevice != nil ? FrameSink() : nil
  let audioSink = audioDevice != nil ? AudioSink() : nil
  let buildResult = try await buildCaptureSession(
    videoDevice: videoDevice,
    videoConstraints: videoConstraints,
    frameSink: frameSink,
    audioDevice: audioDevice,
    audioConstraints: audioConstraints,
    audioSink: audioSink
  )

  let source = CaptureSource(
    session: buildResult.session,
    device: videoDevice,
    audioDevice: audioDevice,
    frameSink: frameSink,
    audioSink: audioSink,
    videoConnection: buildResult.videoConnection,
    audioConnection: buildResult.audioConnection
  )

  var tracks: [MediaStreamTrack] = []
  if let videoDevice {
    tracks.append(MediaStreamTrack(
      id: UUID().uuidString,
      kind: "video",
      label: videoDevice.localizedName,
      settings: buildResult.videoSettings ?? [:],
      constraints: videoConstraints.map { constraintsAsDictionary($0) } ?? [:],
      source: source
    ))
  }
  if let audioDevice {
    tracks.append(MediaStreamTrack(
      id: UUID().uuidString,
      kind: "audio",
      label: audioDevice.localizedName,
      settings: buildResult.audioSettings ?? [:],
      constraints: audioConstraints.map { audioConstraintsAsDictionary($0) } ?? [:],
      source: source
    ))
  }

  let stream = MediaStream(id: UUID().uuidString, tracks: tracks)
  source.startSessionIfNeeded(reason: "getUserMedia", streamId: stream.id)
  standardCameraTrace("native-gum-done", [
    "durationMs": (CFAbsoluteTimeGetCurrent() - gumStartedAt) * 1000,
    "tracks": tracks.count,
    "videoDevice": videoDevice?.localizedName
  ])
  return stream
}

// @ref LLP 0003#gum-request-permission — per-mediaType permission gate.
private func requestPermission(for mediaType: AVMediaType) async throws {
  let status = AVCaptureDevice.authorizationStatus(for: mediaType)
  switch status {
  case .authorized:
    return
  case .notDetermined:
    let granted = await AVCaptureDevice.requestAccess(for: mediaType)
    if !granted { throw notAllowed() }
  case .denied, .restricted:
    throw notAllowed()
  @unknown default:
    throw notAllowed()
  }
}

// @ref LLP 0008#audio-pick-device — Single audio device per call. Honors
// `deviceId` and `groupId` separately so an unsatisfied `groupId` rejects
// with the matching `OverconstrainedError(constraint: "groupId")`.
private func pickAudioDevice(constraints: FlatAudioConstraints) throws -> AVCaptureDevice {
  if let deviceId = constraints.deviceId, !deviceId.isEmpty {
    if let device = AVCaptureDevice(uniqueID: deviceId), device.hasMediaType(.audio) {
      return device
    }
    throw overconstrained("deviceId")
  }
  if let groupId = constraints.groupId {
    if !groupId.isEmpty {
      if let device = AVCaptureDevice(uniqueID: groupId), device.hasMediaType(.audio) {
        return device
      }
      // Also accept the synthetic id we report when iOS hands back an empty
      // uniqueID — see `audioDeviceIdFor` / `enumerateDevicesAsync`.
      if groupId == "default-audio-input", let fallback = AVCaptureDevice.default(for: .audio) {
        return fallback
      }
    }
    // Empty-string or unrecognized groupId — no audio device matches.
    throw overconstrained("groupId")
  }
  if let device = AVCaptureDevice.default(for: .audio) {
    return device
  }
  throw notFound()
}

private func pickDevice(constraints: FlatVideoConstraints) throws -> AVCaptureDevice {
  if let deviceId = constraints.deviceId, !deviceId.isEmpty {
    if let device = AVCaptureDevice(uniqueID: deviceId) {
      return device
    }
    throw overconstrained("deviceId")
  }

  // @ref LLP 0003#gum-pick-device — default to back camera when no facingMode is
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

  // @ref LLP 0003#gum-pick-device — If the caller explicitly asked for a
  // facingMode and we can't honor it, fail instead of silently substituting
  // the other camera. The JS-side normalizer collapses `{exact: ...}` and the
  // basic-constraint forms into the same flat string, so we treat any
  // explicit facingMode as a hard requirement.
  //
  // Distinguish the two cases:
  //   - There are video devices on this system, just none matching the
  //     requested facingMode → `OverconstrainedError(facingMode)`.
  //   - There are no video devices at all (the typical iOS simulator) →
  //     `NotFoundError`. This lets the WPT runner mark the test as
  //     `environment-skip` rather than reporting it as a regression
  //     (see [LLP 0010#harness-surface](./0010-in-app-wpt-runner.guide.md)).
  let hasAnyVideoDevice = AVCaptureDevice.default(for: .video) != nil
  if facingModeRequested {
    if hasAnyVideoDevice {
      throw overconstrained("facingMode")
    }
    throw notFound()
  }

  // No explicit facingMode — fall back to whatever video device the system has.
  if let fallback = AVCaptureDevice.default(for: .video) {
    return fallback
  }
  throw notFound()
}

internal struct SessionBuildResult {
  let session: AVCaptureSession
  let videoConnection: AVCaptureConnection?
  let videoSettings: [String: Any]?
  let audioConnection: AVCaptureConnection?
  let audioSettings: [String: Any]?
}

// @ref LLP 0003#gum-build-session, LLP 0008#audio-build-session — atomic
// build of an AVCaptureSession containing zero/one video input + sink and
// zero/one audio input + sink. Combined audio + video calls share this
// session so the lifecycle is naturally coordinated.
private func buildCaptureSession(
  videoDevice: AVCaptureDevice?,
  videoConstraints: FlatVideoConstraints?,
  frameSink: FrameSink?,
  audioDevice: AVCaptureDevice?,
  audioConstraints: FlatAudioConstraints?,
  audioSink: AudioSink?
) async throws -> SessionBuildResult {
  return try await withCheckedThrowingContinuation { continuation in
    MediaStream.sessionQueue.async {
      // @ref LLP 0008#audio-session-configuration — Configure AVAudioSession
      // before the AVCaptureSession is started so the audio chain is ready.
      if audioDevice != nil {
        do {
          try configureAudioSession(constraints: audioConstraints)
        } catch {
          continuation.resume(throwing: notReadable(error))
          return
        }
      }

      let session = AVCaptureSession()
      session.beginConfiguration()

      // === Video path ===========================================================
      // Are we picking a specific device format, or letting AVCaptureSession
      // manage it via a preset? The two paths are mutually exclusive per the
      // AVCaptureSession docs — setting `sessionPreset` overrides any
      // `device.activeFormat` we picked, and setting `activeFormat` requires
      // `sessionPreset == .inputPriority` to opt out of session-managed
      // selection. Sequencing also matters: the device must be locked when we
      // write `activeFormat`, and that has to happen *after* the device is
      // added to the session, otherwise `addInput` re-applies the preset's
      // chosen format on top of our pick.
      var videoSettings: [String: Any]? = nil
      var videoConnection: AVCaptureConnection? = nil

      if let videoDevice, let videoConstraints, let frameSink {
        let chosenFormat: (format: AVCaptureDevice.Format, frameRate: Double)? = {
          if videoConstraints.width == nil && videoConstraints.height == nil && videoConstraints.frameRate == nil {
            return nil
          }
          return pickActiveFormat(device: videoDevice, constraints: videoConstraints)
        }()

        if chosenFormat != nil {
          session.sessionPreset = .inputPriority
        } else {
          let preset = pickPreset(width: videoConstraints.width, height: videoConstraints.height)
          if session.canSetSessionPreset(preset) {
            session.sessionPreset = preset
          }
        }

        let input: AVCaptureDeviceInput
        do {
          input = try AVCaptureDeviceInput(device: videoDevice)
        } catch {
          session.commitConfiguration()
          continuation.resume(throwing: notReadable(error))
          return
        }
        guard session.canAddInput(input) else {
          session.commitConfiguration()
          continuation.resume(throwing: notReadable(
            NSError(domain: "StandardCamera", code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Cannot add video input"])
          ))
          return
        }
        session.addInput(input)

        if let chosen = chosenFormat {
          do {
            try videoDevice.lockForConfiguration()
            videoDevice.activeFormat = chosen.format
            let timescale = CMTimeScale(chosen.frameRate.rounded())
            videoDevice.activeVideoMinFrameDuration = CMTime(value: 1, timescale: timescale)
            videoDevice.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: timescale)
            videoDevice.unlockForConfiguration()
          } catch {
            // Lock failed — keep .inputPriority with the device default.
          }
        }

        if session.canAddOutput(frameSink.output) {
          session.addOutput(frameSink.output)
        }

        let nativeDims = CMVideoFormatDescriptionGetDimensions(videoDevice.activeFormat.formatDescription)
        let nativeWidth = Int(nativeDims.width)
        let nativeHeight = Int(nativeDims.height)
        let configuredDuration = videoDevice.activeVideoMinFrameDuration
        let frameRate: Double = {
          if configuredDuration.isValid && configuredDuration.value > 0 {
            return Double(configuredDuration.timescale) / Double(configuredDuration.value)
          }
          return videoDevice.activeFormat.videoSupportedFrameRateRanges.first?.maxFrameRate ?? 30
        }()

        // @ref LLP 0001#video-properties — Resolve the actual `resizeMode`
        // and the target dimensions the source will deliver. The default
        // when the caller didn't specify `resizeMode` is `'crop-and-scale'`,
        // matching how desktop browsers honour `width` / `height` ideals
        // (the WPT `GUM-required-constraint-with-ideal-value` test asserts
        // the picked width equals the ideal, which on iPhone is only
        // reachable by cropping down from the closest native format).
        // `resizeMode: 'none'` is an explicit opt-out — when set, the
        // session runs at the native format and `getSettings()` reports
        // the device-native dimensions, even if `width` / `height` are
        // also constrained.
        let requestedResizeMode = videoConstraints.resizeMode
        let cropTarget: (width: Int, height: Int)? = {
          guard requestedResizeMode != "none" else { return nil }
          if videoConstraints.width == nil && videoConstraints.height == nil { return nil }
          return computeCropTarget(
            sourceWidth: nativeWidth,
            sourceHeight: nativeHeight,
            requestedWidth: videoConstraints.width,
            requestedHeight: videoConstraints.height,
            requestedAspectRatio: videoConstraints.aspectRatio
          )
        }()
        let actualResizeMode = cropTarget != nil ? "crop-and-scale" : (requestedResizeMode ?? "none")
        let outWidth = cropTarget?.width ?? nativeWidth
        let outHeight = cropTarget?.height ?? nativeHeight
        if let cropTarget {
          frameSink.setCropTargetSize(CGSize(width: cropTarget.width, height: cropTarget.height))
        } else {
          frameSink.setCropTargetSize(nil)
        }

        videoSettings = [
          "deviceId": videoDevice.uniqueID,
          "groupId": videoDevice.uniqueID,
          "facingMode": positionToFacingMode(videoDevice.position),
          "width": outWidth,
          "height": outHeight,
          "frameRate": frameRate,
          "aspectRatio": Double(outWidth) / Double(max(outHeight, 1)),
          "resizeMode": actualResizeMode,
        ]
        videoConnection = frameSink.output.connection(with: .video)
      }

      // === Audio path ===========================================================
      // @ref LLP 0008#audio-build-session — Add audio input/output inside the
      // same configuration block as the video side. Connections come up
      // together when we commit.
      var audioSettings: [String: Any]? = nil
      var audioConnection: AVCaptureConnection? = nil
      if let audioDevice, let audioSink {
        let audioInput: AVCaptureDeviceInput
        do {
          audioInput = try AVCaptureDeviceInput(device: audioDevice)
        } catch {
          session.commitConfiguration()
          continuation.resume(throwing: notReadable(error))
          return
        }
        guard session.canAddInput(audioInput) else {
          session.commitConfiguration()
          continuation.resume(throwing: notReadable(
            NSError(domain: "StandardCamera", code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Cannot add audio input"])
          ))
          return
        }
        session.addInput(audioInput)

        if session.canAddOutput(audioSink.output) {
          session.addOutput(audioSink.output)
        }
        audioConnection = audioSink.output.connection(with: .audio)

        // Snapshot the audio settings from the actual AVAudioSession state.
        // @ref LLP 0008#audio-track-settings
        let avs = AVAudioSession.sharedInstance()
        audioSettings = makeAudioSettings(
          device: audioDevice,
          session: avs,
          requested: audioConstraints
        )
      }

      session.commitConfiguration()

      continuation.resume(returning: SessionBuildResult(
        session: session,
        videoConnection: videoConnection,
        videoSettings: videoSettings,
        audioConnection: audioConnection,
        audioSettings: audioSettings
      ))
    }
  }
}

// @ref LLP 0008#audio-session-configuration — Set category/mode/active.
private func configureAudioSession(constraints: FlatAudioConstraints?) throws {
  let session = AVAudioSession.sharedInstance()
  try session.setCategory(.playAndRecord, options: [.defaultToSpeaker, .allowBluetooth])

  // Determine echoCancellation. Either Bool or String enum forms map to
  // .voiceChat (on) or .default (off).
  let echoOn: Bool = {
    if let mode = constraints?.echoCancellationMode, !mode.isEmpty {
      return true
    }
    return constraints?.echoCancellation ?? false
  }()
  try session.setMode(echoOn ? .voiceChat : .default)
  try session.setActive(true, options: [])
}

// @ref LLP 0008#audio-track-settings — Snapshot for `track.getSettings()`.
private func makeAudioSettings(
  device: AVCaptureDevice,
  session: AVAudioSession,
  requested: FlatAudioConstraints?
) -> [String: Any] {
  // Echo the caller-supplied echoCancellation value back verbatim per spec.
  // If the caller didn't supply one, report whatever the session ended up in.
  let echoValue: Any = {
    if let mode = requested?.echoCancellationMode, !mode.isEmpty {
      return mode
    }
    if let b = requested?.echoCancellation {
      return b
    }
    return session.mode == .voiceChat
  }()
  let echoOn: Bool = {
    if requested?.echoCancellationMode != nil && requested?.echoCancellationMode?.isEmpty == false {
      return true
    }
    if let b = requested?.echoCancellation { return b }
    return session.mode == .voiceChat
  }()

  // Same synthetic-id fallback as in enumerateDevicesAsync — iOS simulators
  // sometimes return empty strings for the audio device's uniqueID.
  let deviceId = device.uniqueID.isEmpty ? "default-audio-input" : device.uniqueID
  return [
    "deviceId": deviceId,
    "groupId": deviceId,
    "sampleRate": session.sampleRate,
    // The spec's `sampleSize` is an integer hint about captured representation.
    // iOS delivers Float32 PCM internally, but Chrome / Safari macOS report 16
    // here so callers compare a familiar baseline.
    "sampleSize": 16,
    "echoCancellation": echoValue,
    // iOS bundles AGC / NS / voice isolation under voice-chat mode; we report
    // them in lockstep with `echoCancellation`'s effective state.
    "autoGainControl": requested?.autoGainControl ?? echoOn,
    "noiseSuppression": requested?.noiseSuppression ?? echoOn,
    "voiceIsolation": requested?.voiceIsolation ?? echoOn,
    "latency": session.inputLatency,
    "channelCount": max(1, requested?.channelCount ?? session.inputNumberOfChannels),
  ]
}

private func pickPreset(width: Int?, height: Int?) -> AVCaptureSession.Preset {
  let target = max(width ?? 0, height ?? 0)
  if target >= 1080 { return .hd1920x1080 }
  if target >= 720 { return .hd1280x720 }
  if target >= 480 { return .vga640x480 }
  return .high
}

// @ref LLP 0003#gum-pick-device — Pick the device format whose dimensions and
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

// @ref LLP 0001#video-properties — Resolve the target output dimensions
// for a `resizeMode: "crop-and-scale"` request. Constraints come in as
// flat scalars (basic / ideal / max collapsed by `flattenVideo` on the JS
// side), so we honor whichever of `width` / `height` / `aspectRatio` the
// caller specified and fill in the rest from the source. Capped at the
// source dimensions to keep the path strictly down-scale (we never upscale
// past the device's native frame). Returns nil when the resolved target
// matches the source exactly — no point opting into the crop+scale stage
// if nothing changes.
private func computeCropTarget(
  sourceWidth: Int,
  sourceHeight: Int,
  requestedWidth: Int?,
  requestedHeight: Int?,
  requestedAspectRatio: Double?
) -> (width: Int, height: Int)? {
  guard sourceWidth > 0, sourceHeight > 0 else { return nil }
  let sourceAspect = Double(sourceWidth) / Double(sourceHeight)
  let aspect: Double = {
    if let r = requestedAspectRatio, r > 0 { return r }
    if let w = requestedWidth, let h = requestedHeight, w > 0, h > 0 {
      return Double(w) / Double(h)
    }
    return sourceAspect
  }()
  var w = requestedWidth.map { min($0, sourceWidth) } ?? 0
  var h = requestedHeight.map { min($0, sourceHeight) } ?? 0
  if w == 0 && h == 0 {
    return nil
  }
  if w == 0 { w = max(1, Int((Double(h) * aspect).rounded())) }
  if h == 0 { h = max(1, Int((Double(w) / aspect).rounded())) }
  w = min(w, sourceWidth)
  h = min(h, sourceHeight)
  if w == sourceWidth && h == sourceHeight { return nil }
  return (w, h)
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

// @ref LLP 0008#audio-build-session — Round-trip the caller's audio
// constraints into the track's getConstraints() output.
private func audioConstraintsAsDictionary(_ c: FlatAudioConstraints) -> [String: Any] {
  var dict: [String: Any] = [:]
  if let v = c.deviceId { dict["deviceId"] = v }
  if let v = c.groupId { dict["groupId"] = v }
  if let v = c.sampleRate { dict["sampleRate"] = v }
  if let v = c.sampleSize { dict["sampleSize"] = v }
  if let v = c.channelCount { dict["channelCount"] = v }
  if let v = c.latency { dict["latency"] = v }
  // Reassemble the spec's boolean | "all" | "remote-only" shape we split at
  // the bridge — see FlatAudioConstraints above.
  if let mode = c.echoCancellationMode, !mode.isEmpty {
    dict["echoCancellation"] = mode
  } else if let b = c.echoCancellation {
    dict["echoCancellation"] = b
  }
  if let v = c.autoGainControl { dict["autoGainControl"] = v }
  if let v = c.noiseSuppression { dict["noiseSuppression"] = v }
  if let v = c.voiceIsolation { dict["voiceIsolation"] = v }
  return dict
}
