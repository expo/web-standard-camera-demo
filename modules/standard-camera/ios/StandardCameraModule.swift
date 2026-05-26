import AVFoundation
import ExpoModulesCore
import UIKit

// Map `AVAuthorizationStatus` to a stable string the JS layer can render. Lives
// at file scope so the module definition stays focused on bindings.
private func authorizationStatusString(_ status: AVAuthorizationStatus) -> String {
  switch status {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .notDetermined: return "not-determined"
  case .restricted: return "restricted"
  @unknown default: return "unknown"
  }
}

private func isSimulator() -> Bool {
  #if targetEnvironment(simulator)
  return true
  #else
  return false
  #endif
}

private let onLiDARDepthSessionState = "onLiDARDepthSessionState"

private final class CaptureReleaseBlockedException: Exception {
  override var reason: String {
    "Standard camera capture source is still held by another live MediaStreamTrack"
  }
}

// @ref LLP 0000 — standard-camera module entry point
// @ref LLP 0001 — Spec subset index; every Function/Property below maps to a clause

public final class StandardCameraModule: Module {
  public func definition() -> ModuleDefinition {
    Name("StandardCamera")
    Events(onLiDARDepthSessionState)

    OnStartObserving(onLiDARDepthSessionState) {
      LiDARDepthSource.shared.onStateEvent = { [weak self] event in
        self?.sendEvent(onLiDARDepthSessionState, event)
      }
    }

    OnStopObserving(onLiDARDepthSessionState) {
      LiDARDepthSource.shared.onStateEvent = nil
    }

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

    // @ref LLP 0001#mediadevices-enumeratedevices — Walk every built-in camera
    // type and surface each as its own MediaDeviceInfo. Modern iPhones expose
    // a mix of physical lenses (`.builtInWideAngleCamera`,
    // `.builtInUltraWideCamera`, `.builtInTelephotoCamera`,
    // `.builtInTrueDepthCamera`) and virtual auto-switching cameras
    // (`.builtInDualCamera`, `.builtInDualWideCamera`, `.builtInTripleCamera`,
    // `.builtInLiDARDepthCamera`); each has a stable `uniqueID` we use as both
    // `deviceId` and `groupId`. Per LLP 0002 the JS layer hides `deviceId` /
    // `label` / `groupId` until a successful video gUM, so calling this
    // pre-grant just reveals the count and kind.
    AsyncFunction("enumerateDevicesAsync") { () -> [[String: Any]] in
      let videoTypes: [AVCaptureDevice.DeviceType] = [
        .builtInWideAngleCamera,
        .builtInUltraWideCamera,
        .builtInTelephotoCamera,
        .builtInTrueDepthCamera,
        .builtInDualCamera,
        .builtInDualWideCamera,
        .builtInTripleCamera,
        .builtInLiDARDepthCamera,
      ]
      let videoDiscovery = AVCaptureDevice.DiscoverySession(
        deviceTypes: videoTypes,
        mediaType: .video,
        position: .unspecified
      )
      var seen = Set<String>()
      var out: [[String: Any]] = []
      for device in videoDiscovery.devices {
        if seen.insert(device.uniqueID).inserted {
          out.append([
            "deviceId": device.uniqueID,
            "groupId": device.uniqueID,
            "kind": "videoinput",
            "label": device.localizedName,
          ])
        }
      }
      // @ref LLP 0009#audio-pick-device — Single audio device entry: the
      // system's currently-routed input. We don't enumerate every port
      // (built-in / headset / bluetooth) because the iOS audio capture API
      // surfaces only the active route as an AVCaptureDevice.
      //
      // `AVCaptureDevice.default(for: .audio)` returns nil on a real device
      // until AVAudioSession has been activated for record — so on a fresh
      // app launch enumerate would report `hasMicrophone: false` even
      // though the iPhone's built-in mic is unquestionably present and the
      // user may have already granted permission. The fallback below
      // synthesises an entry on non-simulator hardware whenever the
      // authorization status isn't `.denied` / `.restricted`; the
      // simulator path keeps using the actual default-device probe since
      // simulator audio is the Mac host's input and "no input" is a real
      // possibility there.
      let audioAuth = AVCaptureDevice.authorizationStatus(for: .audio)
      let micUsableOnHardware = !isSimulator() && audioAuth != .denied && audioAuth != .restricted
      if let audio = AVCaptureDevice.default(for: .audio) {
        // Fall back to a stable synthetic id if the device's uniqueID is
        // empty — iOS simulators sometimes return empty strings here, and
        // the spec requires the deviceId be non-empty once granted.
        let audioId = audio.uniqueID.isEmpty ? "default-audio-input" : audio.uniqueID
        if seen.insert(audioId).inserted {
          out.append([
            "deviceId": audioId,
            "groupId": audioId,
            "kind": "audioinput",
            "label": audio.localizedName,
          ])
        }
      } else if micUsableOnHardware, seen.insert("default-audio-input").inserted {
        out.append([
          "deviceId": "default-audio-input",
          "groupId": "default-audio-input",
          "kind": "audioinput",
          // Label is unknown until the audio session is configured; the
          // JS polyfill will redact it pre-grant anyway.
          "label": "",
        ])
      }
      return out
    }

    // @ref LLP 0007#harness-surface — Native passthrough so WPT_RESULT / WPT_DONE
    // lines reach the simulator's unified-log stream even in Release builds,
    // where React Native's `console.log` is not bridged to NSLog.
    Function("__systemLogForTesting") { (message: String) in
      NSLog("%@", message)
    }

    // Read-only diagnostics for the Diagnostics tab. We surface enough state
    // to answer "what code is the device actually running, and can the camera
    // be opened without prompting?" — both questions came up when a phone
    // build silently ran a stale embedded bundle. The permission lookups use
    // AVCaptureDevice.authorizationStatus(for:), which does NOT trigger the
    // iOS permission dialog.
    Function("getDiagnostics") { () -> [String: Any] in
      let executableMtime: Double? = {
        guard let path = Bundle.main.executableURL?.path,
              let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let date = attrs[.modificationDate] as? Date else {
          return nil
        }
        return date.timeIntervalSince1970
      }()
      let bundle = Bundle.main
      let device = UIDevice.current
      return [
        "bundleVersion": bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
        "bundleShortVersion": bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
        "bundleIdentifier": bundle.bundleIdentifier ?? "",
        "executableMtime": executableMtime as Any,
        "systemName": device.systemName,
        "systemVersion": device.systemVersion,
        "model": device.model,
        "deviceName": device.name,
        "isSimulator": isSimulator(),
        "cameraAuthorization": authorizationStatusString(
          AVCaptureDevice.authorizationStatus(for: .video)
        ),
        "microphoneAuthorization": authorizationStatusString(
          AVCaptureDevice.authorizationStatus(for: .audio)
        ),
      ]
    }

    // MARK: - LiDAR depth demo extension
    // @ref LLP 0012#native-extension-shape — This is intentionally not
    // navigator.mediaDevices API. Native ARKit produces depth frames; WebGPU
    // consumes them in the demo route.

    Function("getLiDARDepthCapabilities") { () -> [String: Any] in
      LiDARDepthSource.shared.capabilities()
    }

    AsyncFunction("startLiDARDepthAsync") { (promise: Promise) in
      DispatchQueue.main.async {
        LiDARDepthSource.shared.start(
          resolve: { payload in promise.resolve(payload) },
          reject: { error in promise.reject(error) }
        )
      }
    }

    AsyncFunction("startLiDARDepthWithTypeAsync") { (depthType: String, promise: Promise) in
      DispatchQueue.main.async {
        LiDARDepthSource.shared.start(
          preferredDepthType: depthType,
          resolve: { payload in promise.resolve(payload) },
          reject: { error in promise.reject(error) }
        )
      }
    }

    AsyncFunction("stopLiDARDepthAsync") { (promise: Promise) in
      DispatchQueue.main.async {
        LiDARDepthSource.shared.stop()
        promise.resolve(nil)
      }
    }

    Function("stopLiDARDepth") {
      DispatchQueue.main.async {
        LiDARDepthSource.shared.stop()
      }
    }

    Function("getLatestLiDARDepthFrame") { () -> [String: Any]? in
      LiDARDepthSource.shared.latestFrame()
    }

    Function("getLatestWebXRLiDARDepthFrame") { () -> [String: Any]? in
      // @ref LLP 0013#xr-camera-resolution — WebXR uses a separate
      // higher-resolution CPU camera image while the native sidecar keeps its
      // existing upload size.
      LiDARDepthSource.shared.latestWebXRFrame()
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

      // @ref LLP 0012#native-extension-shape — Internal demo handoff hook:
      // stops the stream's tracks, then resolves only after AVFoundation has
      // reached the serialized capture release point.
      AsyncFunction("__stopTracksAndWaitForCaptureReleaseAsync") { (stream: MediaStream, promise: Promise) in
        stream.stopTracksAndWaitForCaptureRelease { released in
          if released {
            promise.resolve(nil)
          } else {
            promise.reject(CaptureReleaseBlockedException())
          }
        }
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

      // Internal accessor used by the JS-side `ImageCapture` implementation —
      // not exposed on MediaStreamTrack's public surface because grabFrame is
      // spelled at the ImageCapture layer in the W3C Image Capture spec, not
      // on MediaStreamTrack. Returns the most recent frame as a tight-packed
      // BGRA byte buffer plus dimensions, or nil if no frame is available
      // (cold start, simulator with no AVCaptureDevice, ended track). The
      // demo uploads this into a `bgra8unorm` texture via
      // `device.queue.writeTexture`. See LLP 0011 for the zero-copy
      // SharedTextureMemory follow-up once react-native-wgpu exposes it.
      Function("__getLatestFrame") { (track: MediaStreamTrack) -> [String: Any]? in
        track.getLatestFrame()
      }

      // @ref LLP 0009#audio-build-session — Symmetric audio-buffer accessor.
      // `maxFrames` caps the frame count returned (one frame = one sample
      // per channel); the actual return may be shorter if the ring hasn't
      // filled yet. Returns nil on a video track, an ended track, or before
      // any audio samples have arrived.
      Function("__getLatestAudioBuffer") { (track: MediaStreamTrack, maxFrames: Int) -> [String: Any]? in
        track.getLatestAudioBuffer(maxFrames: maxFrames)
      }

      // Test hook for the project-local `MediaStreamTrack-disabled-video`
      // test — surfaces whether any subscribed VideoView's preview-layer
      // connection is currently enabled. nil for non-video tracks, ended
      // tracks, or when no VideoView is rendering the stream.
      Function("__getPreviewEnabledForTesting") { (track: MediaStreamTrack) -> Bool? in
        track.getPreviewEnabledForTesting()
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
