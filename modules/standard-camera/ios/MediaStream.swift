import AVFoundation
import ExpoModulesCore

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
  }

  // @ref LLP 0003#stream-active — At least one track is "live"
  var active: Bool {
    return tracks.contains { $0.readyState == "live" }
  }

  func getTracks() -> [MediaStreamTrack] {
    return tracks
  }

  func getVideoTracks() -> [MediaStreamTrack] {
    return tracks.filter { $0.kind == "video" }
  }

  func getTrackById(_ trackId: String) -> MediaStreamTrack? {
    return tracks.first { $0.id == trackId }
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
