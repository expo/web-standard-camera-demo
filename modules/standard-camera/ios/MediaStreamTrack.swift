import AVFoundation
import ExpoModulesCore

// @ref LLP 0008#dom-mediastreamtrack — Upstream spec text
// @ref LLP 0003#track-* — MediaStreamTrack subset; native state container
// @ref LLP 0005#architecture — SharedObject holds metadata; the AVCaptureSession
//                                lives on a CaptureSource (strong-referenced here).

internal final class MediaStreamTrack: SharedObject {
  let id: String
  let kind: String
  // @ref LLP 0008#dom-mediastreamtrack-label — set at construction, never changes.
  // The spec defines [[Label]] as initialized to the source's label and contains
  // no normative requirement that it changes when readyState transitions to "ended".
  let label: String
  let settings: [String: Any]
  let constraints: [String: Any]

  // @ref LLP 0003#track-clone — Strong ref so cloning a track keeps the
  // underlying camera session alive across stream lifetimes. Optional so
  // tests / shared-object lifecycle can clear it after stop.
  private(set) var source: CaptureSource?

  // @ref LLP 0008#dom-mediastreamtrack-enabled — spec attribute
  // @ref LLP 0003#track-enabled
  var enabled: Bool = true {
    didSet {
      // The data-output connection controls whether frames / audio samples
      // flow into the sink (and any future MediaRecorder-style consumers).
      // The AVCaptureVideoPreviewLayer has its own internal connection that
      // we don't toggle here, so disabling a video track freezes downstream
      // consumers but leaves the on-screen preview showing the most recent
      // frame. Clones share the connection with the original — documented
      // divergence in LLP 0003#track-clone.
      // @ref LLP 0009#audio-build-session — audio uses its own connection.
      if kind == "audio" {
        source?.audioConnection?.isEnabled = enabled
      } else {
        source?.videoConnection?.isEnabled = enabled
      }
    }
  }

  // @ref LLP 0008#dom-mediastreamtrack-muted — spec attribute
  // @ref LLP 0003#track-muted — Reflects AVCaptureSession interruption state.
  private(set) var muted: Bool = false

  // @ref LLP 0008#dom-mediastreamtrack-readystate — spec attribute
  // @ref LLP 0003#track-readyState — "live" until stop() or runtime error.
  private(set) var readyState: String = "live"

  init(
    id: String,
    kind: String,
    label: String,
    settings: [String: Any],
    constraints: [String: Any],
    source: CaptureSource?
  ) {
    self.id = id
    self.kind = kind
    self.label = label
    self.settings = settings
    self.constraints = constraints
    self.source = source
    super.init()
    source?.registerTrack(self)
  }

  deinit {
    // If JS GC'd this handle while still live, the refcount needs to be
    // released so the camera shuts down promptly.
    if readyState == "live" {
      readyState = "ended"
      source?.unregisterTrack(self)
    }
  }

  // @ref LLP 0008#dom-mediastreamtrack-stop — spec algorithm
  // @ref LLP 0003#track-stop — Synchronous readyState change; async "ended" event.
  // Per spec step 3, "notify track's source that track is ended"; CaptureSource
  // owns the refcount and stops the AVCaptureSession when this is the last live
  // track. Per step 4 / spec ordering, we set readyState before firing `ended`.
  func stop() {
    if readyState == "ended" {
      return
    }
    readyState = "ended"
    source?.unregisterTrack(self)
    emit(event: "ended")
  }

  // @ref LLP 0008#dom-mediastreamtrack-clone — spec algorithm
  // @ref LLP 0003#track-clone — new id, shares source, fresh enabled/muted/readyState.
  // Named `cloneTrack` (not `clone`) so we don't shadow Swift's NSObject.clone
  // when bridging via Expo Modules. The module exposes this as `clone` on the JS side.
  func cloneTrack() -> MediaStreamTrack {
    let clone = MediaStreamTrack(
      id: UUID().uuidString,
      kind: kind,
      label: label,
      settings: settings,
      constraints: constraints,
      source: source
    )
    if readyState == "ended" {
      // A clone of an ended track is born ended: the spec leaves this
      // ambiguous, but observed browser behavior is that the clone inherits
      // the source-stopped state when there is no live consumer.
      clone.readyState = "ended"
      clone.source?.unregisterTrack(clone)
    }
    return clone
  }

  // @ref LLP 0008#dom-mediastreamtrack-mute-algorithm — spec algorithm
  // @ref LLP 0003#track-events — mute/unmute fire as a separate task.
  func setMuted(_ value: Bool) {
    if muted == value || readyState == "ended" {
      return
    }
    muted = value
    emit(event: value ? "mute" : "unmute")
  }

  // @ref LLP 0008#dom-mediastreamtrack-getcapabilities — Reports the
  // capabilities of the underlying AVCaptureDevice. For video tracks we
  // expose the spec-required fields, ranges derived from the device's
  // supported formats / frame-rate ranges where applicable. For audio
  // tracks we report the spec-required fields from LLP 0008#audio-properties.
  func capabilities() -> [String: Any] {
    if kind == "audio" {
      return audioCapabilities()
    }
    return videoCapabilities()
  }

