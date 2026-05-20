import AVFoundation
import ExpoModulesCore

// @ref LLP 0003#track-* — MediaStreamTrack subset; native state container
// @ref LLP 0005#architecture — SharedObject holds metadata; the AVCaptureSession
//                                lives on the parent MediaStream.

internal final class MediaStreamTrack: SharedObject {
  let id: String
  let kind: String = "video"
  let label: String

  var enabled: Bool = true {
    didSet {
      connection?.isEnabled = enabled
    }
  }

  let muted: Bool = false

  // @ref LLP 0003#track-readyState — "live" until stop()
  private(set) var readyState: String = "live"

  let settings: [String: Any]
  let constraints: [String: Any]

  weak var session: AVCaptureSession?
  weak var connection: AVCaptureConnection?

  init(
    id: String,
    label: String,
    session: AVCaptureSession,
    connection: AVCaptureConnection?,
    settings: [String: Any],
    constraints: [String: Any]
  ) {
    self.id = id
    self.label = label
    self.session = session
    self.connection = connection
    self.settings = settings
    self.constraints = constraints
    super.init()
  }

  // @ref LLP 0003#track-stop — Synchronous readyState change; async "ended" event
  func stop() {
    if readyState == "ended" {
      return
    }
    readyState = "ended"
    connection?.isEnabled = false

    // Spec: fire `ended` as a queued task, not synchronously inside stop()
    emit(event: "ended")
  }
}
