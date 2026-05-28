import ARKit
import CoreImage
import CoreVideo
import Foundation
import Metal
import UIKit

private let lidarDepthErrorDomain = "StandardCameraLiDARDepth"
// @ref LLP 0013#arkit-mapping — The WebXR research profile exposes standard
// projection matrices and normalized image transforms; raw ARKit intrinsics
// remain native implementation details.
private let webXRCameraPreviewWidth = 256
private let webXRCameraPreviewHeight = 192
private let webXRProjectionNear: Float = 0.001
private let webXRProjectionFar: Float = 100
private let lidarStartupTimeoutSeconds: TimeInterval = 5
private let webXRFrameSnapshotRetentionCount: UInt64 = 12
private let webXRMeshGeometrySignatureSampleCount = 17
private let webXRMeshPayloadMaxTrianglesPerAnchor = 900
// @ref LLP 0013#xr-depth-information — ARKit confidence stays inside the
// WebXR runtime; raw depth for panorama fusion favors high-confidence current
// LiDAR samples, while smoothed depth may keep medium-or-better samples. Very
// sparse confidence-filtered startup frames may fall back to low confidence so
// WebXR consumers can form geometry instead of stalling at zero surfels.
private let minimumRawARKitDepthConfidence = UInt8(ARConfidenceLevel.high.rawValue)
private let minimumSmoothARKitDepthConfidence = UInt8(ARConfidenceLevel.medium.rawValue)
private let minimumDepthValidPercentBeforeLowConfidenceFallback = 8.0

private func profilingNowMs() -> Double {
  ProcessInfo.processInfo.systemUptime * 1000
}

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

private struct LiDARDepthFrameSnapshot {
  let depthMap: CVPixelBuffer
  let confidenceMap: CVPixelBuffer?
  let cameraImage: CVPixelBuffer?
  let frameNumber: UInt64
  let timestamp: TimeInterval
  let depthType: LiDARDepthType
  let trackingState: String
  let worldMappingStatus: String
  let projectionMatrix: [Double]
  let projectionCameraImageResolution: [Double]
  let viewTransform: [Double]
  let normDepthBufferFromNormView: [Double]
  let normCapturedImageFromNormView: CGAffineTransform
  let meshAnchors: [ARMeshAnchor]
  let meshAnchorChangedTimes: [UUID: Double]
}

private struct CachedWebXRMeshPayload {
  let lastChangedTime: Double
  let vertices: Data
  let normals: Data?
  let indices: Data
  let vertexCount: Int
  let indexCount: Int
  let sourceVertexCount: Int
  let sourceIndexCount: Int
}

private struct WebXRGeometrySourceSignature: Equatable {
  let bufferAddress: UInt
  let componentsPerVector: Int
  let count: Int
  let format: Int
  let offset: Int
  let sampleHash: UInt64
  let stride: Int
}

private struct WebXRGeometryElementSignature: Equatable {
  let bufferAddress: UInt
  let bytesPerIndex: Int
  let count: Int
  let indexCountPerPrimitive: Int
  let primitiveType: Int
  let sampleHash: UInt64
}

