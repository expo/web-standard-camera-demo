# LLP 0005: iOS native mapping (AVFoundation, SharedObject)

**Type:** Decision
**Status:** Active
**Systems:** standard-camera, ios
**Author:** James Ide
**Date:** 2026-05-19
**Related:** 0002, 0003, 0004

## Context

We need to map the W3C concepts (`MediaStream`, `MediaStreamTrack`, `<video srcObject>`) onto iOS primitives. The two natural choices for "live camera frames into a UI element" on iOS are:

- **`AVCaptureVideoPreviewLayer`** — a CALayer subclass that renders frames directly from an `AVCaptureSession`. Cheap, GPU-accelerated, no copy.
- **`AVCaptureVideoDataOutput` + custom rendering** — gives access to raw `CMSampleBuffer`s for processing or alternative rendering paths.

## Options considered

### Option A — `AVCaptureVideoPreviewLayer` only

- Simple. Layer is added as a sublayer of the `ExpoView`. The session is referenced via `previewLayer.session = avCaptureSession`.
- No frame access from JS, but for v1 we don't need frame access.

### Option B — `AVCaptureVideoDataOutput` rendering via Metal

- Required for future features (frame inspection, filters, `MediaRecorder`).
- Much more code. Not justified for v1.

### Option C — Hybrid: preview layer for display, data output attached for future use

- Pays the cost of B without using it. Avoid.

## Decision

**Option A.** Single `AVCaptureSession` per `MediaStream`. The `MediaStream` Swift type holds the session via Expo Modules Core's `SharedRef<AVCaptureSession>` pattern (the same shape `expo-video`'s `VideoPlayer` uses for `SharedRef<AVPlayer>`).

When a JS `MediaStream` handle is set as the `srcObject` prop of a `<Video>` view, the native view extracts `stream.ref` and assigns it to its `previewLayer.session`. This is the only wire-up.

## Architecture

```
JS                                Native (Swift)
─────────────────────────         ──────────────────────────
MediaStream (handle)  ◀───────▶   class MediaStream: SharedObject {
                                    let session: AVCaptureSession
                                    var tracks: [MediaStreamTrack]
                                  }

MediaStreamTrack (handle) ◀──▶    class MediaStreamTrack: SharedObject {
                                    weak var session: AVCaptureSession?
                                    let connection: AVCaptureConnection?
                                    var settings: TrackSettings
                                  }

<Video srcObject>           ─▶    class VideoView: ExpoView {
                                    let previewLayer: AVCaptureVideoPreviewLayer
                                    var srcObject: MediaStream? {
                                      didSet { previewLayer.session = srcObject?.session }
                                    }
                                  }
```

## Concurrency

All session mutation (start, stop, add/remove input/output, `beginConfiguration`/`commitConfiguration`) is dispatched onto a dedicated serial queue:

```swift
static let sessionQueue = DispatchQueue(label: "dev.ide.standardcamera.session", qos: .userInitiated)
```

This mirrors `expo-camera`'s pattern and is the standard AVFoundation idiom. Reading state for getters (`active`, `readyState`) happens on the main thread without locking — these read atomic flags only.

## First-frame detection

The `loadeddata` event must fire when the first frame is rendered. We attach a hidden `AVCaptureVideoDataOutput` (a `FrameSink`) to the session in `getUserMedia`, and its `captureOutput(_:didOutput:from:)` delegate fires once per session. The view installs an `onFirstFrame` callback on the stream's frame sink when its `srcObject` is set, and that callback fires `onLoadedData` / `onDurationChange`.

We tried KVO on `previewLayer.isPreviewing` first; it was unreliable on iPhone 15 Pro / iOS 26 (never transitioned to `true`) and would not have produced a single source of truth that works the same on simulator and device. The data-output approach also has the side effect of forcing frames to actually flow through the session — without any output configured, `AVCaptureSession` can be `isRunning == true` yet deliver no samples to a preview-only layer.

## Preview orientation and mirroring

The `<Video>` view renders with `AVCaptureVideoPreviewLayer`. On iOS 17 and
newer, preview rotation is driven by `AVCaptureDevice.RotationCoordinator` and
its `videoRotationAngleForHorizonLevelPreview`, applied to the preview
connection's `videoRotationAngle`. This replaces a hard-coded 90-degree
portrait rotation and keeps the preview layer level across front/back stream
swaps.

