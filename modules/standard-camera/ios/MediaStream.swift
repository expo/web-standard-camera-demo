import AVFoundation
import ExpoModulesCore

// @ref LLP 0008#dom-mediastream — Upstream spec text
// @ref LLP 0003#stream-* — MediaStream subset (native handle)
//
// The native MediaStream is a thin container that JS-side code wraps. The
// AVCaptureSession used to live here; it now lives on a CaptureSource that
// each MediaStreamTrack strong-refs (see CaptureSource.swift). This shape is
// what makes clone() work — clones share the source via their tracks, and
// the camera stays open until the last track ends.

internal final class MediaStream: SharedObject {
  let id: String
  private(set) var tracks: [MediaStreamTrack]

  // @ref LLP 0005#concurrency — Session mutation is serialized on this queue.
  static let sessionQueue = DispatchQueue(
    label: "dev.ide.standardcamera.session",
    qos: .userInitiated
  )

  init(id: String, tracks: [MediaStreamTrack]) {
    self.id = id
    self.tracks = tracks
    super.init()
  }

  // @ref LLP 0008#dom-mediastream-active — spec attribute
  // @ref LLP 0003#stream-active — At least one track is "live"
  var active: Bool {
    return tracks.contains { $0.readyState == "live" }
  }

  // @ref LLP 0008#dom-mediastream-gettracks
  func getTracks() -> [MediaStreamTrack] {
    return tracks
  }

  // @ref LLP 0008#dom-mediastream-getvideotracks
  func getVideoTracks() -> [MediaStreamTrack] {
    return tracks.filter { $0.kind == "video" }
  }

  // @ref LLP 0008#dom-mediastream-getaudiotracks
  func getAudioTracks() -> [MediaStreamTrack] {
    return tracks.filter { $0.kind == "audio" }
  }

  // @ref LLP 0008#dom-mediastream-gettrackbyid
  func getTrackById(_ trackId: String) -> MediaStreamTrack? {
    return tracks.first { $0.id == trackId }
  }

  // @ref LLP 0008#dom-mediastream-addtrack — script-initiated; no event fires
  // @ref LLP 0003#stream-addtrack — adds to the JS-side set if not present.
  // The TS wrapper is the source of truth for the JS-visible track set; this
  // path is here for IDL conformance and for clone() construction.
  func addTrack(_ track: MediaStreamTrack) {
    if tracks.contains(where: { $0 === track }) { return }
    tracks.append(track)
  }

  // @ref LLP 0008#dom-mediastream-removetrack — script-initiated; no event fires
  // @ref LLP 0003#stream-removetrack
  func removeTrack(_ track: MediaStreamTrack) {
    tracks.removeAll { $0 === track }
  }

  // @ref LLP 0008#dom-mediastream-clone — spec algorithm
  // @ref LLP 0003#stream-clone — Clone every track; new id.
  func clone() -> MediaStream {
    let clonedTracks = tracks.map { $0.cloneTrack() }
    return MediaStream(id: UUID().uuidString, tracks: clonedTracks)
  }

  // The first video track's CaptureSource owns the AVCaptureSession that the
  // <Video> view's preview layer should attach to. Returns nil if there are
  // no native-backed video tracks (i.e., a script-constructed MediaStream
  // with no getUserMedia tracks).
  // @ref LLP 0003#stream-construction
  var captureSession: AVCaptureSession? {
    return tracks.first(where: { $0.kind == "video" })?.source?.session
  }

  // Test hook — posts the same notifications iOS would, so WPT tests can
  // verify the mute/unmute path without needing real thermal pressure. The
  // event fans out from the CaptureSource observers to every track that
  // references the source.
  // @ref LLP 0007#testing-overheating
  func simulateInterruption(reasonCode: Int, ended: Bool) {
    tracks.first(where: { $0.kind == "video" })?.source?.simulateInterruption(reasonCode: reasonCode, ended: ended)
  }
}
