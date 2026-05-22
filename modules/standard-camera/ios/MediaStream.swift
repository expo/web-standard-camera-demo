import AVFoundation
import ExpoModulesCore

// @ref LLP 0008#dom-mediastream — Upstream spec text
// @ref LLP 0003#stream-* — MediaStream subset
// @ref LLP 0005#architecture — Holds the AVCaptureSession that the VideoView's
//                                preview layer attaches to.

internal final class MediaStream: SharedObject {
  let id: String
  let session: AVCaptureSession
  private(set) var tracks: [MediaStreamTrack]

  // Hidden data output kept alive so the session has at least one consumer
  // and a delegate fires on first sample (used to drive the loadeddata event
  // when an AVCaptureVideoPreviewLayer is attached).
  internal let frameSink: FrameSink

  // Notification observers — closure-based so we don't need to be NSObject.
  private var interruptionObserver: NSObjectProtocol?
  private var interruptionEndedObserver: NSObjectProtocol?
  private var runtimeErrorObserver: NSObjectProtocol?

  // @ref LLP 0005#concurrency — Session mutation is serialized on this queue.
  static let sessionQueue = DispatchQueue(
    label: "dev.ide.standardcamera.session",
    qos: .userInitiated
  )

  init(id: String, session: AVCaptureSession, tracks: [MediaStreamTrack], frameSink: FrameSink) {
    self.id = id
    self.session = session
    self.tracks = tracks
    self.frameSink = frameSink
    super.init()

    for track in tracks {
      track.stream = self
    }
    installSessionObservers()
  }

  deinit {
    removeSessionObservers()
  }

  // @ref LLP 0008#dom-mediastream-active — spec attribute
  // @ref LLP 0003#stream-active — At least one track is "live"
  var active: Bool {
    return tracks.contains { $0.readyState == "live" }
  }

  // @ref LLP 0008#dom-mediastream-gettracks
  func getTracks() -> [MediaStreamTrack] {
    return tracks
  }

  // @ref LLP 0008#dom-mediastream-getvideotracks
  func getVideoTracks() -> [MediaStreamTrack] {
    return tracks.filter { $0.kind == "video" }
  }

  // @ref LLP 0008#dom-mediastream-gettrackbyid
  func getTrackById(_ trackId: String) -> MediaStreamTrack? {
    return tracks.first { $0.id == trackId }
  }

  // Called from MediaStreamTrack.stop(). If no live tracks remain, stop the
  // session — per LLP 0003#track-stop step 4. This releases the camera and
  // turns off the indicator light.
  func trackDidEnd(_ track: MediaStreamTrack) {
    if active { return }
    Self.sessionQueue.async { [session] in
      if session.isRunning {
        session.stopRunning()
      }
    }
  }

  // @ref LLP 0005#lifecycle — Stop the session and release the camera when the
  //                            JS handle is garbage-collected.
  override func sharedObjectWillRelease() {
    Self.sessionQueue.async { [session] in
      if session.isRunning {
        session.stopRunning()
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
    for track in tracks {
      track.setMuted(muted)
    }
  }

  private func handleRuntimeError() {
    for track in tracks {
      track.endByRuntimeError()
    }
  }

  // Test hook — posts the same notifications iOS would, so WPT tests can
  // verify the mute/unmute path without needing real thermal pressure.
  // The `reasonCode` corresponds to AVCaptureSession.InterruptionReason raw value
  // (4 == videoDeviceNotAvailableDueToSystemPressure, i.e. overheating).
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