The app uses the standard web idiom for self-view mirroring:
`transform: scaleX(-1)` on the video element. React Native writes that transform
to the layer, but `AVCaptureVideoPreviewLayer`'s direct camera rendering path
does not reliably honor it as a normal composited CALayer transform. The native
view therefore translates the effective horizontal flip into
`AVCaptureConnection.isVideoMirrored` and then resets the CALayer transform to
identity so mirroring is applied exactly once.

Ordering matters: whenever mirroring changes, the view reapplies the current
preview rotation afterward. This prevents AVFoundation mirror changes from
leaving a stale effective rotation on the preview connection.

## Passing SharedObjects to view props (the big landmine)

Expo views (under either architecture, as of SDK 56) **cannot accept SharedObject references as view props directly.** A prop declared on the Swift side as `(view, stream: MediaStream?)` *will silently receive `nil`* if JS passes the SharedObject's JS-side handle. You have to pass the shared-object id (an integer stored on the JS proxy as `__expo_shared_object_id__`), and the prop converter resolves it back to the Swift instance.

The recommended pattern is documented in [expo/expo#46054](https://github.com/expo/expo/pull/46054), which adds first-class support for this in `create-expo-module`'s generated wrappers. Three ingredients:

1. **Two-tier types.** The consumer-facing component prop type takes the actual SharedObject; the bridge-level type takes a `number`.
   - `VideoProps.srcObject: MediaStream | null`
   - `NativeVideoViewProps.srcObject: number | null`
2. **A named helper for the unwrap:**
   ```ts
   function getSharedObjectId(object: unknown): number | null {
     return (object as { __expo_shared_object_id__?: number } | null)?.__expo_shared_object_id__ ?? null;
   }
   ```
3. **The wrapper component encapsulates the unwrap** so the consumer never touches `__expo_shared_object_id__`:
   ```tsx
   <NativeView {...nativeProps} srcObject={getStreamNativeId(srcObject)} />
   ```
   The native `Prop("srcObject")` is still typed as `MediaStream?` — Swift resolves the id back to the instance via the registered SharedObject class.

In our case `MediaStream` is a TS wrapper class with `_native` pointing at the actual SharedObject proxy (the wrapper exists so the public type can be DOM-compatible). The wrapper exposes `__expo_shared_object_id__` as a getter that returns `this._native.__expo_shared_object_id__`, so `getSharedObjectId(stream)` works on the wrapper directly — matching the PR's recommended call site verbatim.

This is a known limitation that will be addressed in the Expo bridge; until then, every view prop that takes a SharedObject needs this dance.

## EventTarget polyfill

Hermes V1 (RN 0.85) does **not** ship `globalThis.EventTarget` or `Event`. Our `MediaStream` and `MediaStreamTrack` classes extend `EventTarget`; without the polyfill, the entire module fails to load with `ReferenceError: Property 'EventTarget' doesn't exist` and Expo Router crashes on the downstream `ErrorBoundary of undefined`. We import `event-target-polyfill` at the top of `modules/standard-camera/index.ts` so it runs before any class evaluation. Drop this import only when Hermes ships these globals.

## React-state-bound `srcObject`

Setting `videoRef.current.srcObject = stream` is an imperative call — React has no idea anything changed and won't re-render the `<Video>` component, so the native view's `srcObject` prop never updates. We work around this by keeping a React `useState` mirror of `srcObject` inside the component and threading a setter into the `VideoElementImpl`'s constructor. The setter calls `setSrcObjectState(newValue)` from the imperative setter, which triggers a re-render. Subsequent JSX picks up the new value and forwards the unwrapped shared-object id to the native view.

## Lifecycle

- The `MediaStream` SharedObject's `deinit` (called when JS GCs the handle) stops the session and removes inputs. This guarantees the camera indicator turns off promptly.
- The `VideoView`'s `removeFromSuperview` does **not** stop the session — the stream is independent of the view. Multiple `<Video>` views can show the same stream.

## Permissions

Camera permission is requested inside `getUserMedia()`, not at module load. We use `AVCaptureDevice.requestAccess(for: .video)`. The Info.plist must contain `NSCameraUsageDescription` (set in `app.json`).

## Consequences

- We get a clean DOM-shaped API at the JS layer.
- We can't read pixels from JS (no `canvas.drawImage(video, …)` analog). That's a known limitation; a future LLP can introduce `AVCaptureVideoDataOutput` if needed.
- Simulator behavior: Xcode 15+'s synthetic camera produces frames; KVO on `isPreviewing` should still fire. If it doesn't, the WPT runner will catch it.
