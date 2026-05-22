# LLP 0008: W3C "Media Capture and Streams" — spec text

**Type:** Spec
**Status:** Active
**Systems:** standard-camera
**Author:** James Ide
**Date:** 2026-05-21
**Related:** 0001, 0002, 0003, 0004

## Purpose

This LLP is the in-repo copy of the W3C ["Media Capture and Streams"](https://www.w3.org/TR/mediacapture-streams/) spec text for the surfaces we implement. It exists so `@ref` annotations can point at the spec source-of-truth without leaving the repo, and so future agents working in this codebase have the normative language available locally.

LLPs 0001–0004 remain our **subset scope and decisions** (what we implement and why); LLP 0008 is the **upstream text** those scopes are derived from. When in doubt, the W3C URL on each section heading is authoritative — this document may drift over time, and the spec is an Editor's Draft / Recommendation that evolves.

Conventions:
- Section headings carry the spec's anchor ID in brackets — e.g. `## getUserMedia [dom-mediadevices-getusermedia]`. Code annotations cite these with `@ref LLP 0008#dom-mediadevices-getusermedia`.
- Normative MUST / SHOULD / MAY language is preserved verbatim where the WebFetch quote was clean. Where the spec defers to other documents (HTML Standard for `srcObject` behavior in HTMLMediaElement), we link out rather than re-quote.

---

# MediaStream Interface [dom-mediastream]

## IDL

```webidl
[Exposed=Window]
interface MediaStream : EventTarget {
  constructor();
  constructor(MediaStream stream);
  constructor(sequence<MediaStreamTrack> tracks);
  readonly attribute DOMString id;
  sequence<MediaStreamTrack> getAudioTracks();
  sequence<MediaStreamTrack> getVideoTracks();
  sequence<MediaStreamTrack> getTracks();
  MediaStreamTrack? getTrackById(DOMString trackId);
  undefined addTrack(MediaStreamTrack track);
  undefined removeTrack(MediaStreamTrack track);
  MediaStream clone();
  readonly attribute boolean active;
  attribute EventHandler onaddtrack;
  attribute EventHandler onremovetrack;
};
```

## Constructors [mediastream-constructor]

Composes a new stream out of existing tracks. When invoked:

1. Let `stream` be a newly constructed `MediaStream` object.
2. Initialize `stream.id` to a newly generated value.
3. If the constructor's argument is present, construct the set of tracks from it (either a `MediaStream` or a `sequence<MediaStreamTrack>`). For each track: if already in `stream`'s track set, skip; otherwise add.
4. Return `stream`.

## Attribute: `id` [dom-mediastream-id]

> The `id` attribute MUST return the value to which it was initialized when the object was created.

> When a `MediaStream` is created, the User Agent MUST generate an identifier string, and MUST initialize the object's `id` attribute to that string, unless the object is created as part of a special purpose algorithm that specifies how the stream id must be initialized.

## Attribute: `active` [dom-mediastream-active]

> The `active` attribute MUST return `true` if this `MediaStream` is **active** and `false` otherwise.

A `MediaStream` is active when it has at least one `MediaStreamTrack` that has not ended.

## Method: `getTracks()` [dom-mediastream-gettracks]

> The `getTracks()` method MUST return a sequence that represents a snapshot of all the `MediaStreamTrack` objects in this stream's track set, regardless of kind.

## Method: `getAudioTracks()` [dom-mediastream-getaudiotracks]

> The `getAudioTracks()` method MUST return a sequence that represents a snapshot of all the `MediaStreamTrack` objects in this stream's track set whose `kind` is equal to `"audio"`.

## Method: `getVideoTracks()` [dom-mediastream-getvideotracks]

> The `getVideoTracks()` method MUST return a sequence that represents a snapshot of all the `MediaStreamTrack` objects in this stream's track set whose `kind` is equal to `"video"`.

## Method: `getTrackById(trackId)` [dom-mediastream-gettrackbyid]

> The `getTrackById()` method MUST return either a `MediaStreamTrack` object from this stream's track set whose `id` is equal to `trackId`, or `null`, if no such track exists.

## Method: `addTrack(track)` [dom-mediastream-addtrack]

When invoked:
1. Let `track` be the argument and `stream` the `MediaStream` on which called.
2. If `track` is already in `stream`'s track set, then abort.
3. Add `track` to `stream`'s track set.

## Method: `removeTrack(track)` [dom-mediastream-removetrack]

When invoked:
1. Let `track` be the argument and `stream` the `MediaStream` on which called.
2. If `track` is not in `stream`'s track set, then abort.
3. Remove `track` from `stream`'s track set.

## Method: `clone()` [dom-mediastream-clone]

When invoked:
1. Let `streamClone` be a newly constructed `MediaStream` object.
2. Initialize `streamClone.id` to a newly generated value.
3. Clone each track in this `MediaStream` and add the result to `streamClone`'s track set.
4. Return `streamClone`.

## Event: `addtrack` [event-mediastream-addtrack]

To add a track to a stream:
1. If `track` is already in `stream`'s track set, abort.
2. Add `track` to `stream`'s track set.
3. Fire a track event named `addtrack` with `track` at `stream`.

## Event: `removetrack` [event-mediastream-removetrack]

To remove a track from a stream:
1. If `track` is not in `stream`'s track set, abort.
2. Remove `track` from `stream`'s track set.
3. Fire a track event named `removetrack` with `track` at `stream`.

---

# MediaStreamTrack Interface [dom-mediastreamtrack]

## IDL

```webidl
[Exposed=Window]
interface MediaStreamTrack : EventTarget {
  readonly attribute DOMString kind;
  readonly attribute DOMString id;
  readonly attribute DOMString label;
  attribute boolean enabled;
  readonly attribute boolean muted;
  attribute EventHandler onmute;
  attribute EventHandler onunmute;
  readonly attribute MediaStreamTrackState readyState;
  attribute EventHandler onended;
  MediaStreamTrack clone();
  undefined stop();
  MediaTrackCapabilities getCapabilities();
  MediaTrackConstraints getConstraints();
  MediaTrackSettings getSettings();
  Promise<undefined> applyConstraints(optional MediaTrackConstraints constraints = {});
};

enum MediaStreamTrackState { "live", "ended" };
```

## Attribute: `kind` [dom-mediastreamtrack-kind]

> The `kind` attribute MUST return this.[[Kind]].

Returns `"audio"` or `"video"`.

## Attribute: `id` [dom-mediastreamtrack-id]

> The `id` attribute MUST return this.[[Id]].

## Attribute: `label` [dom-mediastreamtrack-label]

> The `label` attribute MUST return this.[[Label]].

## Attribute: `enabled` [dom-mediastreamtrack-enabled]

> The `enabled` attribute controls the enabled state for the object.
> On getting, this.[[Enabled]] MUST be returned. On setting, this.[[Enabled]] MUST be set to the new value.

## Attribute: `muted` [dom-mediastreamtrack-muted]

> The `muted` attribute reflects whether the track is muted. It MUST return this.[[Muted]].

## Attribute: `readyState` [dom-mediastreamtrack-readystate]

> On getting, the `readyState` attribute MUST return this.[[ReadyState]].

Returns `"live"` or `"ended"`.

## Method: `stop()` [dom-mediastreamtrack-stop]

When invoked:
1. Let `track` be the current `MediaStreamTrack` object.
2. If `track`'s [[ReadyState]] is `"ended"`, then abort these steps.
3. Notify `track`'s source that `track` is ended.
4. Set `track`'s [[ReadyState]] to `"ended"`.

## Method: `clone()` [dom-mediastreamtrack-clone]

> When the `clone()` method is invoked, the User Agent MUST return the result of clone-a-track with this.

## Method: `getCapabilities()` [dom-mediastreamtrack-getcapabilities]

Returns the capabilities of the source that this `MediaStreamTrack` represents.

## Method: `getConstraints()` [dom-mediastreamtrack-getconstraints]

Returns the constraints currently applied to the track (per ConstrainablePattern Interface).

## Method: `getSettings()` [dom-mediastreamtrack-getsettings]

When invoked:
1. Let `track` be the current `MediaStreamTrack`.
2. If `track`'s [[ReadyState]] is `"ended"`:
   - Let `settings` be a new `MediaTrackSettings`.
   - For each property of the list of inherent constrainable track properties, add a corresponding property to `settings` if `track` had such property at the time it was ended, with the value at that time.
   - Return `settings`.
3. Return the current settings of the track per ConstrainablePattern Interface.

## Method: `applyConstraints(constraints)` [dom-mediastreamtrack-applyconstraints]

When invoked:
1. Let `track` be the current `MediaStreamTrack`.
2. If `track`'s [[ReadyState]] is `"ended"`, return a resolved promise.
3. Otherwise, invoke and return the result of the applyConstraints template method.

## Event: setting muted state [dom-mediastreamtrack-mute-algorithm]

To set a track's muted state to `newState`:
1. Let `track` be the `MediaStreamTrack` in question.
2. If `track.[[Muted]]` is already `newState`, abort.
3. Set `track.[[Muted]]` to `newState`.
4. If `newState` is `true` let `eventName` be `"mute"`, otherwise `"unmute"`.
5. Fire an event named `eventName` on `track`.

## Event: `ended` [event-mediastreamtrack-ended]

When a `MediaStreamTrack` ends for any reason other than `stop()` being invoked, the User Agent MUST queue a task that runs:
1. If `track`'s [[ReadyState]] has the value `"ended"` already, abort.
2. Set `track`'s [[ReadyState]] to `"ended"`.
3. Notify `track`'s [[Source]] that `track` is ended so that the source may be stopped, unless other `MediaStreamTrack` objects depend on it.
4. Fire an event named `ended` at the object.

---

# MediaDevices Interface [dom-mediadevices]

## Method: `getUserMedia(constraints)` [dom-mediadevices-getusermedia]

The `getUserMedia()` method prompts the user for permission to use media input devices and obtains `MediaStreamTrack` objects representing the sources selected by the user.

When invoked:
1. Let `constraints` be the method's argument.
2. Validate `constraints` per [Constrainable Pattern](https://www.w3.org/TR/mediacapture-streams/#constrainable-interface).
3. Prompt the user for permission to access the requested media input devices.
4. Enumerate available devices matching `constraints`.
5. For each device, check if it can satisfy `constraints`.
6. Select appropriate device(s) based on `constraints` and user selection.
7. Create `MediaStreamTrack` object(s) for the selected device(s).
8. Return a `Promise` that resolves with a `MediaStream` containing the track(s).

Returns `Promise<MediaStream>`.

## Method: `enumerateDevices()` [dom-mediadevices-enumeratedevices]

> The `enumerateDevices()` method returns a `Promise` that, when resolved, returns a sequence of `MediaDeviceInfo` objects representing the input and output devices available to the User Agent.

Returns `Promise<sequence<MediaDeviceInfo>>`.

## Method: `getSupportedConstraints()` [dom-mediadevices-getsupportedconstraints]

> The `getSupportedConstraints()` method returns a `MediaTrackSupportedConstraints` object listing the constraints supported by the User Agent.

---

# Errors

## NotAllowedError [error-notallowederror]

Thrown when:
- User denies permission to access media input devices
- The operation is not allowed for security or permissions reasons

## NotFoundError [error-notfounderror]

Thrown when:
- No suitable media input devices can be found matching the constraints
- A requested device is not available

## NotReadableError [error-notreadableerror]

Thrown when:
- The User Agent cannot access the media input device due to hardware or system issues
- Device is already in use by another application in an exclusive manner

## OverconstrainedError [error-overconstrainederror]

Thrown when:
- The constraints cannot be satisfied by any available device
- Required constraints conflict with each other

OverconstrainedError carries a `.constraint` field naming the offending constraint.

## TypeError [error-typeerror]

Thrown when:
- Invalid constraint syntax or values are provided
- Required arguments are missing or malformed
- Neither `audio` nor `video` is requested

---

# HTMLMediaElement extensions

The mediacapture-streams spec [§6 MediaStreams in Media Elements](https://www.w3.org/TR/mediacapture-streams/#mediastreams-as-media-elements) describes how a `MediaStream` interacts with an `HTMLMediaElement` via the `srcObject` attribute, but most of the normative element behavior is defined in the HTML Standard. The key MUSTs for our subset are summarized in [LLP 0004](./0004-htmlmediaelement-srcobject.spec.md); upstream references are:

- HTML Standard, [`HTMLMediaElement.srcObject`](https://html.spec.whatwg.org/multipage/media.html#dom-media-srcobject)
- HTML Standard, [Media element: load algorithm with MediaProvider](https://html.spec.whatwg.org/multipage/media.html#concept-media-load-resource)
- HTML Standard, [readyState constants](https://html.spec.whatwg.org/multipage/media.html#ready-states)

Specifically (as constraints for our `<Video srcObject>` implementation, paraphrased from the above):

- `readyState` MUST transition `HAVE_NOTHING → HAVE_ENOUGH_DATA` upon successfully decoding the first frame; `loadeddata` is fired at that transition.
- `duration` returns `NaN` for an unloaded MediaStream source and `Infinity` once loaded; `durationchange` fires on the change.
- `seekable.length` is `0` for a MediaStream source.
- `buffered.length` is `0` for a MediaStream source.
- `currentTime` setter MUST be ignored for a MediaStream source.
- `playbackRate` and `defaultPlaybackRate` MUST always be `1`; setters are ignored.
- `preload` MUST be `"none"`; setter is ignored.
- `ended` becomes `true` when all tracks in the `srcObject` have ended; `ended` event fires asynchronously.

---

# How `@ref` annotations should cite this LLP

- For a spec-mandated algorithm step or attribute behavior, prefer `@ref LLP 0008#<anchor>` (e.g. `@ref LLP 0008#dom-mediastreamtrack-stop`).
- For our **scoping decision** about a clause (e.g. why something is stubbed), keep the existing `@ref LLP 0001#…` pointing into the spec-subset index.
- For our **iOS mapping rationale** (which AVFoundation primitive backs which spec clause), keep `@ref LLP 0005#…`.

A single line can carry both, e.g.:

```swift
// @ref LLP 0008#dom-mediastreamtrack-stop — spec algorithm
// @ref LLP 0001#mediastreamtrack-stop      — our subset notes
func stop() { … }
```
