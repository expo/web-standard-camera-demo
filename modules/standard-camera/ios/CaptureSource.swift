import AVFoundation

// @ref LLP 0003#stream-clone — Reference-counted holder of the AVCaptureSession
// @ref LLP 0003#track-clone — Cloned tracks share a CaptureSource and keep the
//                              camera open as long as at least one track is live.
// @ref LLP 0005#architecture — This class is the AVFoundation realization of
//                               the spec's [[Source]] concept.

internal final class CaptureSource {
  let session: AVCaptureSession
  let device: AVCaptureDevice
  let frameSink: FrameSink

  // The AVCaptureConnection between the device input and the FrameSink output.
  // Track.enabled = false flips this; see LLP 0003#track-enabled.
  weak var connection: AVCaptureConnection?

  // Notification observers — closure-based so we don't need to be NSObject.
  // Per LLP 0003#stream-events, AVCaptureSession interruption / runtime errors
  // surface on the session, so observers live here. The source fans out events
  // to every registered MediaStreamTrack — originals and clones.
  private var interruptionObserver: NSObjectProtocol?
  private var interruptionEndedObserver: NSObjectProtocol?
  private var runtimeErrorObserver: NSObjectProtocol?

  // Weak refs to every live track that references this source, so we can
  // fan out mute/unmute/runtime-error events. NSHashTable provides weak
  // semantics so a track being GC'd silently leaves the set.
  private let liveTracks = NSHashTable<MediaStreamTrack>.weakObjects()
  // Strict count, decremented from MediaStreamTrack.stop(). When this hits
  // zero the session is stopped; see LLP 0003#track-stop step 4.
  private var liveTrackCount = 0
  private let lock = NSLock()

  init(session: AVCaptureSession, device: AVCaptureDevice, frameSink: FrameSink, connection: AVCaptureConnection?) {
    self.session = session
    self.device = device
    self.frameSink = frameSink
    self.connection = connection
    installSessionObservers()
  }

  deinit {
    removeSessionObservers()
    // Defensive — if the refcount path didn't stop the session (e.g., the
    // source is being torn down via GC before any track stop()), stop it now.
    let session = self.session
    MediaStream.sessionQueue.async {
      if session.isRunning {
        session.stopRunning()
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
      let session = self.session
      MediaStream.sessionQueue.async {
        if session.isRunning {
          session.stopRunning()
        }
      }
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
  }

  private func removeSessionObservers() {
    let nc = NotificationCenter.default
    if let o = interruptionObserver { nc.removeObserver(o) }
    if let o = interruptionEndedObserver { nc.removeObserver(o) }
    if let o = runtimeErrorObserver { nc.removeObserver(o) }
    interruptionObserver = nil
    interruptionEndedObserver = nil
    runtimeErrorObserver = nil
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
internal final class FrameSink: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  let output = AVCaptureVideoDataOutput()
  private let queue = DispatchQueue(label: "dev.ide.standardcamera.frame-sink")
  private var hasFiredFirstFrame = false

  /// Called on the main thread once after the first sample arrives.
  /// Reset to nil after firing (one-shot). Set again to listen for the next
  /// stream attachment, which happens after the previous stream is stopped.
  var onFirstFrame: (() -> Void)?

  override init() {
    super.init()
    output.alwaysDiscardsLateVideoFrames = true
    output.setSampleBufferDelegate(self, queue: queue)
  }

  func resetFirstFrame() {
    hasFiredFirstFrame = false
  }

  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    if hasFiredFirstFrame { return }
    hasFiredFirstFrame = true
    DispatchQueue.main.async { [weak self] in
      self?.onFirstFrame?()
    }
  }
}