  private func videoCapabilities() -> [String: Any] {
    guard let device = source?.device else {
      // Capabilities for a track without a backing device are minimal.
      return ["deviceId": "", "groupId": ""]
    }

    // width / height / aspectRatio ranges: derive from all supported formats.
    var minWidth = Int.max, maxWidth = 0
    var minHeight = Int.max, maxHeight = 0
    var minFps = Float64.greatestFiniteMagnitude, maxFps: Float64 = 0
    for format in device.formats {
      let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
      let w = Int(dims.width), h = Int(dims.height)
      if w > 0 { minWidth = min(minWidth, w); maxWidth = max(maxWidth, w) }
      if h > 0 { minHeight = min(minHeight, h); maxHeight = max(maxHeight, h) }
      for range in format.videoSupportedFrameRateRanges {
        minFps = min(minFps, range.minFrameRate)
        maxFps = max(maxFps, range.maxFrameRate)
      }
    }
    if maxWidth == 0 { minWidth = 0 }
    if maxHeight == 0 { minHeight = 0 }
    if maxFps == 0 { minFps = 0 }

    let minAspect = maxHeight > 0 ? Double(minWidth) / Double(maxHeight) : 0
    let maxAspect = minHeight > 0 ? Double(maxWidth) / Double(minHeight) : 0

    let facing: String
    switch device.position {
    case .front: facing = "user"
    case .back: facing = "environment"
    default: facing = "environment"
    }

    return [
      "width": ["min": minWidth, "max": maxWidth],
      "height": ["min": minHeight, "max": maxHeight],
      "aspectRatio": ["min": minAspect, "max": maxAspect],
      "frameRate": ["min": minFps, "max": maxFps],
      "facingMode": [facing],
      // We don't support cropping; report 'none' only.
      "resizeMode": ["none"],
      "deviceId": device.uniqueID,
      "groupId": device.uniqueID,
    ]
  }

  // @ref LLP 0009#audio-track-capabilities — Audio capability shape.
  private func audioCapabilities() -> [String: Any] {
    let device = source?.audioDevice
    let avs = AVAudioSession.sharedInstance()
    let inputLatency = avs.inputLatency
    let inputChannels = max(1, avs.inputNumberOfChannels)
    return [
      "sampleRate": ["min": 8000, "max": 96000],
      "sampleSize": ["min": 16, "max": 16],
      "echoCancellation": [true, false],
      "autoGainControl": [true, false],
      "noiseSuppression": [true, false],
      "voiceIsolation": [true, false],
      "latency": ["min": inputLatency, "max": inputLatency],
      "channelCount": ["min": 1, "max": inputChannels],
      "deviceId": audioDeviceIdFor(device),
      "groupId": audioDeviceIdFor(device),
    ]
  }

  // @ref LLP 0009#audio-pick-device — Stable id for an audio device even when
  // iOS reports an empty `uniqueID` (the simulator's audio device sometimes does).
  private func audioDeviceIdFor(_ device: AVCaptureDevice?) -> String {
    guard let device else { return "" }
    return device.uniqueID.isEmpty ? "default-audio-input" : device.uniqueID
  }

  // Internal accessor consumed by the JS-side `ImageCapture` polyfill. The
  // W3C Image Capture spec puts grabFrame on `ImageCapture`, not on
  // `MediaStreamTrack`, so we don't add it to the public track surface. The
  // returned `data` is a tight-packed `width * height * 4` BGRA buffer
  // suitable for `device.queue.writeTexture` into a `bgra8unorm` texture.
  // This is the pixel-copy v1 of the camera → WebGPU bridge; the zero-copy
  // SharedTextureMemory path is reserved for [[LLP 0011]] once
  // react-native-wgpu exposes `importSharedTextureMemory`.
  func getLatestFrame() -> [String: Any]? {
    if kind != "video" || readyState == "ended" {
      return nil
    }
    guard let frameSink = source?.frameSink,
          let latest = frameSink.copyLatestPixelBuffer() else {
      return nil
    }
    let pb = latest.pixelBuffer
    let width = latest.width
    let height = latest.height

    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }

    guard let baseAddress = CVPixelBufferGetBaseAddress(pb) else {
      return nil
    }
    let srcRowBytes = CVPixelBufferGetBytesPerRow(pb)
    let dstRowBytes = width * 4
    var data = Data(count: dstRowBytes * height)
    data.withUnsafeMutableBytes { dst in
      guard let dstPtr = dst.baseAddress else { return }
      // Tight-pack: copy row by row so any IOSurface stride padding is dropped.
      for y in 0..<height {
        let srcRow = baseAddress.advanced(by: y * srcRowBytes)
        let dstRow = dstPtr.advanced(by: y * dstRowBytes)
        memcpy(dstRow, srcRow, dstRowBytes)
      }
    }

    return [
      "width": width,
      "height": height,
      "data": data,
      "format": "bgra8unorm",
      "frameNumber": latest.frameNumber,
    ]
  }

  // Audio analog of getLatestFrame() — snapshots the most-recent `maxFrames`
  // frames (one frame = one sample per channel) of interleaved Float32 LPCM
  // from the AudioSink's rolling buffer. The same accessor is intended to
  // back MediaRecorder, a future Web Audio bridge, and audio-level meters.
  // The disabled-audio test uses only the `frameNumber` to detect "samples
  // stopped arriving" without inspecting values; future consumers will pull
  // `samples` directly. Returns nil if no audio samples have arrived yet.
  func getLatestAudioBuffer(maxFrames: Int) -> [String: Any]? {
    if kind != "audio" || readyState == "ended" {
      return nil
    }
    guard let audioSink = source?.audioSink else {
      return nil
    }
    let snap = audioSink.copyLatestSamples(maxFrames: maxFrames)
    let data = snap.samples.withUnsafeBufferPointer { Data(buffer: $0) }
    return [
      "samples": data,
      "sampleRate": snap.sampleRate,
      "channelCount": snap.channelCount,
      "frameNumber": snap.frameNumber,
    ]
  }

  // Called by CaptureSource when an AVCaptureSession runtime error fires.
  // @ref LLP 0008#event-mediastreamtrack-ended — non-stop() termination path.
  func endByRuntimeError() {
    if readyState == "ended" {
      return
    }
    readyState = "ended"
    source?.unregisterTrack(self)
    emit(event: "ended")
  }
}
