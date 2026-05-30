import AVFoundation
import ExpoModulesCore

// @ref LLP 0005#srcObject-* — HTMLMediaElement.srcObject subset, mirrored on a
//                              native ExpoView. The TS wrapper exposes the
//                              spec-shaped surface; this class is the bridge.
// @ref LLP 0006#architecture — AVCaptureVideoPreviewLayer renders the session.
// The backing layer is the AVCaptureVideoPreviewLayer itself (via
// `+layerClass`) so React Native's style writes land on it directly. The web
// spec idiom for mirroring a preview — `transform: scaleX(-1)` on the video
// element — is honoured by intercepting React Native's writes to
// `layer.transform` and translating the effective horizontal flip into
// AVFoundation's `AVCaptureConnection.isVideoMirrored`, the canonical iOS knob
// for display-only preview mirroring. The mirror lives on the preview layer's
// own connection, so downstream consumers (FrameSink, ImageCapture,
// MediaStreamTrack.getSettings) still see un-flipped frames.

private final class MirroringPreviewLayer: AVCaptureVideoPreviewLayer {
  var onTransformWrite: (() -> Void)?

  override var transform: CATransform3D {
    didSet {
      onTransformWrite?()
    }
  }
}

internal final class VideoView: ExpoView {
  public override class var layerClass: AnyClass {
    return MirroringPreviewLayer.self
  }

  private var mirroringLayer: MirroringPreviewLayer {
    // Force-cast is safe because `+layerClass` above guarantees the layer's
    // runtime type.
    // swiftlint:disable:next force_cast
    return layer as! MirroringPreviewLayer
  }

  private var previewLayer: AVCaptureVideoPreviewLayer {
    mirroringLayer
  }

  // Opaque black overlay used to express the "disabled track shows solid
  // black frames" behaviour. We can't hide the preview layer itself any
  // more — it IS the view's backing layer, so hiding it would also hide the
  // backgroundColor we'd otherwise rely on — so we composite a black sublayer
  // on top of the video and toggle that instead.
  private lazy var disabledMaskLayer: CALayer = {
    let mask = CALayer()
    mask.backgroundColor = UIColor.black.cgColor
    mask.isHidden = true
    return mask
  }()

  // Guard for the reentrant write inside the layer callback — when we reset
  // `layer.transform` to identity, the callback fires again and we don't want
  // to overwrite a freshly-set isVideoMirrored from the recursive callback.
  private var applyingLayerTransform = false

  // Last horizontal-flip state requested by the React style. Stored so we can
  // re-apply it whenever the preview connection is (re)created via
  // `attachStream`, since `connection.isVideoMirrored` lives on the
  // AVCaptureConnection — which doesn't exist until a session is attached.
  private var pendingPreviewMirror = false
  private var previewRotationCoordinator: NSObject?
  private var previewRotationObservation: NSKeyValueObservation?
  private var currentPreviewRotationAngle: CGFloat?

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
    previewLayer.videoGravity = .resizeAspectFill
    previewLayer.needsDisplayOnBoundsChange = true
    previewLayer.addSublayer(disabledMaskLayer)

