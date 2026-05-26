import AVFoundation

// @ref LLP 0003#stream-clone — Reference-counted holder of the AVCaptureSession
// @ref LLP 0003#track-clone — Cloned tracks share a CaptureSource and keep the
//                              camera open as long as at least one track is live.
// @ref LLP 0005#architecture — This class is the AVFoundation realization of
//                               the spec's [[Source]] concept.
// @ref LLP 0009 — Audio capture shares the same CaptureSource; the audio
//                 connection and AVAudioSession-interruption observer live here.

internal final class CaptureSource {
  let session: AVCaptureSession
  let device: AVCaptureDevice?
  let audioDevice: AVCaptureDevice?
  let frameSink: FrameSink?
  let audioSink: AudioSink?

  // The AVCaptureConnection between the video device input and the FrameSink
  // video data output. Video track.enabled = false flips this connection.
  weak var videoConnection: AVCaptureConnection?
  // The AVCaptureConnection between the audio device input and the AudioSink
  // audio data output. Audio track.enabled = false flips this connection.
  weak var audioConnection: AVCaptureConnection?

  // Notification observers — closure-based so we don't need to be NSObject.
  // Per LLP 0003#stream-events, AVCaptureSession interruption / runtime errors
  // surface on the session, so observers live here. The source fans out events
  // to every registered MediaStreamTrack — originals and clones.
  private var interruptionObserver: NSObjectProtocol?
  private var interruptionEndedObserver: NSObjectProtocol?
  private var runtimeErrorObserver: NSObjectProtocol?
  // @ref LLP 0009#audio-track-events — AVAudioSession posts a separate
  // interruption notification (phone call, another app's session preempts
  // ours). Translate it into the same mute/unmute fan-out so audio tracks
  // see the same interruption semantics as video tracks.
  private var audioInterruptionObserver: NSObjectProtocol?

  // Weak refs to every live track that references this source, so we can
  // fan out mute/unmute/runtime-error events. NSHashTable provides weak
  // semantics so a track being GC'd silently leaves the set.
  private let liveTracks = NSHashTable<MediaStreamTrack>.weakObjects()
  // Strict count, decremented from MediaStreamTrack.stop(). When this hits
  // zero the session is stopped; see LLP 0003#track-stop step 4.
  private var liveTrackCount = 0
  private let lock = NSLock()

  init(
    session: AVCaptureSession,
    device: AVCaptureDevice?,
    audioDevice: AVCaptureDevice?,
    frameSink: FrameSink?,
    audioSink: AudioSink?,
    videoConnection: AVCaptureConnection?,
    audioConnection: AVCaptureConnection?
  ) {
    self.session = session
    self.device = device
    self.audioDevice = audioDevice
    self.frameSink = frameSink
    self.audioSink = audioSink
    self.videoConnection = videoConnection
    self.audioConnection = audioConnection
    installSessionObservers()
  }

  deinit {
    removeSessionObservers()
    // Defensive — if the refcount path didn't stop the session (e.g., the
    // source is being torn down via GC before any track stop()), stop it now.
    let session = self.session
    let hadAudio = audioDevice != nil
    MediaStream.sessionQueue.async {
      if session.isRunning {
        session.stopRunning()
      }
      if hadAudio {
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
      }
    }
  }

  // Called from MediaStreamTrack.init for both original and cloned tracks.
  // @ref LLP 0003#track-clone — increments the live count
  func registerTrack(_ track: MediaStreamTrack) {
    lock.lock()
    liveTrackCount += 1
    lock.unlock()
    liveTracks.add(track)
  }

  // Called from MediaStreamTrack.stop() and .endByRuntimeError().
  // @ref LLP 0003#track-stop — step 4: notify the source; if no live tracks
  // remain, stop the underlying AVCaptureSession.
  func unregisterTrack(_ track: MediaStreamTrack) {
    lock.lock()
    liveTrackCount -= 1
    let shouldStop = liveTrackCount <= 0
    lock.unlock()
    liveTracks.remove(track)
    if shouldStop {
      let source = self
      MediaStream.sessionQueue.async {
        source.stopSessionAndDeactivateAudioIfNeeded()
      }
    }
  }

  // @ref LLP 0012#native-extension-shape — ARKit cannot take the camera until
  // the AVFoundation source has actually reached the serialized stop point on
  // `MediaStream.sessionQueue`.
  func waitForRelease(completion: @escaping (Bool) -> Void) {
    let source = self
    MediaStream.sessionQueue.async {
      let released = !source.hasLiveTracks
      if released {
        source.stopSessionAndDeactivateAudioIfNeeded()
      }
      completion(released)
    }
  }

