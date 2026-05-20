import AVFoundation
import ExpoModulesCore

// @ref LLP 0000 — standard-camera module entry point
// @ref LLP 0001 — Spec subset index; every Function/Property below maps to a clause

public final class StandardCameraModule: Module {
  public func definition() -> ModuleDefinition {
    Name("StandardCamera")

    // MARK: - MediaDevices

    // @ref LLP 0002 — getUserMedia subset
    AsyncFunction("getUserMediaAsync") { (constraints: GetUserMediaConstraints, promise: Promise) in
      Task {
        do {
          let stream = try await getUserMedia(constraints: constraints)
          promise.resolve(stream)
        } catch {
          promise.reject(error)
        }
      }
    }

    // @ref LLP 0001#mediadevices-enumeratedevices — Stub: default camera only
    AsyncFunction("enumerateDevicesAsync") { () -> [[String: Any]] in
      let device = AVCaptureDevice.default(for: .video)
      guard let device else { return [] }
      return [[
        "deviceId": device.uniqueID,
        "groupId": device.uniqueID,
        "kind": "videoinput",
        "label": device.localizedName
      ]]
    }

    // @ref LLP 0001#mediadevices-getsupportedconstraints
    Function("getSupportedConstraints") { () -> [String: Bool] in
      return [
        "width": true,
        "height": true,
        "facingMode": true,
        "frameRate": true,
        "aspectRatio": true,
        "deviceId": true,
        "groupId": true
      ]
    }

    // MARK: - MediaStream class
    // @ref LLP 0003#stream-*

    Class(MediaStream.self) {
      Property("id") { (stream: MediaStream) -> String in stream.id }

      Property("active") { (stream: MediaStream) -> Bool in stream.active }

      Function("getTracks") { (stream: MediaStream) -> [MediaStreamTrack] in
        stream.getTracks()
      }

      Function("getVideoTracks") { (stream: MediaStream) -> [MediaStreamTrack] in
        stream.getVideoTracks()
      }

      Function("getAudioTracks") { (_: MediaStream) -> [MediaStreamTrack] in
        []
      }

      Function("getTrackById") { (stream: MediaStream, trackId: String) -> MediaStreamTrack? in
        stream.getTrackById(trackId)
      }
    }

    // MARK: - MediaStreamTrack class
    // @ref LLP 0003#track-*

    Class(MediaStreamTrack.self) {
      Property("id") { (track: MediaStreamTrack) -> String in track.id }

      Property("kind") { (track: MediaStreamTrack) -> String in track.kind }

      Property("label") { (track: MediaStreamTrack) -> String in track.label }

      Property("enabled") { (track: MediaStreamTrack) -> Bool in track.enabled }
        .set { (track: MediaStreamTrack, value: Bool) in
          track.enabled = value
        }

      Property("muted") { (track: MediaStreamTrack) -> Bool in track.muted }

      Property("readyState") { (track: MediaStreamTrack) -> String in track.readyState }

      Function("stop") { (track: MediaStreamTrack) in
        track.stop()
      }

      Function("getSettings") { (track: MediaStreamTrack) -> [String: Any] in
        track.settings
      }

      Function("getConstraints") { (track: MediaStreamTrack) -> [String: Any] in
        track.constraints
      }

      Function("getCapabilities") { (_: MediaStreamTrack) -> [String: Any] in
        [:]
      }
    }

    // MARK: - VideoView
    // @ref LLP 0004#srcObject

    View(VideoView.self) {
      Events(
        "onLoadedData",
        "onDurationChange",
        "onEnded",
        "onPlay",
        "onPause"
      )

      Prop("srcObject") { (view: VideoView, stream: MediaStream?) in
        view.srcObject = stream
      }

      AsyncFunction("playAsync") { (view: VideoView) in
        view.play()
      }

      AsyncFunction("pauseAsync") { (view: VideoView) in
        view.pause()
      }
    }
  }
}
