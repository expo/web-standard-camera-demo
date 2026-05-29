// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/MediaStream-MediaElement-preload-none.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStream-MediaElement-preload-none.https.html

import { wptSource, test, assert_equals, assert_unreached, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaStream-MediaElement-preload-none.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
async function testPreloadNone(mediaElement, stream)
            {
                let rejectSuspendedPromise, rejectErrorPromise, resolveDataLoadedPromise;
                const suspended = new Promise((r, rej) => {
                  rejectSuspendedPromise = rej;
                });
                const errored = new Promise((r, rej) => {
                  rejectErrorPromise = rej;
                });
                const loaded = new Promise(resolve => {
                  resolveDataLoadedPromise = resolve;
                });

                // The optional deferred load steps (for preload none) for MediaStream resources should be skipped.
                mediaElement.addEventListener("suspend", () => {
                  rejectSuspendedPromise("'suspend' should not be fired.")
                });
                mediaElement.addEventListener("error", () => {
                  rejectErrorPromise("'error' should not be fired, code=" + mediaElement.error.code);
                });

                mediaElement.addEventListener("loadeddata", () => {
                  assert_equals(mediaElement.networkState, mediaElement.NETWORK_LOADING);
                  resolveDataLoadedPromise();
                });

                mediaElement.srcObject = stream;
                assert_equals(mediaElement.networkState, mediaElement.NETWORK_NO_SOURCE); // Resource selection is active.
                try {
                  await Promise.race([suspended, errored, loaded]);
                } catch (msg) {
                  assert_unreached(msg);
                }
2            }

            promise_test(async () =>
            {
                const aud = document.querySelector("audio");
                // camera is needed for the next test, asking for both at once
                await setMediaPermission();
                let stream;
                try {
                  stream = await navigator.mediaDevices.getUserMedia({audio:true});
                } catch (e) {
                  assert_unreached("getUserMedia error callback was invoked.");
                }
                await testPreloadNone(aud, stream);
            }, "Test that preload 'none' is ignored for MediaStream object URL used as srcObject for audio");

            promise_test(async () =>
            {
                const vid = document.querySelector("video");
                let stream;
                try {
                  stream = await navigator.mediaDevices.getUserMedia({video:true});
                } catch (e) {
                  assert_unreached("getUserMedia error callback was invoked.")
                }
                await testPreloadNone(vid, stream);

            }, "Test that preload 'none' is ignored for MediaStream used as srcObject for video");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStream-MediaElement-preload-none.https.html — module load failed');
}