  private var hasLiveTracks: Bool {
    lock.lock()
    let count = liveTrackCount
    lock.unlock()
    return count > 0
  }

  private func stopSessionAndDeactivateAudioIfNeeded() {
    if session.isRunning {
      session.stopRunning()
    }
    // @ref LLP 0009#audio-session-configuration — release the system audio
    // session so other apps can resume playback when the last reference goes.
    if audioDevice != nil {
      try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
  }

  // MARK: - Notification observers
  // @ref LLP 0003#track-events — Wire AVCaptureSession interruptions to track
  // mute/unmute events. Covers:
  //   - app backgrounded (videoDeviceNotAvailableInBackground)
  //   - camera in use by another app (videoDeviceInUseByAnotherClient)
  //   - multiple foreground apps on iPad (videoDeviceNotAvailableWithMultipleForegroundApps)
  //   - thermal pressure / overheating (videoDeviceNotAvailableDueToSystemPressure)
  //   - sensitive content mitigation (iOS 17+)

  private func installSessionObservers() {
    let nc = NotificationCenter.default
    interruptionObserver = nc.addObserver(
      forName: AVCaptureSession.wasInterruptedNotification,
      object: session,
      queue: .main
    ) { [weak self] _ in
      self?.handleInterruption(muted: true)
    }
    interruptionEndedObserver = nc.addObserver(
      forName: AVCaptureSession.interruptionEndedNotification,
      object: session,
      queue: .main
    ) { [weak self] _ in
      self?.handleInterruption(muted: false)
    }
    runtimeErrorObserver = nc.addObserver(
      forName: AVCaptureSession.runtimeErrorNotification,
      object: session,
      queue: .main
    ) { [weak self] _ in
      self?.handleRuntimeError()
    }
    // @ref LLP 0009#audio-track-events — AVAudioSession interruption notifications.
    if audioDevice != nil {
      audioInterruptionObserver = nc.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: AVAudioSession.sharedInstance(),
        queue: .main
      ) { [weak self] note in
        guard let info = note.userInfo,
              let typeRaw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else {
          return
        }
        self?.handleInterruption(muted: type == .began)
      }
    }
  }

  private func removeSessionObservers() {
    let nc = NotificationCenter.default
    if let o = interruptionObserver { nc.removeObserver(o) }
    if let o = interruptionEndedObserver { nc.removeObserver(o) }
    if let o = runtimeErrorObserver { nc.removeObserver(o) }
    if let o = audioInterruptionObserver { nc.removeObserver(o) }
    interruptionObserver = nil
    interruptionEndedObserver = nil
    runtimeErrorObserver = nil
    audioInterruptionObserver = nil
  }

  private func handleInterruption(muted: Bool) {
    for track in liveTracks.allObjects {
      track.setMuted(muted)
    }
  }

  private func handleRuntimeError() {
    for track in liveTracks.allObjects {
      track.endByRuntimeError()
    }
  }

  // Test hook — posts the same notifications iOS would, so WPT tests can
  // verify the mute/unmute path without needing real thermal pressure.
  // @ref LLP 0007#testing-overheating
  func simulateInterruption(reasonCode: Int, ended: Bool) {
    let name: Notification.Name = ended
      ? AVCaptureSession.interruptionEndedNotification
      : AVCaptureSession.wasInterruptedNotification
    var userInfo: [AnyHashable: Any] = [:]
    if !ended {
      userInfo[AVCaptureSessionInterruptionReasonKey] = NSNumber(value: reasonCode)
    }
    NotificationCenter.default.post(name: name, object: session, userInfo: userInfo)
  }
}