private struct WebXRMeshGeometrySignature: Equatable {
  let faces: WebXRGeometryElementSignature
  let normals: WebXRGeometrySourceSignature
  let vertices: WebXRGeometrySourceSignature
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

private func webXRProjectionMatrix(
  camera: ARCamera,
  depthMap: CVPixelBuffer,
  zNear: Float = webXRProjectionNear,
  zFar: Float = webXRProjectionFar
) -> simd_float4x4 {
  // @ref LLP 0013#arkit-mapping — ARKit's point-cloud guidance positions
  // scene-depth samples from camera intrinsics. Convert those intrinsics into a
  // WebXR/OpenGL-style projection matrix so JS still consumes XRViewGeometry
  // instead of raw ARKit intrinsics.
  let depthWidth = Float(CVPixelBufferGetWidth(depthMap))
  let depthHeight = Float(CVPixelBufferGetHeight(depthMap))
  let imageWidth = Float(camera.imageResolution.width)
  let imageHeight = Float(camera.imageResolution.height)
  let intrinsics = camera.intrinsics
  guard depthWidth > 0,
        depthHeight > 0,
        imageWidth > 0,
        imageHeight > 0,
        zFar > zNear else {
    return camera.projectionMatrix
  }

  let scaleX = depthWidth / imageWidth
  let scaleY = depthHeight / imageHeight
  let fx = intrinsics.columns.0.x * scaleX
  let fy = intrinsics.columns.1.y * scaleY
  let cx = intrinsics.columns.2.x * scaleX
  let cy = intrinsics.columns.2.y * scaleY
  guard fx.isFinite,
        fy.isFinite,
        cx.isFinite,
        cy.isFinite,
        fx > 0,
        fy > 0 else {
    return camera.projectionMatrix
  }

  let zRange = zFar - zNear
  // WebXR normalized depth coordinates address the depth-buffer square, where
  // `(column + 0.5) / width` is the center of a texel. ARKit's point-cloud
  // sample reconstructs from integer depth pixel centers. Shift the
  // intrinsics-derived principal point by half a depth pixel so the standard
  // projection matrix and `normDepthBufferFromNormView` agree on the ray for a
  // sampled WebXR depth texel, without exposing raw intrinsics to JS.
  let webXRCx = cx + 0.5
  let webXRCy = cy + 0.5

  return simd_float4x4(columns: (
    SIMD4<Float>(2 * fx / depthWidth, 0, 0, 0),
    SIMD4<Float>(0, 2 * fy / depthHeight, 0, 0),
    SIMD4<Float>(1 - 2 * webXRCx / depthWidth, 2 * webXRCy / depthHeight - 1, -(zFar + zNear) / zRange, -1),
    SIMD4<Float>(0, 0, -(2 * zFar * zNear) / zRange, 0)
  ))
}

private func webXRMatrixArray(_ transform: CGAffineTransform) -> [Double] {
  [
    Double(transform.a), Double(transform.b), 0, 0,
    Double(transform.c), Double(transform.d), 0, 0,
    0, 0, 1, 0,
    Double(transform.tx), Double(transform.ty), 0, 1,
  ]
}

private func concatenating(_ first: CGAffineTransform, then second: CGAffineTransform) -> CGAffineTransform {
  CGAffineTransform(
    a: second.a * first.a + second.c * first.b,
    b: second.b * first.a + second.d * first.b,
    c: second.a * first.c + second.c * first.d,
    d: second.b * first.c + second.d * first.d,
    tx: second.a * first.tx + second.c * first.ty + second.tx,
    ty: second.b * first.tx + second.d * first.ty + second.ty
  )
}

private func normalizedPreviewFromCapturedImageTransform(
  sourceWidth: Int,
  sourceHeight: Int,
  destinationWidth: Int,
  destinationHeight: Int
) -> CGAffineTransform {
  guard sourceWidth > 0, sourceHeight > 0, destinationWidth > 0, destinationHeight > 0 else {
    return .identity
  }
  let scale = max(
    CGFloat(destinationWidth) / CGFloat(sourceWidth),
    CGFloat(destinationHeight) / CGFloat(sourceHeight)
  )
  let scaledWidth = CGFloat(sourceWidth) * scale
  let scaledHeight = CGFloat(sourceHeight) * scale
  let offsetX = (CGFloat(destinationWidth) - scaledWidth) / 2
  let offsetY = (CGFloat(destinationHeight) - scaledHeight) / 2
  return CGAffineTransform(
    a: CGFloat(sourceWidth) * scale / CGFloat(destinationWidth),
    b: 0,
    c: 0,
    d: CGFloat(sourceHeight) * scale / CGFloat(destinationHeight),
    tx: offsetX / CGFloat(destinationWidth),
    ty: offsetY / CGFloat(destinationHeight)
  )
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

// @ref LLP 0013#xr-viewer-pose — JS maps non-normal ARKit tracking to
// WebXR's null viewer-pose result instead of exposing app-facing ARKit state.
private func webXRTrackingState(_ trackingState: ARCamera.TrackingState) -> String {
  switch trackingState {
  case .normal:
    return "normal"
  case .limited(_):
    return "limited"
  case .notAvailable:
    return "notAvailable"
  @unknown default:
    return "unknown"
  }
}

private func webXRWorldMappingStatus(_ status: ARFrame.WorldMappingStatus) -> String {
  switch status {
  case .notAvailable:
    return "notAvailable"
  case .limited:
    return "limited"
  case .extending:
    return "extending"
  case .mapped:
    return "mapped"
  @unknown default:
    return "unknown"
  }
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
  private var latestARFrameNumber: UInt64 = 0
  private var latestDepthFrameARFrameNumber: UInt64 = 0
  private var latestTimestamp: TimeInterval = 0
  private var latestARFrameTimestamp: TimeInterval = 0
  private var latestDepthType: LiDARDepthType = .raw
  private var latestARFrameRawDepthAvailable = false
  private var latestARFrameSmoothDepthAvailable = false
  private var latestDepthMissRequestedType: LiDARDepthType = .raw
  private var latestDepthMissRawDepthAvailable = false
  private var latestDepthMissSmoothDepthAvailable = false
  private var latestProjectionMatrix = webXRIdentityMatrix
  private var latestViewTransform = webXRIdentityMatrix
  private var latestNormDepthBufferFromNormView = webXRIdentityMatrix
  private var latestNormCapturedImageFromNormView = CGAffineTransform.identity
  private var frameSnapshots: [UInt64: LiDARDepthFrameSnapshot] = [:]
  private var meshAnchors: [UUID: ARMeshAnchor] = [:]
  private var meshAnchorChangedTimes: [UUID: Double] = [:]
  private var meshAnchorGeometrySignatures: [UUID: WebXRMeshGeometrySignature] = [:]
  private var meshPayloadCache: [UUID: CachedWebXRMeshPayload] = [:]
  private var state: LiDARDepthSessionState = .idle
  private var sessionId: UInt64 = 0
  private var activeDepthType: LiDARDepthType = .raw
  private var activeMeshDetection = false
  private var totalDepthMisses: UInt64 = 0
  private var consecutiveDepthMisses: UInt64 = 0
  private var requestedDepthMissesWithAlternateDepth: UInt64 = 0
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
      "meshDetection": false,
      "reason": "LiDAR scene depth is unavailable on the iOS Simulator",
    ]
    #else
    let sceneDepth = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    let smoothedSceneDepth = ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth)
    let meshDetection = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    var result: [String: Any] = [
      "supported": sceneDepth || smoothedSceneDepth,
      "running": snapshot.state == .running,
      "state": snapshot.state.rawValue,
      "sessionId": snapshot.sessionId,
      "frameNumber": snapshot.frameNumber,
      "sceneDepth": sceneDepth,
      "smoothedSceneDepth": smoothedSceneDepth,
      "meshDetection": meshDetection,
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
    enableMeshDetection: Bool = false,
    resolve: @escaping ([String: Any]) -> Void,
    reject: @escaping (Error) -> Void
  ) {
    #if targetEnvironment(simulator)
    reject(lidarDepthError(1, "LiDAR scene depth is unavailable on the iOS Simulator"))
    #else
    let sceneDepth = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    let smoothedSceneDepth = ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth)
    let meshDetection = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    guard sceneDepth || smoothedSceneDepth else {
      reject(lidarDepthError(2, "ARKit scene depth requires a LiDAR-capable iOS device"))
      return
    }
    if enableMeshDetection && !meshDetection {
      reject(lidarDepthError(8, "ARKit scene reconstruction mesh is unavailable"))
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
    if enableMeshDetection {
      // @ref LLP 0013#xr-mesh-detection — Mesh detection is requested through
      // WebXR, then backed by ARKit scene reconstruction without exposing
      // ARMeshAnchor or ARPlaneAnchor APIs to application code.
      configuration.sceneReconstruction = .mesh
      configuration.planeDetection = [.horizontal, .vertical]
    }

    var currentSessionId: UInt64 = 0
    lock.lock()
    if state == .running {
      if let preferredDepthType, preferredDepthType != activeDepthType.rawValue {
        lock.unlock()
        reject(lidarDepthError(7, "LiDAR scene depth session is already running with \(activeDepthType.rawValue) depth"))
        return
      }
      if enableMeshDetection && !activeMeshDetection {
        lock.unlock()
        reject(lidarDepthError(9, "LiDAR scene depth session is already running without mesh detection"))
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
    latestARFrameNumber = 0
    latestDepthFrameARFrameNumber = 0
    latestTimestamp = 0
    latestARFrameTimestamp = 0
    latestDepthType = depthType
    latestARFrameRawDepthAvailable = false
    latestARFrameSmoothDepthAvailable = false
    latestDepthMissRequestedType = depthType
    latestDepthMissRawDepthAvailable = false
    latestDepthMissSmoothDepthAvailable = false
    activeDepthType = depthType
    latestProjectionMatrix = webXRIdentityMatrix
    latestViewTransform = webXRIdentityMatrix
    latestNormDepthBufferFromNormView = webXRIdentityMatrix
    latestNormCapturedImageFromNormView = .identity
    frameSnapshots.removeAll()
    meshAnchors.removeAll()
    meshAnchorChangedTimes.removeAll()
    meshAnchorGeometrySignatures.removeAll()
    meshPayloadCache.removeAll()
    lastErrorReason = nil
    totalDepthMisses = 0
    consecutiveDepthMisses = 0
    requestedDepthMissesWithAlternateDepth = 0
    state = .starting
    activeMeshDetection = enableMeshDetection
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
    var runOptions: ARSession.RunOptions = [.resetTracking, .removeExistingAnchors]
    if enableMeshDetection {
      runOptions.insert(.resetSceneReconstruction)
    }
    session.run(configuration, options: runOptions)
    emitStateEvent([
      "sessionId": currentSessionId,
      "state": LiDARDepthSessionState.starting.rawValue,
      "frameNumber": 0,
    ])
    #if DEBUG
    NSLog("LIDAR_DEPTH start depthType=%@ sceneDepth=%@ smoothedSceneDepth=%@ meshDetection=%@",
          depthType.rawValue,
          sceneDepth ? "true" : "false",
          smoothedSceneDepth ? "true" : "false",
          enableMeshDetection ? "true" : "false")
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
    latestARFrameNumber = 0
    latestDepthFrameARFrameNumber = 0
    latestARFrameTimestamp = 0
    latestARFrameRawDepthAvailable = false
    latestARFrameSmoothDepthAvailable = false
    latestDepthMissRequestedType = activeDepthType
    latestDepthMissRawDepthAvailable = false
    latestDepthMissSmoothDepthAvailable = false
    totalDepthMisses = 0
    consecutiveDepthMisses = 0
    requestedDepthMissesWithAlternateDepth = 0
    frameSnapshots.removeAll()
    meshAnchors.removeAll()
    meshAnchorChangedTimes.removeAll()
    meshAnchorGeometrySignatures.removeAll()
    meshPayloadCache.removeAll()
    activeMeshDetection = false
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
    let active = state == .starting || state == .running || state == .interrupted
    let requestedDepthType = activeDepthType
    var arFrameNumber = latestARFrameNumber
    if active {
      latestARFrameNumber &+= 1
      arFrameNumber = latestARFrameNumber
      latestARFrameTimestamp = frame.timestamp
    }
    lock.unlock()
    guard active else {
      return
    }
    let rawSceneDepth = frame.sceneDepth
    let smoothedSceneDepth = frame.smoothedSceneDepth
    let rawDepthAvailable = rawSceneDepth != nil
    let smoothDepthAvailable = smoothedSceneDepth != nil
    let frameDepth = requestedDepthType == .smooth ? smoothedSceneDepth : rawSceneDepth
    guard let depth = frameDepth else {
      lock.lock()
      guard state == .starting || state == .running || state == .interrupted else {
        lock.unlock()
        return
      }
      let alternateDepthAvailable = requestedDepthType == .smooth ? rawDepthAvailable : smoothDepthAvailable
      totalDepthMisses &+= 1
      consecutiveDepthMisses &+= 1
      if alternateDepthAvailable {
        requestedDepthMissesWithAlternateDepth &+= 1
      }
      // @ref LLP 0020#testing-and-validation — Preserve whether the requested
      // ARKit depth semantic was missing while the alternate raw/smoothed
      // semantic was present, so one-frame scans can be diagnosed from logs.
      latestARFrameRawDepthAvailable = rawDepthAvailable
      latestARFrameSmoothDepthAvailable = smoothDepthAvailable
      latestDepthMissRequestedType = requestedDepthType
      latestDepthMissRawDepthAvailable = rawDepthAvailable
      latestDepthMissSmoothDepthAvailable = smoothDepthAvailable
      lock.unlock()
      return
    }

    // @ref LLP 0013#xr-viewer-pose
    // @ref LLP 0013#xr-depth-information — Feed XRViewGeometry from the
    // ARKit depth/camera plane so WebXR unprojection uses the full scene-depth
    // buffer instead of a display-cropped portrait viewport.
    let projectionMatrix = webXRProjectionMatrix(camera: frame.camera, depthMap: depth.depthMap)
    // @ref LLP 0013#xr-camera-image — Scene-depth normalized coordinates are
    // aligned with the captured-image plane; the returned CPU camera preview
    // composes this identity with its native crop/scale.
    let cameraImageFromView = CGAffineTransform.identity

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
    latestDepthFrameARFrameNumber = arFrameNumber
    consecutiveDepthMisses = 0
    latestARFrameRawDepthAvailable = rawDepthAvailable
    latestARFrameSmoothDepthAvailable = smoothDepthAvailable
    let n = latestFrameNumber
    let projectionMatrixArray = webXRMatrixArray(projectionMatrix)
    let projectionCameraImageResolution = [
      Double(frame.camera.imageResolution.width),
      Double(frame.camera.imageResolution.height),
    ]
    let viewTransformArray = webXRMatrixArray(frame.camera.transform)
    let normDepthBufferFromNormViewArray = webXRMatrixArray(cameraImageFromView)
    let trackingState = webXRTrackingState(frame.camera.trackingState)
    let worldMappingStatus = webXRWorldMappingStatus(frame.worldMappingStatus)
    let frameMeshAnchors = activeMeshDetection ? Array(meshAnchors.values) : []
    let frameMeshAnchorChangedTimes = activeMeshDetection ? meshAnchorChangedTimes : [:]
    // @ref LLP 0013#xr-frame-loop — JS converts ARFrame.timestamp into the
    // DOMHighResTimeStamp timeline for XR animation-frame callbacks.
    latestTimestamp = frame.timestamp
    latestDepthType = requestedDepthType
    latestProjectionMatrix = projectionMatrixArray
    latestViewTransform = viewTransformArray
    latestNormDepthBufferFromNormView = normDepthBufferFromNormViewArray
    latestNormCapturedImageFromNormView = cameraImageFromView
    // @ref LLP 0013#xr-frame-loop — Keep a tiny frame-scoped native cache so
    // WebXR accessors can lazily fetch bytes for this XRFrame without copying
    // depth/camera payloads for frames rejected by JS keyframe policy.
    frameSnapshots[n] = LiDARDepthFrameSnapshot(
      depthMap: depth.depthMap,
      confidenceMap: depth.confidenceMap,
      cameraImage: frame.capturedImage,
      frameNumber: n,
      timestamp: frame.timestamp,
      depthType: requestedDepthType,
      trackingState: trackingState,
      worldMappingStatus: worldMappingStatus,
      projectionMatrix: projectionMatrixArray,
      projectionCameraImageResolution: projectionCameraImageResolution,
      viewTransform: viewTransformArray,
      normDepthBufferFromNormView: normDepthBufferFromNormViewArray,
      normCapturedImageFromNormView: cameraImageFromView,
      meshAnchors: frameMeshAnchors,
      meshAnchorChangedTimes: frameMeshAnchorChangedTimes
    )
    // @ref LLP 0020#performance-constraints — WebXR frame metadata is cheap,
    // but depth/camera payloads are fetched lazily after JS pose and keyframe
    // gates. Keep enough recent native snapshots that a slow scan frame can
    // still resolve its standard `XRCPUDepthInformation.data` / `XRCamera`
    // payload without widening the app-facing API.
    let minimumSnapshotFrame = n > webXRFrameSnapshotRetentionCount ? n - webXRFrameSnapshotRetentionCount : 0
    for key in frameSnapshots.keys where key < minimumSnapshotFrame {
      frameSnapshots.removeValue(forKey: key)
    }
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

  func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
    updateMeshAnchors(anchors)
  }

  func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
    updateMeshAnchors(anchors)
  }

  func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
    lock.lock()
    for anchor in anchors {
      guard let meshAnchor = anchor as? ARMeshAnchor else {
        continue
      }
      meshAnchors.removeValue(forKey: meshAnchor.identifier)
      meshAnchorChangedTimes.removeValue(forKey: meshAnchor.identifier)
      meshAnchorGeometrySignatures.removeValue(forKey: meshAnchor.identifier)
      meshPayloadCache.removeValue(forKey: meshAnchor.identifier)
    }
    lock.unlock()
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
    let snapshot = frameSnapshots[latestFrameNumber]
    let arFrameNumber = latestARFrameNumber
    let depthFrameARFrameNumber = latestDepthFrameARFrameNumber
    let arFrameTimestamp = latestARFrameTimestamp
    let depthMissCount = totalDepthMisses
    let currentConsecutiveDepthMisses = consecutiveDepthMisses
    let alternateDepthMissCount = requestedDepthMissesWithAlternateDepth
    let diagnosticDepthType = activeDepthType
    let rawDepthAvailable = latestARFrameRawDepthAvailable
    let smoothDepthAvailable = latestARFrameSmoothDepthAvailable
    let depthMissRequestedType = latestDepthMissRequestedType
    let depthMissRawAvailable = latestDepthMissRawDepthAvailable
    let depthMissSmoothAvailable = latestDepthMissSmoothDepthAvailable
    lock.unlock()
    let latestDepthMissAlternateAvailable: Bool
    if depthMissRequestedType == .smooth {
      latestDepthMissAlternateAvailable = depthMissRawAvailable
    } else {
      latestDepthMissAlternateAvailable = depthMissSmoothAvailable
    }

    guard let snapshot else {
      if arFrameNumber > 0 || depthMissCount > 0 || currentConsecutiveDepthMisses > 0 {
        // @ref LLP 0020#testing-and-validation — Before the first scene-depth
        // snapshot exists, WebXR must not deliver an XRFrame. Still return a
        // non-deliverable frame-number-zero diagnostic so JS logs can distinguish
        // "ARKit is not producing frames" from "ARKit frames have no scene depth".
        return [
          "width": 0,
          "height": 0,
          "depthFormat": "r32float",
          "depthType": diagnosticDepthType.rawValue,
          "timestamp": 0,
          "trackingState": "unknown",
          "worldMappingStatus": "unknown",
          "projectionMatrix": webXRIdentityMatrix,
          "projectionCameraImageResolution": [0, 0],
          "viewTransform": webXRIdentityMatrix,
          "normDepthBufferFromNormView": webXRIdentityMatrix,
          "arFrameNumber": arFrameNumber,
          "arFrameTimestamp": arFrameTimestamp,
          "consecutiveDepthMisses": currentConsecutiveDepthMisses,
          "depthFrameArFrameNumber": depthFrameARFrameNumber,
          "depthMisses": depthMissCount,
          "latestDepthMissRequestedType": depthMissRequestedType.rawValue,
          "latestDepthMissRawDepthAvailable": depthMissRawAvailable,
          "latestDepthMissSmoothDepthAvailable": depthMissSmoothAvailable,
          "frameNumber": 0,
          "minDepth": 0,
          "maxDepth": 0,
          "meanDepth": 0,
          "rawDepthAvailable": rawDepthAvailable,
          "requestedDepthMissesWithAlternateDepth": alternateDepthMissCount,
          "requestedDepthMissingButAlternateAvailable": latestDepthMissAlternateAvailable,
          "requestedDepthType": diagnosticDepthType.rawValue,
          "smoothDepthAvailable": smoothDepthAvailable,
        ]
      }
      return nil
    }

    let width = CVPixelBufferGetWidth(snapshot.depthMap)
    let height = CVPixelBufferGetHeight(snapshot.depthMap)
    var result: [String: Any] = [
      "width": width,
      "height": height,
      "depthFormat": "r32float",
      "depthType": snapshot.depthType.rawValue,
      "timestamp": snapshot.timestamp,
      "trackingState": snapshot.trackingState,
      "worldMappingStatus": snapshot.worldMappingStatus,
      "projectionMatrix": snapshot.projectionMatrix,
      "projectionCameraImageResolution": snapshot.projectionCameraImageResolution,
      "viewTransform": snapshot.viewTransform,
      "normDepthBufferFromNormView": snapshot.normDepthBufferFromNormView,
      "arFrameNumber": arFrameNumber,
      "arFrameTimestamp": arFrameTimestamp,
      "consecutiveDepthMisses": currentConsecutiveDepthMisses,
      "depthFrameArFrameNumber": depthFrameARFrameNumber,
      "depthMisses": depthMissCount,
      "latestDepthMissRequestedType": depthMissRequestedType.rawValue,
      "latestDepthMissRawDepthAvailable": depthMissRawAvailable,
      "latestDepthMissSmoothDepthAvailable": depthMissSmoothAvailable,
      "frameNumber": snapshot.frameNumber,
      "minDepth": 0,
      "maxDepth": 0,
      "meanDepth": 0,
      "rawDepthAvailable": rawDepthAvailable,
      "requestedDepthMissesWithAlternateDepth": alternateDepthMissCount,
      "requestedDepthMissingButAlternateAvailable": latestDepthMissAlternateAvailable,
      "requestedDepthType": diagnosticDepthType.rawValue,
      "smoothDepthAvailable": smoothDepthAvailable,
    ]
    if let cameraImage = snapshot.cameraImage {
      let capturedImageWidth = CVPixelBufferGetWidth(cameraImage)
      let capturedImageHeight = CVPixelBufferGetHeight(cameraImage)
      // @ref LLP 0013#xr-camera-image
      // @ref LLP 0017#native-camera-alignment — `normCameraImageFromNormView`
      // must describe the returned `XRCamera` image. The first transform maps
      // XR view coordinates into the captured-image/depth plane; compose it
      // with the preview crop/scale used by the CPU-visible camera frame.
      let previewFromCapturedImage = normalizedPreviewFromCapturedImageTransform(
        sourceWidth: capturedImageWidth,
        sourceHeight: capturedImageHeight,
        destinationWidth: cameraPreviewWidth,
        destinationHeight: cameraPreviewHeight
      )
      let previewFromNormView = concatenating(snapshot.normCapturedImageFromNormView, then: previewFromCapturedImage)
      result["capturedImageWidth"] = capturedImageWidth
      result["capturedImageHeight"] = capturedImageHeight
      result["colorWidth"] = cameraPreviewWidth
      result["colorHeight"] = cameraPreviewHeight
      result["colorFormat"] = "bgra8unorm"
      result["normCameraImageFromNormView"] = webXRMatrixArray(previewFromNormView)
    }
    var meshVertexCount = 0
    var meshTriangleCount = 0
    var meshSummaries: [[String: Any]] = []
    for meshAnchor in snapshot.meshAnchors {
      let summary = makeMeshSummary(
        from: meshAnchor,
        lastChangedTime: snapshot.meshAnchorChangedTimes[meshAnchor.identifier] ?? snapshot.timestamp * 1000
      )
      meshVertexCount += summary.vertexCount
      meshTriangleCount += summary.triangleCount
      meshSummaries.append(summary.payload)
    }
    result["detectedMeshes"] = meshSummaries
    result["meshAnchorCount"] = snapshot.meshAnchors.count
    result["meshTriangleCount"] = meshTriangleCount
    result["meshVertexCount"] = meshVertexCount
    return result
  }