    // @ref LLP 0005#preview-mirroring — Spec idiom for mirroring a preview is
    // `transform: scaleX(-1)` on the video element. RN writes that onto
    // `layer.transform`. AVCaptureVideoPreviewLayer's video rendering uses an
    // IOSurface fast path that ignores the CALayer transform, so we translate
    // a horizontal flip in the requested transform into AVFoundation's
    // canonical `connection.isVideoMirrored` knob and reset the layer
    // transform back to identity to avoid a second flip stacking with the
    // mirrored video pixels.
    // Use a layer subclass instead of KVO so the clear-to-identity write from
    // React Native is still observed after we have already reset the backing
    // layer to identity ourselves.
    mirroringLayer.onTransformWrite = { [weak self] in
      self?.syncMirrorFromLayerTransform()
    }
  }

  deinit {
    mirroringLayer.onTransformWrite = nil
    previewRotationObservation?.invalidate()
    firstFrameObserver?.invalidate()
    let sourceToPause = detachPreviewSource()
    previewLayer.session = nil
    sourceToPause?.stopSessionForPause()
  }

  private func syncMirrorFromLayerTransform() {
    if applyingLayerTransform { return }
    let t = layer.transform
    // CATransform3D.m11 is the X-axis scale; negative means a horizontal flip
    // along the spec's `scaleX(-1)` idiom. (Other transforms like `rotate` are
    // out of scope for preview mirroring; we just check the X-scale sign.)
    let mirrored = !CATransform3DIsIdentity(t) && t.m11 < 0
    setPreviewMirroredOnMain(mirrored, resetLayerTransform: true)
  }

  private func setPreviewMirroredOnMain(_ mirrored: Bool, resetLayerTransform: Bool) {
    pendingPreviewMirror = mirrored
    applyingLayerTransform = true
    defer { applyingLayerTransform = false }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if resetLayerTransform && !CATransform3DIsIdentity(layer.transform) {
      layer.transform = CATransform3DIdentity
    }
    applyPendingMirrorToConnection()
    applyCurrentPreviewOrientation()
    CATransaction.commit()
  }

  private func applyPendingMirrorToConnection() {
    guard let connection = previewLayer.connection,
          connection.isVideoMirroringSupported else {
      return
    }
    connection.automaticallyAdjustsVideoMirroring = false
    if connection.isVideoMirrored != pendingPreviewMirror {
      connection.isVideoMirrored = pendingPreviewMirror
    }
  }

  // Test hook — returns the preview layer's connection.isEnabled value.
  // Used by `MediaStreamTrack-disabled-video` to assert the fan-out from
  // `CaptureSource.setVideoEnabled` reached the preview layer. nil if the
  // preview layer hasn't created its connection yet (no session attached).
  var previewConnectionEnabledForTesting: Bool? {
    previewLayer.connection?.isEnabled
  }

  private func detachPreviewSource() -> CaptureSource? {
    guard let source = previewSource else { return nil }
    let remainingPreviews = source.unregisterPreview(self)
    previewSource = nil
    if remainingPreviews == 0 {
      // @ref LLP 0006#concurrency — Let the capture graph cool down when no
      // preview layer is rendering it. The next <Video>.play() or
      // ImageCapture.grabFrame() request restarts the session on the
      // serialized AVFoundation queue, avoiding hot preview-layer attachment
      // on the main thread. The caller pauses only after replacing the
      // AVCaptureVideoPreviewLayer session, since AVFoundation may use an
      // internal beginConfiguration/commitConfiguration pair for that layer
      // mutation and stopRunning() cannot overlap it.
      return source
    }
    return nil
  }

  // Called by `CaptureSource.setVideoEnabled` so the preview layer's
  // separate AVCaptureConnection follows the video track's enabled state.
  // Disabling the connection alone is not enough: AVCaptureVideoPreviewLayer
  // keeps its last frame as a static image (the layer just stops repainting),
  // so a disabled track would *freeze* on the last live pixel rather than
  // going black. We composite an opaque black mask sublayer over the preview
  // so the visible result is the "solid black frames" the spec asks for.
  // CATransaction's disable-actions suppresses the implicit fade Core
  // Animation would otherwise apply.
  func setPreviewEnabled(_ enabled: Bool) {
    let apply: () -> Void = { [weak self] in
      guard let self else { return }
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      self.previewLayer.connection?.isEnabled = enabled
      self.disabledMaskLayer.isHidden = enabled
      CATransaction.commit()
    }
    if Thread.isMainThread {
      apply()
    } else {
      DispatchQueue.main.async(execute: apply)
    }
  }

  // The preview layer is the view's backing layer, so UIView's own
  // bounds/frame handling resizes the preview automatically. We still
  // resize the disabled-mask sublayer to track the bounds, and suppress Core
  // Animation implicit animations on bounds changes so the initial layout
  // doesn't slide in from the left when the screen first lays out.
  public override func layoutSubviews() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    super.layoutSubviews()
    disabledMaskLayer.frame = bounds
    CATransaction.commit()
  }

  // @ref LLP 0005#srcobject-readyState — Reset to HAVE_NOTHING; fire
  //                                       loadeddata when frames arrive.
  private func attachStream() {
    firstFrameObserver?.invalidate()
    firstFrameObserver = nil
    previewRotationObservation?.invalidate()
    previewRotationObservation = nil
    previewRotationCoordinator = nil
    currentPreviewRotationAngle = nil
    // Detach from any previous source so we don't receive stale preview-
    // enable callbacks after the stream changes.
    let sourceToPause = detachPreviewSource()

    guard let stream = srcObject, let session = stream.captureSession else {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      previewLayer.session = nil
      CATransaction.commit()
      sourceToPause?.stopSessionForPause()
      return
    }

    // Attaching a session and rotating the connection mutate animatable
    // properties on the preview layer; wrap them so Core Animation doesn't
    // animate the transition (which appeared as a slide-in from the left
    // when the test run kicked off and the session first attached).
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    previewLayer.session = session

    // @ref LLP 0006#first-frame-detection — Explicitly enable the connection
    // (expo-camera pattern). Initial enabled state comes from the stream's
    // first video track so a stream attached while its track is already
    // disabled doesn't briefly show live pixels.
    let videoTrack = stream.tracks.first(where: { $0.kind == "video" })
    let initiallyEnabled = videoTrack?.enabled ?? true
    if let connection = previewLayer.connection {
      connection.isEnabled = initiallyEnabled
    }
    // Match the disabled-mask behaviour from setPreviewEnabled so a stream
    // attached while its track is already disabled doesn't briefly show
    // live pixels before the first toggle.
    disabledMaskLayer.isHidden = initiallyEnabled
    // Honour any mirror state requested via `transform: scaleX(-1)` before
    // the session attached — `connection.isVideoMirrored` only exists once
    // the connection does.
    applyPendingMirrorToConnection()
    // @ref LLP 0006#preview-orientation-and-mirroring — Apply rotation after
    // mirroring so the last AVFoundation connection write is the orientation
    // correction for the current camera/preview-layer pair.
    if let connection = previewLayer.connection {
      configurePreviewOrientation(connection, device: videoTrack?.source?.device)
    }
    CATransaction.commit()

    // @ref LLP 0004#track-enabled — Subscribe so the preview layer's
    // connection tracks future `track.enabled` toggles, not just the
    // initial state captured above.
    if let source = videoTrack?.source {
      previewSource = source
      source.registerPreview(self)
    }
    if let sourceToPause, sourceToPause !== videoTrack?.source {
      sourceToPause.stopSessionForPause()
    }
    // @ref LLP 0006#first-frame-detection — Drive loadeddata off the FrameSink's
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

    // @ref LLP 0005#srcobject-play-pause — Start the session if not running.
    // @ref LLP 0003#gum-build-session — The stream may be returned before
    // AVFoundation has completed startRunning(), so preview attachment asks
    // the source to coalesce startup rather than touching the session here.
    videoTrack?.source?.startSessionIfNeeded()
  }

  // @ref LLP 0006#preview-orientation-and-mirroring — Use Apple's rotation
  // coordinator on iOS 17+ instead of a hard-coded portrait angle, and keep
  // that angle available so mirror changes can reapply it afterward.
  private func configurePreviewOrientation(
    _ connection: AVCaptureConnection,
    device: AVCaptureDevice?
  ) {
    if #available(iOS 17.0, *) {
      if let device {
        let coordinator = AVCaptureDevice.RotationCoordinator(
          device: device,
          previewLayer: previewLayer
        )
        previewRotationCoordinator = coordinator
        applyPreviewRotationAngle(
          coordinator.videoRotationAngleForHorizonLevelPreview,
          to: connection
        )
        previewRotationObservation = coordinator.observe(
          \.videoRotationAngleForHorizonLevelPreview,
          options: [.new]
        ) { [weak self, weak connection] coordinator, _ in
          guard let connection else { return }
          self?.applyPreviewRotationAngle(
            coordinator.videoRotationAngleForHorizonLevelPreview,
            to: connection
          )
        }
        return
      }
      if connection.isVideoRotationAngleSupported(90) {
        applyPreviewRotationAngle(90, to: connection)
      }
    } else if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
  }

  private func applyPreviewRotationAngle(
    _ angle: CGFloat,
    to connection: AVCaptureConnection
  ) {
    if #available(iOS 17.0, *), connection.isVideoRotationAngleSupported(angle) {
      currentPreviewRotationAngle = angle
      connection.videoRotationAngle = angle
    }
  }

  private func applyCurrentPreviewOrientation() {
    guard let connection = previewLayer.connection else { return }
    if #available(iOS 17.0, *), let angle = currentPreviewRotationAngle {
      if connection.isVideoRotationAngleSupported(angle) {
        connection.videoRotationAngle = angle
      }
    } else if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
  }

  func play() {
    guard let stream = srcObject else { return }
    stream.captureSource?.startSessionIfNeeded()
    DispatchQueue.main.async { [weak self] in
      self?.previewLayer.connection?.isEnabled = true
      self?.onPlay()
    }
  }

  // @ref LLP 0005#srcobject-play-pause — pause() stops the session
  func pause() {
    guard let stream = srcObject else { return }
    stream.captureSource?.stopSessionForPause()
    DispatchQueue.main.async { [weak self] in
      self?.onPause()
    }
  }
}
