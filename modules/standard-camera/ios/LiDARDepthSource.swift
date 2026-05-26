import ARKit
import CoreImage
import CoreVideo
import Foundation

private let lidarDepthErrorDomain = "StandardCameraLiDARDepth"
private let lidarCameraPreviewWidth = 960
private let lidarCameraPreviewHeight = 720
private let lidarStartupTimeoutSeconds: TimeInterval = 5

private enum LiDARDepthSessionState: String {
  case idle
  case starting
  case running
  case interrupted
  case failed
  case stopped
}

private struct PendingLiDARStart {
  let sessionId: UInt64
  let resolve: ([String: Any]) -> Void
  let reject: (Error) -> Void
}

private func lidarDepthError(_ code: Int, _ description: String) -> NSError {
  NSError(
    domain: lidarDepthErrorDomain,
    code: code,
    userInfo: [NSLocalizedDescriptionKey: description]
  )
}

// @ref LLP 0012#native-extension-shape — Demo-only ARKit depth source. This is
// intentionally not part of the W3C MediaStream surface; it exposes native
// LiDAR data so WebGPU can render it.
final class LiDARDepthSource: NSObject, ARSessionDelegate {
  static let shared = LiDARDepthSource()

  private let session = ARSession()
  private let ciContext = CIContext(options: nil)
  private let delegateQueue = DispatchQueue(label: "standard-camera.lidar-depth.delegate")
  private let lock = NSLock()

  private var latestDepthMap: CVPixelBuffer?
  private var latestCameraImage: CVPixelBuffer?
  private var latestFrameNumber: UInt64 = 0
  private var state: LiDARDepthSessionState = .idle
  private var sessionId: UInt64 = 0
  private var lastErrorReason: String?
  private var pendingStart: PendingLiDARStart?
  private var startupTimeout: DispatchWorkItem?

  var onStateEvent: (([String: Any]) -> Void)?

  private override init() {
    super.init()
    session.delegate = self
    session.delegateQueue = delegateQueue
  }