  func webXRFramePayload(
    frameNumber: UInt64,
    includeDepthData: Bool,
    includeCameraImage: Bool
  ) -> [String: Any]? {
    let payloadStartMs = profilingNowMs()
    lock.lock()
    let snapshot = frameSnapshots[frameNumber]
    lock.unlock()

    guard let snapshot else {
      return nil
    }

    var result: [String: Any] = [
      "frameNumber": snapshot.frameNumber,
    ]
    if includeDepthData {
      let depthStartMs = profilingNowMs()
      let confidenceThreshold: UInt8
      if snapshot.depthType == .raw {
        confidenceThreshold = minimumRawARKitDepthConfidence
      } else {
        confidenceThreshold = minimumSmoothARKitDepthConfidence
      }
      guard var depthPayload = makeDepthData(
        from: snapshot.depthMap,
        confidenceMap: snapshot.confidenceMap,
        confidenceThreshold: confidenceThreshold
      ) else {
        return nil
      }
      var confidenceFallbackUsed = false
      var confidenceFallbackReason: String?
      let depthPixelCount = CVPixelBufferGetWidth(snapshot.depthMap) * CVPixelBufferGetHeight(snapshot.depthMap)
      let minimumDepthValidCount = Int(
        (Double(max(depthPixelCount, 0)) * minimumDepthValidPercentBeforeLowConfidenceFallback / 100).rounded(.up)
      )
      let confidenceFilteredDepthTooSparse = depthPayload.validDepthCount < max(1, minimumDepthValidCount)
      if confidenceFilteredDepthTooSparse &&
          depthPayload.confidenceFilteredDepthCount > 0,
          let fallbackPayload = makeDepthData(
            from: snapshot.depthMap,
            confidenceMap: snapshot.confidenceMap,
            confidenceThreshold: UInt8(ARConfidenceLevel.low.rawValue)
          ) {
        // @ref LLP 0013#xr-depth-information — Keep confidence maps internal,
        // but avoid starving WebXR scene-depth consumers when ARKit labels a
        // frame as mostly low confidence while still providing positive metric
        // depth values. Sparse nonzero high/medium-confidence islands are not
        // enough for the panorama sampler to form post-first keyframes.
        let strictConfidenceLabel = snapshot.depthType == .raw ? "high" : "medium"
        confidenceFallbackReason = depthPayload.validDepthCount == 0
          ? "empty-\(strictConfidenceLabel)-confidence"
          : "sparse-\(strictConfidenceLabel)-confidence"
        depthPayload = fallbackPayload
        confidenceFallbackUsed = true
      }
      result["depthCopyMs"] = profilingNowMs() - depthStartMs
      result["depthData"] = depthPayload.data
      result["confidenceMapUsed"] = depthPayload.confidenceMapUsed
      result["confidenceThreshold"] = depthPayload.confidenceThreshold
      result["confidenceFallbackUsed"] = confidenceFallbackUsed
      if let confidenceFallbackReason {
        result["confidenceFallbackReason"] = confidenceFallbackReason
      }
      result["confidenceFilteredDepthCount"] = depthPayload.confidenceFilteredDepthCount
      result["highConfidenceDepthCount"] = depthPayload.highConfidenceDepthCount
      result["minDepth"] = Double(depthPayload.minDepth)
      result["maxDepth"] = Double(depthPayload.maxDepth)
      result["mediumConfidenceDepthCount"] = depthPayload.mediumConfidenceDepthCount
      result["meanDepth"] = depthPayload.meanDepth
      result["validDepthCount"] = depthPayload.validDepthCount
      result["invalidDepthCount"] = depthPayload.invalidDepthCount
      result["lowConfidenceDepthCount"] = depthPayload.lowConfidenceDepthCount
    }
    if includeCameraImage {
      let cameraStartMs = profilingNowMs()
      guard let cameraImage = snapshot.cameraImage,
            let colorFrame = makeCameraPreviewFrame(
              from: cameraImage,
              width: webXRCameraPreviewWidth,
              height: webXRCameraPreviewHeight
            ) else {
        return nil
      }
      result["cameraPreviewMs"] = profilingNowMs() - cameraStartMs
      result["colorData"] = colorFrame.data
      result["colorFormat"] = "bgra8unorm"
      result["cameraPreviewPath"] = colorFrame.path
    }
    result["payloadMs"] = profilingNowMs() - payloadStartMs
    return result
  }

