// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/MediaStream-id.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStream-id.https.html

import { wptSource, test, assert_equals, assert_regexp_match, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaStream-id.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
const allowedCharacters = /^[\u0021\u0023-\u0027\u002A-\u002B\u002D-\u002E\u0030-\u0039\u0041-\u005A\u005E-\u007E]*$/;
promise_test(async () => {
  await setMediaPermission("granted", ["camera"]);
  const stream = await navigator.mediaDevices.getUserMedia({video:true});
  assert_equals(stream.id.length, 36, "the media stream id has 36 characters");
  assert_regexp_match(stream.id, allowedCharacters, "the media stream id uses the set of allowed characters");
}, "Tests that a MediaStream with a correct id is returned");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStream-id.https.html — module load failed');
}
