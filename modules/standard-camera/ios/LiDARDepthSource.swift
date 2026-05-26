import ARKit
import CoreImage
import CoreVideo
import Foundation
import UIKit

private let lidarDepthErrorDomain = "StandardCameraLiDARDepth"
private let webXRCameraPreviewWidth = 1280
private let webXRCameraPreviewHeight = 960
private let lidarStartupTimeoutSeconds: TimeInterval = 5

private enum LiDARDepthSessionState: String {
  case idle
  case starting
  case running
  case interrupted
  case failed
  case stopped
}

private enum LiDARDepthType: String {
  case raw
  case smooth
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

private let webXRIdentityMatrix: [Double] = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]

private func webXRMatrixArray(_ matrix: simd_float4x4) -> [Double] {
  [
    Double(matrix.columns.0.x), Double(matrix.columns.0.y), Double(matrix.columns.0.z), Double(matrix.columns.0.w),
    Double(matrix.columns.1.x), Double(matrix.columns.1.y), Double(matrix.columns.1.z), Double(matrix.columns.1.w),
    Double(matrix.columns.2.x), Double(matrix.columns.2.y), Double(matrix.columns.2.z), Double(matrix.columns.2.w),
    Double(matrix.columns.3.x), Double(matrix.columns.3.y), Double(matrix.columns.3.z), Double(matrix.columns.3.w),
  ]
}

private func webXRMatrixArray(_ transform: CGAffineTransform) -> [Double] {
  [
    Double(transform.a), Double(transform.b), 0, 0,
    Double(transform.c), Double(transform.d), 0, 0,
    0, 0, 1, 0,
    Double(transform.tx), Double(transform.ty), 0, 1,
  ]
}