  func webXRFrameMeshes(frameNumber: UInt64) -> [[String: Any]]? {
    lock.lock()
    let snapshot = frameSnapshots[frameNumber]
    lock.unlock()

    guard let snapshot else {
      return nil
    }
    if snapshot.meshAnchors.isEmpty {
      return []
    }
    return snapshot.meshAnchors.compactMap { meshAnchor in
      makeMeshPayload(
        from: meshAnchor,
        lastChangedTime: snapshot.meshAnchorChangedTimes[meshAnchor.identifier] ?? snapshot.timestamp * 1000
      )
    }
  }

  func latestWebXRFrame() -> [String: Any]? {
    // @ref LLP 0013#xr-camera-resolution — The WebXR research profile owns its
    // CPU-visible camera preview size as a private native detail.
    latestFrame(
      cameraPreviewWidth: webXRCameraPreviewWidth,
      cameraPreviewHeight: webXRCameraPreviewHeight
    )
  }

  private func makeDepthData(
    from depthMap: CVPixelBuffer,
    confidenceMap: CVPixelBuffer?,
    confidenceThreshold: UInt8
  ) -> (
    data: Data,
    confidenceFilteredDepthCount: Int,
    confidenceMapUsed: Bool,
    confidenceThreshold: UInt8,
    highConfidenceDepthCount: Int,
    minDepth: Float,
    maxDepth: Float,
    mediumConfidenceDepthCount: Int,
    meanDepth: Double,
    validDepthCount: Int,
    invalidDepthCount: Int,
    lowConfidenceDepthCount: Int
  )? {
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
    let confidenceUsable: Bool
    if let confidenceMap {
      confidenceUsable = CVPixelBufferGetPixelFormatType(confidenceMap) == kCVPixelFormatType_OneComponent8 &&
        CVPixelBufferGetWidth(confidenceMap) == width &&
        CVPixelBufferGetHeight(confidenceMap) == height
    } else {
      confidenceUsable = false
    }
    var confidenceBaseAddress: UnsafeMutableRawPointer?
    var confidenceRowBytes = 0
    var confidenceLocked = false
    if confidenceUsable, let confidenceMap {
      let lockResult = CVPixelBufferLockBaseAddress(confidenceMap, .readOnly)
      if lockResult == kCVReturnSuccess {
        confidenceLocked = true
        confidenceBaseAddress = CVPixelBufferGetBaseAddress(confidenceMap)
        confidenceRowBytes = CVPixelBufferGetBytesPerRow(confidenceMap)
      }
    }
    defer {
      if confidenceLocked, let confidenceMap {
        CVPixelBufferUnlockBaseAddress(confidenceMap, .readOnly)
      }
    }

    var minDepth = Float.greatestFiniteMagnitude
    var maxDepth: Float = 0
    var sumDepth: Double = 0
    var validCount = 0
    var invalidCount = 0
    var lowConfidenceCount = 0
    var mediumConfidenceCount = 0
    var highConfidenceCount = 0
    var confidenceFilteredCount = 0
    var data = Data(count: dstRowBytes * height)

    data.withUnsafeMutableBytes { dst in
      guard let dstBase = dst.baseAddress else { return }
      for y in 0..<height {
        let srcRow = baseAddress.advanced(by: y * srcRowBytes)
        let dstRow = dstBase.advanced(by: y * dstRowBytes)
        let values = srcRow.assumingMemoryBound(to: Float.self)
        let dstValues = dstRow.assumingMemoryBound(to: Float.self)
        let confidenceValues = confidenceBaseAddress?
          .advanced(by: y * confidenceRowBytes)
          .assumingMemoryBound(to: UInt8.self)
        for x in 0..<width {
          // @ref LLP 0013#xr-depth-information — WebXR encodes invalid depth
          // as 0; ARKit confidence-filtered scene-depth samples are treated
          // as unavailable without exposing a non-standard confidence map.
          let confidence = confidenceValues?[x]
          if let confidence {
            if confidence <= 0 {
              lowConfidenceCount += 1
            } else if confidence == 1 {
              mediumConfidenceCount += 1
            } else {
              highConfidenceCount += 1
            }
          }
          let confidenceAccepted = confidence.map { $0 >= confidenceThreshold } ?? true
          if confidence != nil && !confidenceAccepted {
            confidenceFilteredCount += 1
          }
          let depth = confidenceAccepted ? values[x] : 0
          dstValues[x] = depth
          if depth.isFinite && depth > 0 {
            minDepth = min(minDepth, depth)
            maxDepth = max(maxDepth, depth)
            sumDepth += Double(depth)
            validCount += 1
          } else {
            invalidCount += 1
          }
        }
      }
    }

    if validCount == 0 {
      minDepth = 0
      maxDepth = 0
    }

    return (
      data: data,
      confidenceFilteredDepthCount: confidenceFilteredCount,
      confidenceMapUsed: confidenceBaseAddress != nil,
      confidenceThreshold: confidenceThreshold,
      highConfidenceDepthCount: highConfidenceCount,
      minDepth: minDepth,
      maxDepth: maxDepth,
      mediumConfidenceDepthCount: mediumConfidenceCount,
      meanDepth: validCount > 0 ? sumDepth / Double(validCount) : 0,
      validDepthCount: validCount,
      invalidDepthCount: invalidCount,
      lowConfidenceDepthCount: lowConfidenceCount
    )
  }

