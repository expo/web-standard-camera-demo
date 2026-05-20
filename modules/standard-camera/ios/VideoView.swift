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
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    previewLayer.frame = bounds
    if previewLayer.superlayer == nil {
      layer.insertSublayer(previewLayer, at: 0)
    }
  }

  // @ref LLP 0004#srcobject-readyState — Reset to HAVE_NOTHING; fire
  //                                       loadeddata when frames arrive.
  private func attachStream() {
    firstFrameObserver?.invalidate()
    firstFrameObserver = nil

    guard let stream = srcObject else {
      previewLayer.session = nil
      return
    }
    let session = stream.session

    previewLayer.session = session

    // @ref LLP 0005#first-frame-detection — Explicitly enable the connection
    // (expo-camera pattern) and force portrait orientation.
    if let connection = previewLayer.connection {
      connection.isEnabled = true
      configurePreviewOrientation(connection)
    }

    // @ref LLP 0005#first-frame-detection — Drive loadeddata off the FrameSink's
    // first sample callback. Reliable across sim and device; works whether the
    // layer is attached before or after this call.
    stream.frameSink.resetFirstFrame()
    stream.frameSink.onFirstFrame = { [weak self] in
      guard let self else { return }
      self.onDurationChange()
      self.onLoadedData()
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
    guard let session = srcObject?.session else { return }
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
    guard let session = srcObject?.session else { return }
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