private func selectedDepthType(
  preferredDepthType: String?,
  sceneDepth: Bool,
  smoothedSceneDepth: Bool
) -> LiDARDepthType? {
  if preferredDepthType == LiDARDepthType.raw.rawValue {
    return sceneDepth ? .raw : nil
  }
  if preferredDepthType == LiDARDepthType.smooth.rawValue {
    return smoothedSceneDepth ? .smooth : nil
  }
  return smoothedSceneDepth ? .smooth : (sceneDepth ? .raw : nil)
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
  private var latestTimestamp: TimeInterval = 0
  private var latestDepthType: LiDARDepthType = .raw
  private var latestProjectionMatrix = webXRIdentityMatrix
  private var latestViewTransform = webXRIdentityMatrix
  private var latestNormDepthBufferFromNormView = webXRIdentityMatrix
  private var latestNormCameraImageFromNormView = webXRIdentityMatrix
  private var state: LiDARDepthSessionState = .idle
  private var sessionId: UInt64 = 0
  private var activeDepthType: LiDARDepthType = .raw
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
    if let depthType = snapshot.depthType {
      result["depthType"] = depthType.rawValue
    }
    if !(sceneDepth || smoothedSceneDepth) {
      result["reason"] = "ARKit scene depth requires a LiDAR-capable iOS device"
    } else if let reason = snapshot.reason {
      result["reason"] = reason
    }
    return result
    #endif
  }

  func start(
    preferredDepthType: String? = nil,
    resolve: @escaping ([String: Any]) -> Void,
    reject: @escaping (Error) -> Void
  ) {
    #if targetEnvironment(simulator)
    reject(lidarDepthError(1, "LiDAR scene depth is unavailable on the iOS Simulator"))
    #else
    let sceneDepth = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    let smoothedSceneDepth = ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth)
    guard sceneDepth || smoothedSceneDepth else {
      reject(lidarDepthError(2, "ARKit scene depth requires a LiDAR-capable iOS device"))
      return
    }

    guard let depthType = selectedDepthType(
      preferredDepthType: preferredDepthType,
      sceneDepth: sceneDepth,
      smoothedSceneDepth: smoothedSceneDepth
    ) else {
      reject(lidarDepthError(6, "Requested ARKit scene depth type is unavailable"))
      return
    }

    let configuration = ARWorldTrackingConfiguration()
    // @ref LLP 0013#xr-request-session — `depthType` is observable, so the
    // ARKit frame semantic must match the selected WebXR depth type.
    configuration.frameSemantics = depthType == .smooth ? [.smoothedSceneDepth] : [.sceneDepth]
    configuration.worldAlignment = .gravity

    var currentSessionId: UInt64 = 0
    lock.lock()
    if state == .running {
      if let preferredDepthType, preferredDepthType != activeDepthType.rawValue {
        lock.unlock()
        reject(lidarDepthError(7, "LiDAR scene depth session is already running with \(activeDepthType.rawValue) depth"))
        return
      }
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
    latestTimestamp = 0
    latestDepthType = depthType
    activeDepthType = depthType
    latestProjectionMatrix = webXRIdentityMatrix
    latestViewTransform = webXRIdentityMatrix
    latestNormDepthBufferFromNormView = webXRIdentityMatrix
    latestNormCameraImageFromNormView = webXRIdentityMatrix
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
    NSLog("LIDAR_DEPTH start depthType=%@ sceneDepth=%@ smoothedSceneDepth=%@",
          depthType.rawValue,
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
    lock.lock()
    let requestedDepthType = activeDepthType
    lock.unlock()
    let frameDepth = requestedDepthType == .smooth ? frame.smoothedSceneDepth : frame.sceneDepth
    guard let depth = frameDepth else {
      return
    }

    // @ref LLP 0013#xr-viewer-pose — Feed XRView transform/projection from
    // ARKit camera geometry instead of fixed placeholder matrices. This is
    // currently scoped to the portrait WebXR demo viewport documented in LLP.
    let viewportSize = CGSize(width: webXRCameraPreviewWidth, height: webXRCameraPreviewHeight)
    let projectionMatrix = frame.camera.projectionMatrix(
      for: .portrait,
      viewportSize: viewportSize,
      zNear: 0.001,
      zFar: 100
    )
    // @ref LLP 0013#xr-depth-information
    // @ref LLP 0013#xr-camera-image — Map normalized XR view coordinates into
    // ARKit's normalized captured-image/depth coordinates.
    let cameraImageFromView = frame
      .displayTransform(for: .portrait, viewportSize: viewportSize)
      .inverted()

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
    // @ref LLP 0013#xr-frame-loop — JS converts ARFrame.timestamp into the
    // DOMHighResTimeStamp timeline for XR animation-frame callbacks.
    latestTimestamp = frame.timestamp
    latestDepthType = requestedDepthType
    latestProjectionMatrix = webXRMatrixArray(projectionMatrix)
    latestViewTransform = webXRMatrixArray(frame.camera.transform)
    latestNormDepthBufferFromNormView = webXRMatrixArray(cameraImageFromView)
    latestNormCameraImageFromNormView = webXRMatrixArray(cameraImageFromView)
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

  func latestFrame(
    cameraPreviewWidth: Int,
    cameraPreviewHeight: Int
  ) -> [String: Any]? {
    lock.lock()
    let depthMap = latestDepthMap
    let cameraImage = latestCameraImage
    let frameNumber = latestFrameNumber
    let timestamp = latestTimestamp
    let depthType = latestDepthType
    let projectionMatrix = latestProjectionMatrix
    let viewTransform = latestViewTransform
    let normDepthBufferFromNormView = latestNormDepthBufferFromNormView
    let normCameraImageFromNormView = latestNormCameraImageFromNormView
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
      "depthType": depthType.rawValue,
      "timestamp": timestamp,
      "projectionMatrix": projectionMatrix,
      "viewTransform": viewTransform,
      "normDepthBufferFromNormView": normDepthBufferFromNormView,
      "frameNumber": frameNumber,
      "minDepth": Double(minDepth),
      "maxDepth": Double(maxDepth),
      "meanDepth": validCount > 0 ? sumDepth / Double(validCount) : 0,
    ]
    if let cameraImage,
       let colorFrame = makeCameraPreviewFrame(
         from: cameraImage,
         width: cameraPreviewWidth,
         height: cameraPreviewHeight
       ) {
      result["colorWidth"] = colorFrame.width
      result["colorHeight"] = colorFrame.height
      result["colorData"] = colorFrame.data
      result["colorFormat"] = "bgra8unorm"
      result["normCameraImageFromNormView"] = normCameraImageFromNormView
    }
    return result
  }

  func latestWebXRFrame() -> [String: Any]? {
    // @ref LLP 0013#xr-camera-resolution — The WebXR research profile owns its
    // CPU-visible camera preview size as a private native detail.
    latestFrame(
      cameraPreviewWidth: webXRCameraPreviewWidth,
      cameraPreviewHeight: webXRCameraPreviewHeight
    )
  }

  private func makeCameraPreviewFrame(
    from pixelBuffer: CVPixelBuffer,
    width dstWidth: Int,
    height dstHeight: Int
  ) -> (width: Int, height: Int, data: Data)? {
    let sourceWidth = CVPixelBufferGetWidth(pixelBuffer)
    let sourceHeight = CVPixelBufferGetHeight(pixelBuffer)
    guard sourceWidth > 0, sourceHeight > 0, dstWidth > 0, dstHeight > 0 else {
      return nil
    }

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
    depthType: LiDARDepthType?,
    reason: String?
  ) {
    lock.lock()
    let snapshot = (
      state: state,
      sessionId: sessionId,
      frameNumber: latestFrameNumber,
      depthType: state == .idle || state == .stopped ? nil : activeDepthType,
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