  private func makeMeshPayload(
    from meshAnchor: ARMeshAnchor,
    lastChangedTime: Double
  ) -> [String: Any]? {
    lock.lock()
    let cached = meshPayloadCache[meshAnchor.identifier]
    lock.unlock()
    if let cached, cached.lastChangedTime == lastChangedTime {
      // @ref LLP 0013#xr-mesh-detection — Native mesh buffers may be reused
      // while `lastChangedTime` is unchanged; the returned meshSpace pose still
      // comes from the current XRFrame snapshot.
      return meshPayloadDictionary(
        meshAnchor: meshAnchor,
        cachedPayload: cached,
        cached: true
      )
    }

    guard let payload = makeMeshPayloadCacheEntry(
      from: meshAnchor.geometry,
      lastChangedTime: lastChangedTime
    ) else {
      return nil
    }
    lock.lock()
    meshPayloadCache[meshAnchor.identifier] = payload
    lock.unlock()
    return meshPayloadDictionary(
      meshAnchor: meshAnchor,
      cachedPayload: payload,
      cached: false
    )
  }

  private func makeMeshSummary(
    from meshAnchor: ARMeshAnchor,
    lastChangedTime: Double
  ) -> (payload: [String: Any], vertexCount: Int, triangleCount: Int) {
    let geometry = meshAnchor.geometry
    let vertexCount = geometry.vertices.count
    let indexCount = geometry.faces.count * geometry.faces.indexCountPerPrimitive
    let payload: [String: Any] = [
      "id": meshAnchor.identifier.uuidString,
      "transform": webXRMatrixArray(meshAnchor.transform),
      "vertexCount": vertexCount,
      "indexCount": indexCount,
      "lastChangedTime": lastChangedTime,
    ]
    return (payload, vertexCount, geometry.faces.count)
  }