// @ref LLP 0005#first-frame-detection — Holds an AVCaptureVideoDataOutput
// attached to the session purely so frames are actively delivered and we get
// a reliable "first sample" callback. The VideoView subscribes to its
// `onFirstFrame` callback to fire the loadeddata event.
//
// The sink also retains the latest CVPixelBuffer so MediaStreamTrack.grabFrame()
// can hand a frame to WebGPU consumers. Pixel format is forced to BGRA so the
// returned bytes can be uploaded as `bgra8unorm` without a colorspace conversion.
// The eventual zero-copy path will hand the CVPixelBuffer's IOSurface directly
// to Dawn via SharedTextureMemory; see LLP 0011 once react-native-wgpu exposes it.
internal final class FrameSink: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  let output = AVCaptureVideoDataOutput()
  private let queue = DispatchQueue(label: "dev.ide.standardcamera.frame-sink")
  private var hasFiredFirstFrame = false

  // Retained latest pixel buffer for grabFrame() pulls. Updated on `queue` and
  // read under `bufferLock` from arbitrary threads (typically the JS thread).
  private let bufferLock = NSLock()
  private var latestPixelBuffer: CVPixelBuffer?
  // Monotonic counter of sample buffers delivered by AVCapture. Returned
  // alongside grabFrame() output so JS can tell whether iOS is actively
  // pushing new frames (rising) or stopped (flat) — distinct from whether
  // grabFrame just keeps re-reading the same retained buffer.
  private var frameCounter: UInt64 = 0

  /// Called on the main thread once after the first sample arrives.
  /// Reset to nil after firing (one-shot). Set again to listen for the next
  /// stream attachment, which happens after the previous stream is stopped.
  var onFirstFrame: (() -> Void)?

  override init() {
    super.init()
    output.alwaysDiscardsLateVideoFrames = true
    // Force BGRA so grabFrame() returns predictable bytes that a WebGPU
    // `bgra8unorm` texture can consume verbatim.
    output.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String: NSNumber(value: kCVPixelFormatType_32BGRA)
    ]
    output.setSampleBufferDelegate(self, queue: queue)
  }

  func resetFirstFrame() {
    hasFiredFirstFrame = false
  }

  /// Returns the most recently received pixel buffer, its dimensions, and a
  /// monotonic frame counter (incremented on every iOS sample-buffer
  /// delivery). nil when no frame has arrived yet. The buffer is retained;
  /// the caller must lock it before reading bytes.
  func copyLatestPixelBuffer() -> (pixelBuffer: CVPixelBuffer, width: Int, height: Int, frameNumber: UInt64)? {
    bufferLock.lock()
    let pb = latestPixelBuffer
    let n = frameCounter
    bufferLock.unlock()
    guard let pb else { return nil }
    return (pb, CVPixelBufferGetWidth(pb), CVPixelBufferGetHeight(pb), n)
  }

  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    if let pb = CMSampleBufferGetImageBuffer(sampleBuffer) {
      bufferLock.lock()
      latestPixelBuffer = pb
      frameCounter &+= 1
      bufferLock.unlock()
    }
    if hasFiredFirstFrame { return }
    hasFiredFirstFrame = true
    DispatchQueue.main.async { [weak self] in
      self?.onFirstFrame?()
    }
  }
}