  func capabilities() -> [String: Any] {
    let snapshot = stateSnapshot()
    #if targetEnvironment(simulator)
    return [
      "supported": false,
      "running": false,
      "state": snapshot.state.rawValue,
      "sessionId": snapshot.sessionId,
      "frameNumber": snapshot.frameNumber,
      "sceneDepth": false,
      "smoothedSceneDepth": false,
      "reason": "LiDAR scene depth is unavailable on the iOS Simulator",
    ]
    #else
    let sceneDepth = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    let smoothedSceneDepth = ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth)
    var result: [String: Any] = [
      "supported": sceneDepth || smoothedSceneDepth,
      "running": snapshot.state == .running,
      "state": snapshot.state.rawValue,
      "sessionId": snapshot.sessionId,
      "frameNumber": snapshot.frameNumber,
      "sceneDepth": sceneDepth,
      "smoothedSceneDepth": smoothedSceneDepth,
    ]
    if !(sceneDepth || smoothedSceneDepth) {
      result["reason"] = "ARKit scene depth requires a LiDAR-capable iOS device"
    } else if let reason = snapshot.reason {
      result["reason"] = reason
    }
    return result
    #endif
  }

  func start(resolve: @escaping ([String: Any]) -> Void, reject: @escaping (Error) -> Void) {
    #if targetEnvironment(simulator)
    reject(lidarDepthError(1, "LiDAR scene depth is unavailable on the iOS Simulator"))
    #else
    let sceneDepth = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    let smoothedSceneDepth = ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth)
    guard sceneDepth || smoothedSceneDepth else {
      reject(lidarDepthError(2, "ARKit scene depth requires a LiDAR-capable iOS device"))
      return
    }

    let configuration = ARWorldTrackingConfiguration()
    configuration.frameSemantics = smoothedSceneDepth ? [.smoothedSceneDepth] : [.sceneDepth]
    configuration.worldAlignment = .gravity

    var currentSessionId: UInt64 = 0
    lock.lock()
    if state == .running {
      lock.unlock()
      resolve(capabilities())
      return
    }
    if state == .starting {
      lock.unlock()
      reject(lidarDepthError(3, "LiDAR scene depth session is already starting"))
      return
    }
    sessionId &+= 1
    currentSessionId = sessionId
    latestDepthMap = nil
    latestCameraImage = nil
    latestFrameNumber = 0
    lastErrorReason = nil
    state = .starting
    pendingStart = PendingLiDARStart(sessionId: currentSessionId, resolve: resolve, reject: reject)
    startupTimeout?.cancel()
    let timeout = DispatchWorkItem { [weak self] in
      self?.failSession(
        sessionId: currentSessionId,
        error: lidarDepthError(4, "Timed out waiting for the first ARKit scene-depth frame")
      )
    }
    startupTimeout = timeout
    lock.unlock()

    DispatchQueue.main.asyncAfter(deadline: .now() + lidarStartupTimeoutSeconds, execute: timeout)
    session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
    emitStateEvent([
      "sessionId": currentSessionId,
      "state": LiDARDepthSessionState.starting.rawValue,
      "frameNumber": 0,
    ])
    #if DEBUG
    NSLog("LIDAR_DEPTH start sceneDepth=%@ smoothedSceneDepth=%@",
          sceneDepth ? "true" : "false",
          smoothedSceneDepth ? "true" : "false")
    #endif
    #endif
  }

  func stop() {
    session.pause()
    var pending: PendingLiDARStart?
    var stoppedSessionId: UInt64 = 0
    lock.lock()
    startupTimeout?.cancel()
    startupTimeout = nil
    pending = pendingStart
    pendingStart = nil
    stoppedSessionId = sessionId
    state = .stopped
    lastErrorReason = nil
    latestDepthMap = nil
    latestCameraImage = nil
    latestFrameNumber = 0
    lock.unlock()
    if let pending {
      DispatchQueue.main.async {
        pending.reject(lidarDepthError(5, "LiDAR scene depth session stopped before the first frame"))
      }
    }
    emitStateEvent([
      "sessionId": stoppedSessionId,
      "state": LiDARDepthSessionState.stopped.rawValue,
      "frameNumber": 0,
    ])
  }

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    guard let depth = frame.smoothedSceneDepth ?? frame.sceneDepth else {
      return
    }

    var pending: PendingLiDARStart?
    var shouldResolveStart = false
    var shouldEmitRunning = false
    var currentSessionId: UInt64 = 0
    lock.lock()
    guard state == .starting || state == .running || state == .interrupted else {
      lock.unlock()
      return
    }
    latestDepthMap = depth.depthMap
    latestCameraImage = frame.capturedImage
    latestFrameNumber &+= 1
    let n = latestFrameNumber
    currentSessionId = sessionId
    if state == .starting || state == .interrupted {
      state = .running
      lastErrorReason = nil
      pending = pendingStart
      pendingStart = nil
      startupTimeout?.cancel()
      startupTimeout = nil
      shouldResolveStart = pending != nil
      shouldEmitRunning = true
    }
    lock.unlock()

    if shouldResolveStart || shouldEmitRunning {
      let caps = capabilities()
      DispatchQueue.main.async { [weak self] in
        pending?.resolve(caps)
        self?.emitStateEvent([
          "sessionId": currentSessionId,
          "state": LiDARDepthSessionState.running.rawValue,
          "frameNumber": n,
        ])
      }
    }

    #if DEBUG
    if n == 1 || n % 60 == 0 {
      let depthMap = depth.depthMap
      NSLog("LIDAR_DEPTH frame=%llu size=%dx%d",
            n,
            CVPixelBufferGetWidth(depthMap),
            CVPixelBufferGetHeight(depthMap))
    }
    #endif
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    failSession(sessionId: nil, error: error)
  }

  func sessionWasInterrupted(_ session: ARSession) {
    transitionToInterrupted(reason: "ARKit scene depth session was interrupted")
  }

  func sessionInterruptionEnded(_ session: ARSession) {
    transitionFromInterrupted()
  }

  func latestFrame() -> [String: Any]? {
    lock.lock()
    let depthMap = latestDepthMap
    let cameraImage = latestCameraImage
    let frameNumber = latestFrameNumber
    lock.unlock()

    guard let depthMap else {
      return nil
    }

    CVPixelBufferLockBaseAddress(depthMap, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(depthMap, .readOnly) }

    guard CVPixelBufferGetPixelFormatType(depthMap) == kCVPixelFormatType_DepthFloat32,
          let baseAddress = CVPixelBufferGetBaseAddress(depthMap) else {
      return nil
    }

    let width = CVPixelBufferGetWidth(depthMap)
    let height = CVPixelBufferGetHeight(depthMap)
    let srcRowBytes = CVPixelBufferGetBytesPerRow(depthMap)
    let dstRowBytes = width * MemoryLayout<Float>.size

    var minDepth = Float.greatestFiniteMagnitude
    var maxDepth: Float = 0
    var sumDepth: Double = 0
    var validCount = 0
    var data = Data(count: dstRowBytes * height)

    data.withUnsafeMutableBytes { dst in
      guard let dstBase = dst.baseAddress else { return }
      for y in 0..<height {
        let srcRow = baseAddress.advanced(by: y * srcRowBytes)
        let dstRow = dstBase.advanced(by: y * dstRowBytes)
        memcpy(dstRow, srcRow, dstRowBytes)

        let values = srcRow.assumingMemoryBound(to: Float.self)
        for x in 0..<width {
          let depth = values[x]
          if depth.isFinite && depth > 0 {
            minDepth = min(minDepth, depth)
            maxDepth = max(maxDepth, depth)
            sumDepth += Double(depth)
            validCount += 1
          }
        }
      }
    }

    if validCount == 0 {
      minDepth = 0
      maxDepth = 0
    }

    var result: [String: Any] = [
      "width": width,
      "height": height,
      "depthData": data,
      "depthFormat": "r32float",
      "frameNumber": frameNumber,
      "minDepth": Double(minDepth),
      "maxDepth": Double(maxDepth),
      "meanDepth": validCount > 0 ? sumDepth / Double(validCount) : 0,
    ]
    if let cameraImage,
       let colorFrame = makeCameraPreviewFrame(from: cameraImage) {
      result["colorWidth"] = colorFrame.width
      result["colorHeight"] = colorFrame.height
      result["colorData"] = colorFrame.data
      result["colorFormat"] = "bgra8unorm"
    }
    return result
  }

  private func makeCameraPreviewFrame(from pixelBuffer: CVPixelBuffer) -> (width: Int, height: Int, data: Data)? {
    let sourceWidth = CVPixelBufferGetWidth(pixelBuffer)
    let sourceHeight = CVPixelBufferGetHeight(pixelBuffer)
    guard sourceWidth > 0, sourceHeight > 0 else {
      return nil
    }

    let dstWidth = lidarCameraPreviewWidth
    let dstHeight = lidarCameraPreviewHeight
    let rowBytes = dstWidth * 4
    var data = Data(count: rowBytes * dstHeight)
    let scale = max(
      CGFloat(dstWidth) / CGFloat(sourceWidth),
      CGFloat(dstHeight) / CGFloat(sourceHeight)
    )
    let scaledWidth = CGFloat(sourceWidth) * scale
    let scaledHeight = CGFloat(sourceHeight) * scale
    let offsetX = (CGFloat(dstWidth) - scaledWidth) / 2
    let offsetY = (CGFloat(dstHeight) - scaledHeight) / 2
    let image = CIImage(cvPixelBuffer: pixelBuffer)
      .transformed(by: CGAffineTransform(
        a: scale,
        b: 0,
        c: 0,
        d: scale,
        tx: offsetX,
        ty: offsetY
      ))
    let bounds = CGRect(x: 0, y: 0, width: dstWidth, height: dstHeight)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    data.withUnsafeMutableBytes { dst in
      guard let baseAddress = dst.baseAddress else { return }
      ciContext.render(
        image,
        toBitmap: baseAddress,
        rowBytes: rowBytes,
        bounds: bounds,
        format: .BGRA8,
        colorSpace: colorSpace
      )
    }
    return (dstWidth, dstHeight, data)
  }

  private func stateSnapshot() -> (
    state: LiDARDepthSessionState,
    sessionId: UInt64,
    frameNumber: UInt64,
    reason: String?
  ) {
    lock.lock()
    let snapshot = (
      state: state,
      sessionId: sessionId,
      frameNumber: latestFrameNumber,
      reason: lastErrorReason
    )
    lock.unlock()
    return snapshot
  }

  private func failSession(sessionId expectedSessionId: UInt64?, error: Error) {
    var pending: PendingLiDARStart?
    var failedSessionId: UInt64 = 0
    let reason = error.localizedDescription
    lock.lock()
    if let expectedSessionId, expectedSessionId != sessionId {
      lock.unlock()
      return
    }
    startupTimeout?.cancel()
    startupTimeout = nil
    pending = pendingStart
    pendingStart = nil
    failedSessionId = sessionId
    state = .failed
    lastErrorReason = reason
    latestDepthMap = nil
    latestCameraImage = nil
    lock.unlock()

    DispatchQueue.main.async { [weak self] in
      pending?.reject(error)
      self?.emitStateEvent([
        "sessionId": failedSessionId,
        "state": LiDARDepthSessionState.failed.rawValue,
        "frameNumber": self?.stateSnapshot().frameNumber ?? 0,
        "reason": reason,
      ])
    }
  }

  private func transitionToInterrupted(reason: String) {
    var interruptedSessionId: UInt64 = 0
    var frameNumber: UInt64 = 0
    lock.lock()
    guard state == .starting || state == .running else {
      lock.unlock()
      return
    }
    state = .interrupted
    lastErrorReason = reason
    interruptedSessionId = sessionId
    frameNumber = latestFrameNumber
    lock.unlock()
    emitStateEvent([
      "sessionId": interruptedSessionId,
      "state": LiDARDepthSessionState.interrupted.rawValue,
      "frameNumber": frameNumber,
      "reason": reason,
    ])
  }

  private func transitionFromInterrupted() {
    var resumedSessionId: UInt64 = 0
    var frameNumber: UInt64 = 0
    lock.lock()
    guard state == .interrupted else {
      lock.unlock()
      return
    }
    state = .starting
    lastErrorReason = nil
    resumedSessionId = sessionId
    frameNumber = latestFrameNumber
    lock.unlock()
    emitStateEvent([
      "sessionId": resumedSessionId,
      "state": LiDARDepthSessionState.starting.rawValue,
      "frameNumber": frameNumber,
    ])
  }

  private func emitStateEvent(_ event: [String: Any]) {
    DispatchQueue.main.async { [weak self] in
      self?.onStateEvent?(event)
    }
  }
}