  private func meshPayloadDictionary(
    meshAnchor: ARMeshAnchor,
    cachedPayload: CachedWebXRMeshPayload,
    cached: Bool
  ) -> [String: Any] {
    var payload: [String: Any] = [
      "cached": cached,
      "id": meshAnchor.identifier.uuidString,
      "transform": webXRMatrixArray(meshAnchor.transform),
      "vertices": cachedPayload.vertices,
      "indices": cachedPayload.indices,
      "vertexCount": cachedPayload.vertexCount,
      "indexCount": cachedPayload.indexCount,
      "sourceVertexCount": cachedPayload.sourceVertexCount,
      "sourceIndexCount": cachedPayload.sourceIndexCount,
      "lastChangedTime": cachedPayload.lastChangedTime,
    ]
    if let normals = cachedPayload.normals {
      payload["normals"] = normals
    }
    return payload
  }

  private func makeMeshPayloadCacheEntry(
    from geometry: ARMeshGeometry,
    lastChangedTime: Double
  ) -> CachedWebXRMeshPayload? {
    if geometry.faces.count > webXRMeshPayloadMaxTrianglesPerAnchor,
       let sampled = copySampledMeshPayload(
        from: geometry,
        lastChangedTime: lastChangedTime,
        maxTriangles: webXRMeshPayloadMaxTrianglesPerAnchor
       ) {
      return sampled
    }
    guard let vertices = copyFloat3GeometrySource(geometry.vertices),
          let indices = copyTriangleIndices(geometry.faces) else {
      return nil
    }
    return CachedWebXRMeshPayload(
      lastChangedTime: lastChangedTime,
      vertices: vertices,
      normals: copyFloat3GeometrySource(geometry.normals),
      indices: indices,
      vertexCount: geometry.vertices.count,
      indexCount: geometry.faces.count * geometry.faces.indexCountPerPrimitive,
      sourceVertexCount: geometry.vertices.count,
      sourceIndexCount: geometry.faces.count * geometry.faces.indexCountPerPrimitive
    )
  }

  private func copySampledMeshPayload(
    from geometry: ARMeshGeometry,
    lastChangedTime: Double,
    maxTriangles: Int
  ) -> CachedWebXRMeshPayload? {
    let faces = geometry.faces
    guard faces.primitiveType == .triangle,
          faces.count > 0,
          faces.indexCountPerPrimitive == 3,
          faces.bytesPerIndex == 2 || faces.bytesPerIndex == 4,
          geometry.vertices.format == .float3,
          geometry.vertices.componentsPerVector == 3,
          geometry.vertices.count > 0,
          maxTriangles > 0 else {
      return nil
    }

    // @ref LLP 0013#xr-mesh-detection — WebXR exposes UA-provided mesh
    // geometry, so the native runtime may choose a lower-detail mesh payload
    // for dense ARKit anchors while preserving standard XRMesh vertices,
    // normals, indices, meshSpace pose, and lastChangedTime.
    let triangleCount = faces.count
    let sampleStride = max(1, Int(ceil(Double(triangleCount) / Double(maxTriangles))))
    var vertexMap: [UInt32: UInt32] = [:]
    vertexMap.reserveCapacity(min(geometry.vertices.count, maxTriangles * 3))
    var compactVertices: [Float] = []
    compactVertices.reserveCapacity(min(geometry.vertices.count, maxTriangles * 3) * 3)
    var compactIndices: [UInt32] = []
    compactIndices.reserveCapacity(min(triangleCount, maxTriangles) * 3)
    var compactFaceNormals: [Float] = []
    var compactVertexNormals: [Float] = []
    let normals = geometry.normals
    let useFaceNormals = normals.count == triangleCount
    let useVertexNormals = normals.count == geometry.vertices.count
    if useFaceNormals {
      compactFaceNormals.reserveCapacity(min(triangleCount, maxTriangles) * 3)
    } else if useVertexNormals {
      compactVertexNormals.reserveCapacity(min(geometry.vertices.count, maxTriangles * 3) * 3)
    }

    for triangleIndex in stride(from: 0, to: triangleCount, by: sampleStride) {
      var originalIndices: [UInt32] = []
      originalIndices.reserveCapacity(3)
      var originalVertices: [(Float, Float, Float)] = []
      originalVertices.reserveCapacity(3)
      var triangleIsValid = true
      for corner in 0..<3 {
        guard let originalIndex = readTriangleIndex(faces, at: triangleIndex * 3 + corner),
              originalIndex < UInt32(geometry.vertices.count),
              let vertex = readFloat3GeometrySource(geometry.vertices, at: Int(originalIndex)) else {
          triangleIsValid = false
          break
        }
        originalIndices.append(originalIndex)
        originalVertices.append(vertex)
      }
      guard triangleIsValid else {
        continue
      }
      if useFaceNormals,
         let normal = readFloat3GeometrySource(normals, at: triangleIndex) {
        compactFaceNormals.append(normal.0)
        compactFaceNormals.append(normal.1)
        compactFaceNormals.append(normal.2)
      }
      for corner in 0..<3 {
        let originalIndex = originalIndices[corner]
        if let mappedIndex = vertexMap[originalIndex] {
          compactIndices.append(mappedIndex)
          continue
        }
        let mappedIndex = UInt32(compactVertices.count / 3)
        vertexMap[originalIndex] = mappedIndex
        compactIndices.append(mappedIndex)
        let vertex = originalVertices[corner]
        compactVertices.append(vertex.0)
        compactVertices.append(vertex.1)
        compactVertices.append(vertex.2)
        if useVertexNormals {
          let normal = readFloat3GeometrySource(normals, at: Int(originalIndex)) ?? (0, 0, 1)
          compactVertexNormals.append(normal.0)
          compactVertexNormals.append(normal.1)
          compactVertexNormals.append(normal.2)
        }
      }
    }

    guard !compactVertices.isEmpty, !compactIndices.isEmpty else {
      return nil
    }
    let normalData: Data?
    if useFaceNormals && compactFaceNormals.count == compactIndices.count {
      normalData = dataFromFloatArray(compactFaceNormals)
    } else if useVertexNormals && compactVertexNormals.count == compactVertices.count {
      normalData = dataFromFloatArray(compactVertexNormals)
    } else {
      normalData = nil
    }
    return CachedWebXRMeshPayload(
      lastChangedTime: lastChangedTime,
      vertices: dataFromFloatArray(compactVertices),
      normals: normalData,
      indices: dataFromUInt32Array(compactIndices),
      vertexCount: compactVertices.count / 3,
      indexCount: compactIndices.count,
      sourceVertexCount: geometry.vertices.count,
      sourceIndexCount: geometry.faces.count * geometry.faces.indexCountPerPrimitive
    )
  }

