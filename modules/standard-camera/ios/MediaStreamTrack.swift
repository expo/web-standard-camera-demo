import AVFoundation
import ExpoModulesCore

// @ref LLP 0008#dom-mediastreamtrack — Upstream spec text
// @ref LLP 0003#track-* — MediaStreamTrack subset; native state container
// @ref LLP 0005#architecture — SharedObject holds metadata; the AVCaptureSession
//                                lives on the parent MediaStream.

internal final class MediaStreamTrack: SharedObject {
  let id: String
  let kind: String = "video"
  // @ref LLP 0008#dom-mediastreamtrack-label — set at construction, never changes.
  // The spec defines [[Label]] as initialized to the source's label and contains
  // no normative requirement that it changes when readyState transitions to "ended".
  let label: String
  let settings: [String: Any]
  let constraints: [String: Any]

  // Back-reference to the owning stream so stop() can ask the stream whether
  // it should also stop the underlying AVCaptureSession.
  weak var stream: MediaStream?

  weak var connection: AVCaptureConnection?

  // @ref LLP 0008#dom-mediastreamtrack-enabled — spec attribute
  // @ref LLP 0003#track-enabled
  var enabled: Bool = true {
    didSet {
      // The data-output connection controls whether frames flow into FrameSink
      // (and any future MediaRecorder-style consumers). The AVCaptureVideoPreviewLayer
      // has its own internal connection that we don't toggle here, so disabling
      // a track freezes downstream consumers but leaves the on-screen preview
      // showing the most recent frame.
      connection?.isEnabled = enabled
    }
  }

  // @ref LLP 0008#dom-mediastreamtrack-muted — spec attribute
  // @ref LLP 0003#track-muted — Reflects AVCaptureSession interruption state.
  // Toggled by MediaStream observers when the session is interrupted/resumed.
  private(set) var muted: Bool = false

  // @ref LLP 0008#dom-mediastreamtrack-readystate — spec attribute
  // @ref LLP 0003#track-readyState — "live" until stop() or runtime error.
  private(set) var readyState: String = "live"

  init(
    id: String,
    label: String,
    settings: [String: Any],
    constraints: [String: Any]
  ) {
    self.id = id
    self.label = label
    self.settings = settings
    self.constraints = constraints
    super.init()
  }

  // @ref LLP 0008#dom-mediastreamtrack-stop — spec algorithm
  // @ref LLP 0003#track-stop — Synchronous readyState change; async "ended" event.
  // Per LLP step 4, if no other live tracks remain on the stream, stop the session.
  func stop() {
    if readyState == "ended" {
      return
    }
    readyState = "ended"
    connection?.isEnabled = false

    if let stream {
      stream.trackDidEnd(self)
    }
    emit(event: "ended")
  }

  // Called by MediaStream when the AVCaptureSession is interrupted (or resumed).
  // @ref LLP 0008#dom-mediastreamtrack-mute-algorithm — spec algorithm
  // @ref LLP 0003#track-events — mute/unmute fire as a separate task.
  func setMuted(_ value: Bool) {
    if muted == value || readyState == "ended" {
      return
    }
    muted = value
    emit(event: value ? "mute" : "unmute")
  }

  // Called by MediaStream when an AVCaptureSession runtime error fires.
  // Marks the track ended without re-entering stop()'s stream-cleanup path
  // (the session is already broken; nothing to stop).
  // @ref LLP 0008#event-mediastreamtrack-ended — spec algorithm for the
  //   non-stop() termination path: queue a task that sets ReadyState to
  //   "ended" and fires `ended` at the track.
  func endByRuntimeError() {
    if readyState == "ended" {
      return
    }
    readyState = "ended"
    emit(event: "ended")
  }
}
