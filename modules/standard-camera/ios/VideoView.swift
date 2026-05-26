import AVFoundation
import ExpoModulesCore

// @ref LLP 0004#srcObject-* — HTMLMediaElement.srcObject subset, mirrored on a
//                              native ExpoView. The TS wrapper exposes the
//                              spec-shaped surface; this class is the bridge.
// @ref LLP 0005#architecture — AVCaptureVideoPreviewLayer renders the session.
// Mirrors expo-camera's pattern: install the preview layer as a sublayer
// in layoutSubviews after the view has known bounds.

internal final class VideoView: ExpoView {
  private lazy var previewLayer: AVCaptureVideoPreviewLayer = {
    let layer = AVCaptureVideoPreviewLayer()
    layer.videoGravity = .resizeAspectFill
    layer.needsDisplayOnBoundsChange = true
    return layer
  }()

  private var firstFrameObserver: NSKeyValueObservation?
  // CaptureSource the preview is currently subscribed to, so we can
  // unregister on detach. Weak so we don't keep the source alive past
  // its last live track.
  private weak var previewSource: CaptureSource?

  let onLoadedData = EventDispatcher()
  let onDurationChange = EventDispatcher()
  let onEnded = EventDispatcher()
  let onPlay = EventDispatcher()
  let onPause = EventDispatcher()

  weak var srcObject: MediaStream? {
    didSet {
      attachStream()
    }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
  }

  deinit {
    firstFrameObserver?.invalidate()
    previewSource?.unregisterPreview(self)
  }

  // Test hook — returns the preview layer's connection.isEnabled value.
  // Used by `MediaStreamTrack-disabled-video` to assert the fan-out from
  // `CaptureSource.setVideoEnabled` reached the preview layer. nil if the
  // preview layer hasn't created its connection yet (no session attached).
  var previewConnectionEnabledForTesting: Bool? {
    previewLayer.connection?.isEnabled
  }

  // Called by `CaptureSource.setVideoEnabled` so the preview layer's
  // separate AVCaptureConnection follows the video track's enabled state.
  // Disabling the connection alone is not enough: the AVCaptureVideoPreviewLayer
  // keeps its last frame as a static image (CALayer just stops repainting),
  // so a disabled track would *freeze* on the last live pixel rather than
  // going black. We also hide the layer so the view's
  // `backgroundColor = .black` shows through — that's the visible "solid
  // black frames" the spec asks for. CATransaction's disable-actions
  // suppresses the implicit fade Core Animation would otherwise apply.
  func setPreviewEnabled(_ enabled: Bool) {
    let apply: () -> Void = { [weak self] in
      guard let self else { return }
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      self.previewLayer.connection?.isEnabled = enabled
      self.previewLayer.isHidden = !enabled
      CATransaction.commit()
    }
    if Thread.isMainThread {
      apply()
    } else {
      DispatchQueue.main.async(execute: apply)
    }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    // Disable Core Animation's implicit animations so the preview layer doesn't
    // animate its frame/transform when bounds change (which produced a visible
    // slide-in when the screen first laid out).
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    previewLayer.frame = bounds
    if previewLayer.superlayer == nil {
      layer.insertSublayer(previewLayer, at: 0)
    }
    CATransaction.commit()
  }

  // @ref LLP 0004#srcobject-readyState — Reset to HAVE_NOTHING; fire
  //                                       loadeddata when frames arrive.
  private func attachStream() {
    firstFrameObserver?.invalidate()
    firstFrameObserver = nil
    // Detach from any previous source so we don't receive stale preview-
    // enable callbacks after the stream changes.
    previewSource?.unregisterPreview(self)
    previewSource = nil

    guard let stream = srcObject, let session = stream.captureSession else {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      previewLayer.session = nil
      CATransaction.commit()
      return
    }

    // Attaching a session and rotating the connection mutate animatable
    // properties on the preview layer; wrap them so Core Animation doesn't
    // animate the transition (which appeared as a slide-in from the left
    // when the test run kicked off and the session first attached).
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    previewLayer.session = session

    // @ref LLP 0005#first-frame-detection — Explicitly enable the connection
    // (expo-camera pattern) and force portrait orientation. Initial enabled
    // state comes from the stream's first video track so a stream attached
    // while its track is already disabled doesn't briefly show live pixels.
    let videoTrack = stream.tracks.first(where: { $0.kind == "video" })
    let initiallyEnabled = videoTrack?.enabled ?? true
    if let connection = previewLayer.connection {
      connection.isEnabled = initiallyEnabled
      configurePreviewOrientation(connection)
    }
    // Match the visibility-hide-on-disable behaviour from setPreviewEnabled
    // so a stream attached while its track is already disabled doesn't
    // briefly show live pixels before the first toggle.
    previewLayer.isHidden = !initiallyEnabled
    CATransaction.commit()

    // @ref LLP 0003#track-enabled — Subscribe so the preview layer's
    // connection tracks future `track.enabled` toggles, not just the
    // initial state captured above.
    if let source = videoTrack?.source {
      previewSource = source
      source.registerPreview(self)
    }

    // @ref LLP 0005#first-frame-detection — Drive loadeddata off the FrameSink's
    // first sample callback. The FrameSink lives on the first video track's
    // CaptureSource (post-refactor — tracks own the source, not the stream).
    if let frameSink = videoTrack?.source?.frameSink {
      frameSink.resetFirstFrame()
      frameSink.onFirstFrame = { [weak self] in
        guard let self else { return }
        self.onDurationChange()
        self.onLoadedData()
      }
    }

    // @ref LLP 0004#srcobject-play-pause — Start the session if not running
    if !session.isRunning {
      MediaStream.sessionQueue.async {
        session.startRunning()
      }
    }
  }

  private func configurePreviewOrientation(_ connection: AVCaptureConnection) {
    if #available(iOS 17.0, *) {
      if connection.isVideoRotationAngleSupported(90) {
        connection.videoRotationAngle = 90
      }
    } else if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
  }

  func play() {
    guard let session = srcObject?.captureSession else { return }
    MediaStream.sessionQueue.async { [weak self] in
      if !session.isRunning {
        session.startRunning()
      }
      DispatchQueue.main.async {
        self?.previewLayer.connection?.isEnabled = true
        self?.onPlay()
      }
    }
  }

  // @ref LLP 0004#srcobject-play-pause — pause() stops the session
  func pause() {
    guard let session = srcObject?.captureSession else { return }
    MediaStream.sessionQueue.async { [weak self] in
      if session.isRunning {
        session.stopRunning()
      }
      DispatchQueue.main.async {
        self?.onPause()
      }
    }
  }
}