  private func copyFloat3GeometrySource(_ source: ARGeometrySource) -> Data? {
    guard source.format == .float3,
          source.componentsPerVector == 3,
          source.count > 0 else {
      return nil
    }
    var data = Data(count: source.count * 3 * MemoryLayout<Float>.size)
    let sourceBase = source.buffer.contents()
    data.withUnsafeMutableBytes { dst in
      guard let dstBase = dst.baseAddress else { return }
      let dstValues = dstBase.assumingMemoryBound(to: Float.self)
      for i in 0..<source.count {
        let sourceValues = sourceBase
          .advanced(by: source.offset + i * source.stride)
          .assumingMemoryBound(to: Float.self)
        let out = i * 3
        dstValues[out] = sourceValues[0]
        dstValues[out + 1] = sourceValues[1]
        dstValues[out + 2] = sourceValues[2]
      }
    }
    return data
  }

  private func readFloat3GeometrySource(
    _ source: ARGeometrySource,
    at index: Int
  ) -> (Float, Float, Float)? {
    guard source.format == .float3,
          source.componentsPerVector == 3,
          index >= 0,
          index < source.count else {
      return nil
    }
    let values = source.buffer.contents()
      .advanced(by: source.offset + index * source.stride)
      .assumingMemoryBound(to: Float.self)
    return (values[0], values[1], values[2])
  }

  private func copyTriangleIndices(_ element: ARGeometryElement) -> Data? {
    guard element.primitiveType == .triangle,
          element.count > 0,
          element.indexCountPerPrimitive == 3,
          element.bytesPerIndex == 2 || element.bytesPerIndex == 4 else {
      return nil
    }
    let indexCount = element.count * element.indexCountPerPrimitive
    let sourceBase = element.buffer.contents()
    var data = Data(count: indexCount * MemoryLayout<UInt32>.size)
    data.withUnsafeMutableBytes { dst in
      guard let dstBase = dst.baseAddress else { return }
      let dstValues = dstBase.assumingMemoryBound(to: UInt32.self)
      for i in 0..<indexCount {
        let source = sourceBase.advanced(by: i * element.bytesPerIndex)
        if element.bytesPerIndex == 2 {
          dstValues[i] = UInt32(source.assumingMemoryBound(to: UInt16.self).pointee)
        } else {
          dstValues[i] = source.assumingMemoryBound(to: UInt32.self).pointee
        }
      }
    }
    return data
  }

  private func readTriangleIndex(_ element: ARGeometryElement, at index: Int) -> UInt32? {
    guard element.primitiveType == .triangle,
          element.indexCountPerPrimitive == 3,
          element.bytesPerIndex == 2 || element.bytesPerIndex == 4,
          index >= 0,
          index < element.count * element.indexCountPerPrimitive else {
      return nil
    }
    let source = element.buffer.contents().advanced(by: index * element.bytesPerIndex)
    if element.bytesPerIndex == 2 {
      return UInt32(source.assumingMemoryBound(to: UInt16.self).pointee)
    }
    return source.assumingMemoryBound(to: UInt32.self).pointee
  }

  private func dataFromFloatArray(_ values: [Float]) -> Data {
    guard !values.isEmpty else {
      return Data()
    }
    return values.withUnsafeBufferPointer { buffer in
      Data(bytes: buffer.baseAddress!, count: buffer.count * MemoryLayout<Float>.size)
    }
  }

  private func dataFromUInt32Array(_ values: [UInt32]) -> Data {
    guard !values.isEmpty else {
      return Data()
    }
    return values.withUnsafeBufferPointer { buffer in
      Data(bytes: buffer.baseAddress!, count: buffer.count * MemoryLayout<UInt32>.size)
    }
  }

  private func makeCameraPreviewFrame(
    from pixelBuffer: CVPixelBuffer,
    width dstWidth: Int,
    height dstHeight: Int
  ) -> (width: Int, height: Int, data: Data, path: String)? {
    if let frame = makeCameraPreviewFrameFromBiPlanarYCbCr(
      from: pixelBuffer,
      width: dstWidth,
      height: dstHeight
    ) {
      return frame
    }
    return makeCameraPreviewFrameWithCoreImage(
      from: pixelBuffer,
      width: dstWidth,
      height: dstHeight
    )
  }

  private func makeCameraPreviewFrameFromBiPlanarYCbCr(
    from pixelBuffer: CVPixelBuffer,
    width dstWidth: Int,
    height dstHeight: Int
  ) -> (width: Int, height: Int, data: Data, path: String)? {
    let pixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer)
    let fullRange: Bool
    if pixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange {
      fullRange = true
    } else if pixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange {
      fullRange = false
    } else {
      return nil
    }
    guard CVPixelBufferIsPlanar(pixelBuffer),
          CVPixelBufferGetPlaneCount(pixelBuffer) >= 2,
          dstWidth > 0,
          dstHeight > 0 else {
      return nil
    }

