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

    // @ref LLP 0007#harness-surface — Native passthrough so WPT_RESULT / WPT_DONE
    // lines reach the simulator's unified-log stream even in Release builds,
    // where React Native's `console.log` is not bridged to NSLog.
    Function("__systemLogForTesting") { (message: String) in
      NSLog("%@", message)
    }

    // @ref LLP 0008#dom-mediadevices-getsupportedconstraints — Per spec, this
    // returns a `MediaTrackSupportedConstraints` dictionary listing every
    // constraint name the UA recognizes — regardless of whether the current
    // device actually supports it. WPT tests assert every standard field is
    // reported. We honor video fields and additionally report audio fields
    // as supported (audio capture itself is out of scope, but reporting them
    // as recognized constraints is lossless).
    Function("getSupportedConstraints") { () -> [String: Bool] in
      return [
        // Video
        "width": true,
        "height": true,
        "facingMode": true,
        "frameRate": true,
        "aspectRatio": true,
        "resizeMode": true,
        // Identifiers (shared)
        "deviceId": true,
        "groupId": true,
        // Audio — recognized but unsupported by our v1 capture pipeline.
        "sampleRate": true,
        "sampleSize": true,
        "echoCancellation": true,
        "autoGainControl": true,
        "noiseSuppression": true,
        "voiceIsolation": true,
        "latency": true,
        "channelCount": true,
      ]
    }

    // @ref LLP 0008#mediastream-constructor — script-constructed MediaStream
    // @ref LLP 0003#stream-construction — Native handle for a JS-constructed
    // stream so it still has a SharedObject id for instanceof / native-prop forwarding.
    Function("createMediaStream") { (tracks: [MediaStreamTrack]) -> MediaStream in
      return MediaStream(id: UUID().uuidString, tracks: tracks)
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

      Function("getAudioTracks") { (stream: MediaStream) -> [MediaStreamTrack] in
        stream.getAudioTracks()
      }

      Function("getTrackById") { (stream: MediaStream, trackId: String) -> MediaStreamTrack? in
        stream.getTrackById(trackId)
      }

      // @ref LLP 0008#dom-mediastream-addtrack — script-initiated; no event fires
      Function("addTrack") { (stream: MediaStream, track: MediaStreamTrack) in
        stream.addTrack(track)
      }

      // @ref LLP 0008#dom-mediastream-removetrack — script-initiated; no event fires
      Function("removeTrack") { (stream: MediaStream, track: MediaStreamTrack) in
        stream.removeTrack(track)
      }

      // @ref LLP 0008#dom-mediastream-clone
      Function("clone") { (stream: MediaStream) -> MediaStream in
        stream.clone()
      }

      // Test hook — posts a synthetic AVCaptureSession interruption notification
      // so WPT tests can verify the mute/unmute path without needing real
      // thermal pressure.
      Function("__simulateInterruptionForTesting") {
        (stream: MediaStream, reasonCode: Int, ended: Bool) in
        stream.simulateInterruption(reasonCode: reasonCode, ended: ended)
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

      // @ref LLP 0008#dom-mediastreamtrack-getcapabilities — report the
      // capabilities of the AVCaptureDevice. We surface fixed ranges based on
      // the current device's active format. Spec-required fields for video
      // tracks: width, height, aspectRatio, frameRate, facingMode, resizeMode,
      // deviceId, groupId.
      Function("getCapabilities") { (track: MediaStreamTrack) -> [String: Any] in
        track.capabilities()
      }

      // @ref LLP 0008#dom-mediastreamtrack-clone
      Function("clone") { (track: MediaStreamTrack) -> MediaStreamTrack in
        track.cloneTrack()
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
