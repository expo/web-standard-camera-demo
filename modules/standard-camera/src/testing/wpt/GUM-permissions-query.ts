// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/GUM-permissions-query.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/GUM-permissions-query.https.html

import { wptSource, test, assert_equals, assert_true, promise_test, setMediaPermission } from '../testharness';

wptSource('GUM-permissions-query.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async t => {
  let status = await navigator.permissions.query({name: "camera"});
  assert_equals(status.state, "prompt", "initial camera state is prompt");

  let eventFired = false;
  status.onchange = () => eventFired = true;

  // state is set by setMediaPermission in automation & by gUM when run manually
  await setMediaPermission("granted", ["camera"]);
  const stream = await navigator.mediaDevices.getUserMedia({video: true});
  t.add_cleanup(() => stream.getTracks()[0].stop());
  status.onchange = null; // defer assert to not overshadow main assert below

  status = await navigator.permissions.query({name: "camera"});
  assert_equals(status.state, "granted", "camera is granted after getUserMedia");
  assert_true(eventFired, "status.onchange fired for camera permission change");
}, "camera is granted after getUserMedia, according to permissions.query()");

promise_test(async t => {
  let status = await navigator.permissions.query({name: "microphone"});
  assert_equals(status.state, "prompt", "initial microphone state is prompt");
  let eventFired = false;
  status.onchange = () => eventFired = true;

  // state is set by setMediaPermission in automation & by gUM when run manually
  await setMediaPermission("granted", ["microphone"]);
  const stream = await navigator.mediaDevices.getUserMedia({audio: true});
  t.add_cleanup(() => stream.getTracks()[0].stop());
  status.onchange = null; // defer assert to not overshadow main assert below

  status = await navigator.permissions.query({name: "microphone"});
  assert_equals(status.state, "granted", "microphone is granted after getUserMedia");
  assert_true(eventFired, "status.onchange fired for microphone permission change");
}, "microphone is granted after getUserMedia, according to permissions.query()");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'GUM-permissions-query.https.html — module load failed');
}