    let lockResult = CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    guard lockResult == kCVReturnSuccess else {
      return nil
    }
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    guard let yBase = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0),
          let cbcrBase = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1) else {
      return nil
    }
    let sourceWidth = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
    let sourceHeight = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
    let chromaWidth = CVPixelBufferGetWidthOfPlane(pixelBuffer, 1)
    let chromaHeight = CVPixelBufferGetHeightOfPlane(pixelBuffer, 1)
    guard sourceWidth > 0,
          sourceHeight > 0,
          chromaWidth > 0,
          chromaHeight > 0 else {
      return nil
    }

    // @ref LLP 0013#xr-camera-image — Keep the returned WebXR CPU camera image
    // as tight BGRA bytes, but avoid a CoreImage render/sync for ARKit's common
    // bi-planar YCbCr buffers by downsampling directly into the preview plane.
    let scale = max(
      Double(dstWidth) / Double(sourceWidth),
      Double(dstHeight) / Double(sourceHeight)
    )
    let offsetX = (Double(dstWidth) - Double(sourceWidth) * scale) / 2
    let offsetY = (Double(dstHeight) - Double(sourceHeight) * scale) / 2
    let sourceXs = cameraPreviewSourceIndexes(
      sourceSize: sourceWidth,
      destinationSize: dstWidth,
      scale: scale,
      offset: offsetX
    )
    let sourceYs = cameraPreviewSourceIndexes(
      sourceSize: sourceHeight,
      destinationSize: dstHeight,
      scale: scale,
      offset: offsetY
    )
    let yRowBytes = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
    let cbcrRowBytes = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1)
    let rowBytes = dstWidth * 4
    var data = Data(count: rowBytes * dstHeight)
    data.withUnsafeMutableBytes { dstRaw in
      guard let dstBase = dstRaw.baseAddress else { return }
      let dstBytes = dstBase.assumingMemoryBound(to: UInt8.self)
      for dstY in 0..<dstHeight {
        let sourceY = sourceYs[dstY]
        let chromaY = min(chromaHeight - 1, max(0, sourceY / 2))
        let yRow = yBase.advanced(by: sourceY * yRowBytes).assumingMemoryBound(to: UInt8.self)
        let cbcrRow = cbcrBase.advanced(by: chromaY * cbcrRowBytes).assumingMemoryBound(to: UInt8.self)
        let dstRow = dstBytes.advanced(by: dstY * rowBytes)
        for dstX in 0..<dstWidth {
          let sourceX = sourceXs[dstX]
          let chromaX = min(chromaWidth - 1, max(0, sourceX / 2))
          let y = Int(yRow[sourceX])
          let cb = Int(cbcrRow[chromaX * 2]) - 128
          let cr = Int(cbcrRow[chromaX * 2 + 1]) - 128
          let rgb = yCbCrToRGB(y: y, cb: cb, cr: cr, fullRange: fullRange)
          let offset = dstX * 4
          dstRow[offset] = rgb.b
          dstRow[offset + 1] = rgb.g
          dstRow[offset + 2] = rgb.r
          dstRow[offset + 3] = 255
        }
      }
    }
    return (dstWidth, dstHeight, data, "ycbcr-direct")
  }

  private func makeCameraPreviewFrameWithCoreImage(
    from pixelBuffer: CVPixelBuffer,
    width dstWidth: Int,
    height dstHeight: Int
  ) -> (width: Int, height: Int, data: Data, path: String)? {
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
    return (dstWidth, dstHeight, data, "core-image")
  }

  private func cameraPreviewSourceIndexes(
    sourceSize: Int,
    destinationSize: Int,
    scale: Double,
    offset: Double
  ) -> [Int] {
    let maxSource = max(0, sourceSize - 1)
    guard sourceSize > 0, destinationSize > 0, scale > 0 else {
      return []
    }
    var indexes = [Int]()
    indexes.reserveCapacity(destinationSize)
    for destination in 0..<destinationSize {
      let sourcePixel = (Double(destination) + 0.5 - offset) / scale - 0.5
      let nearest = Int(sourcePixel.rounded())
      indexes.append(min(max(0, nearest), maxSource))
    }
    return indexes
  }

  @inline(__always)
  private func yCbCrToRGB(y: Int, cb: Int, cr: Int, fullRange: Bool) -> (r: UInt8, g: UInt8, b: UInt8) {
    let r: Int
    let g: Int
    let b: Int
    if fullRange {
      r = y + ((91881 * cr) >> 16)
      g = y - ((22554 * cb + 46802 * cr) >> 16)
      b = y + ((116130 * cb) >> 16)
    } else {
      let luma = max(0, y - 16)
      r = ((76309 * luma + 104597 * cr) >> 16)
      g = ((76309 * luma - 25675 * cb - 53279 * cr) >> 16)
      b = ((76309 * luma + 132201 * cb) >> 16)
    }
    return (clampByte(r), clampByte(g), clampByte(b))
  }

  @inline(__always)
  private func clampByte(_ value: Int) -> UInt8 {
    UInt8(min(255, max(0, value)))
  }

  private func makeMeshGeometrySignature(from geometry: ARMeshGeometry) -> WebXRMeshGeometrySignature {
    WebXRMeshGeometrySignature(
      faces: makeGeometryElementSignature(from: geometry.faces),
      normals: makeGeometrySourceSignature(from: geometry.normals),
      vertices: makeGeometrySourceSignature(from: geometry.vertices)
    )
  }

  private func makeGeometrySourceSignature(from source: ARGeometrySource) -> WebXRGeometrySourceSignature {
    WebXRGeometrySourceSignature(
      bufferAddress: UInt(bitPattern: source.buffer.contents()),
      componentsPerVector: source.componentsPerVector,
      count: source.count,
      format: Int(source.format.rawValue),
      offset: source.offset,
      sampleHash: sampleFloat3GeometrySourceHash(source),
      stride: source.stride
    )
  }

  private func makeGeometryElementSignature(from element: ARGeometryElement) -> WebXRGeometryElementSignature {
    WebXRGeometryElementSignature(
      bufferAddress: UInt(bitPattern: element.buffer.contents()),
      bytesPerIndex: element.bytesPerIndex,
      count: element.count,
      indexCountPerPrimitive: element.indexCountPerPrimitive,
      primitiveType: Int(element.primitiveType.rawValue),
      sampleHash: sampleTriangleIndexHash(element)
    )
  }

  private func sampleFloat3GeometrySourceHash(_ source: ARGeometrySource) -> UInt64 {
    var hash = UInt64(1469598103934665603)
    guard source.format == .float3,
          source.componentsPerVector == 3,
          source.count > 0 else {
      return hash
    }
    let sourceBase = source.buffer.contents()
    visitSampleIndexes(count: source.count) { i in
      let sourceValues = sourceBase
        .advanced(by: source.offset + i * source.stride)
        .assumingMemoryBound(to: Float.self)
      mixHash(&hash, UInt64(sourceValues[0].bitPattern))
      mixHash(&hash, UInt64(sourceValues[1].bitPattern))
      mixHash(&hash, UInt64(sourceValues[2].bitPattern))
    }
    return hash
  }

  private func sampleTriangleIndexHash(_ element: ARGeometryElement) -> UInt64 {
    var hash = UInt64(1469598103934665603)
    guard element.count > 0,
          element.indexCountPerPrimitive > 0,
          element.bytesPerIndex == 2 || element.bytesPerIndex == 4 else {
      return hash
    }
    let indexCount = element.count * element.indexCountPerPrimitive
    let sourceBase = element.buffer.contents()
    visitSampleIndexes(count: indexCount) { i in
      let source = sourceBase.advanced(by: i * element.bytesPerIndex)
      if element.bytesPerIndex == 2 {
        mixHash(&hash, UInt64(source.assumingMemoryBound(to: UInt16.self).pointee))
      } else {
        mixHash(&hash, UInt64(source.assumingMemoryBound(to: UInt32.self).pointee))
      }
    }
    return hash
  }

  private func visitSampleIndexes(
    count: Int,
    maxSamples: Int = webXRMeshGeometrySignatureSampleCount,
    _ visit: (Int) -> Void
  ) {
    guard count > 0 else {
      return
    }
    let sampleCount = min(count, max(1, maxSamples))
    guard sampleCount > 1 else {
      visit(0)
      return
    }
    var previous = -1
    for sampleIndex in 0..<sampleCount {
      let index = (sampleIndex * (count - 1) + (sampleCount - 1) / 2) / (sampleCount - 1)
      if index == previous {
        continue
      }
      visit(index)
      previous = index
    }
  }

  private func mixHash(_ hash: inout UInt64, _ value: UInt64) {
    hash ^= value
    hash = hash &* UInt64(1099511628211)
  }

  private func updateMeshAnchors(_ anchors: [ARAnchor]) {
    let changedAtMs = profilingNowMs()
    lock.lock()
    guard activeMeshDetection else {
      lock.unlock()
      return
    }
    for anchor in anchors {
      guard let meshAnchor = anchor as? ARMeshAnchor else {
        continue
      }
      let geometrySignature = makeMeshGeometrySignature(from: meshAnchor.geometry)
      let previousGeometrySignature = meshAnchorGeometrySignatures[meshAnchor.identifier]
      meshAnchors[meshAnchor.identifier] = meshAnchor
      // @ref LLP 0013#xr-mesh-detection — `XRMesh.lastChangedTime` tracks
      // mesh geometry changes, not current-frame pose changes. Keep the latest
      // ARMeshAnchor for `meshSpace` pose, but preserve cached vertex/index
      // buffers when ARKit only updates the anchor transform.
      if previousGeometrySignature != geometrySignature {
        meshAnchorGeometrySignatures[meshAnchor.identifier] = geometrySignature
        meshAnchorChangedTimes[meshAnchor.identifier] = changedAtMs
        meshPayloadCache.removeValue(forKey: meshAnchor.identifier)
      } else if meshAnchorChangedTimes[meshAnchor.identifier] == nil {
        meshAnchorChangedTimes[meshAnchor.identifier] = changedAtMs
      }
    }
    lock.unlock()
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
    frameSnapshots.removeAll()
    meshAnchors.removeAll()
    meshAnchorChangedTimes.removeAll()
    meshAnchorGeometrySignatures.removeAll()
    meshPayloadCache.removeAll()
    activeMeshDetection = false
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
