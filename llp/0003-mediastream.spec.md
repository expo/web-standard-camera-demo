# LLP 0003: `MediaStream` and `MediaStreamTrack` subset

**Type:** Spec
**Status:** Active
**Systems:** standard-camera
**Author:** James Ide
**Date:** 2026-05-19
**Related:** 0001, 0002, 0004

## Summary

Subset of [W3C § MediaStream](https://www.w3.org/TR/mediacapture-streams/#mediastream) and [§ MediaStreamTrack](https://www.w3.org/TR/mediacapture-streams/#mediastreamtrack).

## `MediaStream` (subset)

### `stream-id`

Type: `string`. Each `MediaStream` has a unique id, set at construction, read-only thereafter. Implementation: UUIDv4 generated in native.

### `stream-active`

Type: `boolean`. Per spec: "A MediaStream object is said to be active when it has at least one MediaStreamTrack that has not ended." Computed each access as `tracks.some(t => t.readyState === "live")`.

### `stream-getTracks`

Returns a snapshot array of all `MediaStreamTrack` objects in insertion order. Mutating the returned array does not affect the stream.

### `stream-getVideoTracks` / `stream-getAudioTracks`

Filtered by `kind === "video"` / `"audio"`. In v1, audio is always empty.

### `stream-getTrackById`

```
function getTrackById(id: string): MediaStreamTrack | null
```

Linear scan; return first match.

### `stream-events`

We implement `EventTarget` shape but never dispatch `addtrack` / `removetrack` events in v1, since `addTrack`/`removeTrack` are out of scope.

## `MediaStreamTrack` (subset)

### `track-kind`

`"video"` (always in v1).

### `track-id`

UUIDv4, set at construction, read-only.

### `track-label`

Returns `AVCaptureDevice.localizedName` of the underlying device. Empty string after `stop()` per spec.

### `track-enabled`

Get/set boolean. Default `true`. Setting flips `AVCaptureConnection.isEnabled` so frames are not forwarded when `false`. Does **not** change `readyState`.

### `track-muted`

Always `false` in v1. We never simulate mute.

### `track-readyState`

`"live"` initially; transitions to `"ended"` exactly once when `stop()` is called or when the underlying device becomes unavailable. Read-only.

### `track-stop`

1. If `readyState === "ended"`, return (idempotent per spec).
2. Set `readyState = "ended"`.
3. Disable the corresponding `AVCaptureConnection`.
4. If the stream has no other live tracks, stop the `AVCaptureSession`.
5. Fire `ended` event asynchronously (queue a task; do not fire synchronously inside `stop()` — spec says fire as a separate task).

### `track-events`

- `ended` — fired once when `readyState` transitions to `"ended"`. Fired regardless of whether transition was caused by `stop()` or external (device unplugged on hardware; never in v1 simulator).
- `mute` / `unmute` — never fired in v1.

### `track-getSettings`

Returns the actual settings of the underlying capture:

```ts
{
  deviceId: string,    // AVCaptureDevice.uniqueID
  groupId: string,     // matches deviceId in v1 (single-camera groups)
  facingMode: "user" | "environment",
  width: number,       // pixels of the chosen preset
  height: number,
  frameRate: number,
  aspectRatio: number  // width / height
}
```

### `track-getConstraints`

Returns the constraints object passed to `getUserMedia()` for this track. Read-only snapshot taken at construction.

### `track-getCapabilities`

Returns `{}` in v1 (out of scope but spec allows an empty MediaTrackCapabilities).

### `track-clone`

Throws `NotSupportedError` in v1.

### `track-applyConstraints`

Rejects with `OverconstrainedError` always in v1.

## Open questions

- Should `stop()` synchronously reflect the new `readyState`, or only after the queued task? Spec says synchronously; we follow that. Only the `ended` event is asynchronous.
- For multi-track streams (which we don't have in v1), how do we coordinate session stop? Out of scope until audio lands.