// @ref LLP 0009#audio-build-session — Audio analog of FrameSink. Holds an
// AVCaptureAudioDataOutput attached to the session so samples actively flow
// and `audioConnection.isEnabled = false` actually has something to gate.
// Also maintains a small rolling buffer of the most-recent Float32 LPCM
// samples so consumers (MediaRecorder, Web Audio bridge, level meters, the
// disabled-audio test) can read recent activity without a separate hook
// path. The buffer is the audio analog of FrameSink's latest CVPixelBuffer.
//
// We don't request a specific audioSettings here — on iOS that property is
// read-only and AVFoundation delivers the platform-native format (Float32
// LPCM in current iOS versions). The captureOutput callback inspects the
// per-buffer AudioStreamBasicDescription and only writes when the format
// is in fact Float32 LPCM. Anything else is dropped (and the frameCounter
// doesn't advance), which is the safe failure mode — the disabled-audio
// test sees "no samples arriving" rather than wrong values.
internal final class AudioSink: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
  let output = AVCaptureAudioDataOutput()
  private let queue = DispatchQueue(label: "dev.ide.standardcamera.audio-sink")

  // Ring buffer holding the most-recent ~200ms of interleaved Float32
  // samples. 48 kHz × 2 ch × 0.2 s = 19,200 floats; padded to a power of 2
  // for cheap modulo-via-mask. Held under `bufferLock`; the delegate writes
  // from `queue`, JS reads from the main thread via copyLatestSamples.
  private let bufferLock = NSLock()
  private static let ringCapacity = 32_768
  private var ring = [Float](repeating: 0, count: ringCapacity)
  private var writeIndex: Int = 0
  // Monotonic frames-written counter (one frame = one sample per channel).
  // Returned alongside copyLatestSamples so JS can tell whether iOS is
  // pushing new audio (rising) or stopped (flat) — the audio analog of
  // FrameSink's frameNumber.
  private var totalFramesWritten: UInt64 = 0
  private var sampleRate: Double = 0
  private var channelCount: Int = 0

  override init() {
    super.init()
    // `audioSettings` is macOS-only — on iOS AVCaptureAudioDataOutput
    // delivers whatever LPCM format iOS picks for the route. The
    // captureOutput callback inspects each buffer's ASBD and only copies
    // into the ring when it sees Float32 LPCM. Frame counting happens
    // regardless of format, so consumers that only care about "samples
    // arriving" (the disabled-audio test) work even if the route's format
    // doesn't match what the ring stores.
    output.setSampleBufferDelegate(self, queue: queue)
  }

  /// Snapshots the most-recent `maxFrames` frames (one frame = one sample
  /// per channel) as interleaved Float32 in chronological order, with the
  /// ring's wrap undone so JS sees a contiguous buffer. Always returns a
  /// value while the AudioSink exists, even before any callbacks have
  /// fired — `frameNumber` is 0 in that case so callers can distinguish
  /// "no audio sink" (null at the caller) from "sink exists but no
  /// samples yet" (frameNumber=0).
  func copyLatestSamples(maxFrames: Int) -> (samples: [Float], sampleRate: Double, channelCount: Int, frameNumber: UInt64) {
    bufferLock.lock()
    defer { bufferLock.unlock() }
    guard channelCount > 0, totalFramesWritten > 0 else {
      return ([], sampleRate, channelCount, totalFramesWritten)
    }
    let perFrame = channelCount
    let wantFloats = min(maxFrames * perFrame, AudioSink.ringCapacity)
    let endExclusive = writeIndex
    let startInclusive = ((endExclusive - wantFloats) % AudioSink.ringCapacity + AudioSink.ringCapacity) % AudioSink.ringCapacity
    var out = [Float](); out.reserveCapacity(wantFloats)
    if startInclusive < endExclusive {
      out.append(contentsOf: ring[startInclusive..<endExclusive])
    } else {
      out.append(contentsOf: ring[startInclusive..<AudioSink.ringCapacity])
      out.append(contentsOf: ring[0..<endExclusive])
    }
    return (out, sampleRate, channelCount, totalFramesWritten)
  }

  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    guard let fmtDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
          let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc) else {
      return
    }
    let asbd = asbdPtr.pointee
    let frames = CMSampleBufferGetNumSamples(sampleBuffer)

    // Frame counter advances on every delivered buffer regardless of
    // format, so "samples are flowing" is observable even if the format
    // doesn't match what the ring expects below. The disabled-audio test
    // only checks this counter; ring contents are for richer consumers.
    let channels = max(1, Int(asbd.mChannelsPerFrame))
    bufferLock.lock()
    sampleRate = asbd.mSampleRate
    channelCount = channels
    totalFramesWritten &+= UInt64(frames)
    bufferLock.unlock()

    // Ring write only fires for Float32 LPCM. If the route delivers
    // anything else, we still count frames but skip the copy — better to
    // surface an empty `samples` array to consumers than wrong values.
    // `audioSettings` is read-only on iOS for AVCaptureAudioDataOutput, so
    // we accept whatever iOS chooses and report mismatches via the NSLog.
    guard asbd.mFormatID == kAudioFormatLinearPCM,
          (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0,
          asbd.mBitsPerChannel == 32 else {
      return
    }
    guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
    var totalLength: Int = 0
    var dataPtr: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil,
                                      totalLengthOut: &totalLength, dataPointerOut: &dataPtr) == kCMBlockBufferNoErr,
          let raw = dataPtr else {
      return
    }
    let floatCount = totalLength / MemoryLayout<Float>.size

    bufferLock.lock()
    let cap = AudioSink.ringCapacity
    raw.withMemoryRebound(to: Float.self, capacity: floatCount) { src in
      let firstChunk = min(floatCount, cap - writeIndex)
      ring.withUnsafeMutableBufferPointer { dst in
        memcpy(dst.baseAddress! + writeIndex, src, firstChunk * MemoryLayout<Float>.size)
        if floatCount > firstChunk {
          memcpy(dst.baseAddress!, src + firstChunk, (floatCount - firstChunk) * MemoryLayout<Float>.size)
        }
      }
    }
    writeIndex = (writeIndex + floatCount) % cap
    bufferLock.unlock()
  }
}
