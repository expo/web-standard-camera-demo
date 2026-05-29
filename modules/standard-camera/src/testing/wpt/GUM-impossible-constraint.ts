// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/GUM-impossible-constraint.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/GUM-impossible-constraint.https.html

import { wptSource, test, assert_equals, assert_unreached, promise_test } from '../testharness';

wptSource('GUM-impossible-constraint.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
[
  // Note - integer conversion is weird for +inf and numbers > 2^32, so we
  // use a number less than 2^32 for testing.
  {width: {min:100000000}},
  {width: {max: 0}},
  {height: {max: 0}},
  {frameRate: {max: 0}},
  {width: {max: -1}},
  {height: {max: -1}},
  {frameRate: {max: -1}},
  {width: {min: 100, max: 10}},
  {height: {min: 100, max: 10}},
  {frameRate: {min: 100, max: 10}},
].forEach(constraints => promise_test(async t => {
  try {
    await navigator.mediaDevices.getUserMedia({video: constraints});
    assert_unreached('getUserMedia hould have rejected');
  } catch (err) {
    assert_equals(err.name, 'OverconstrainedError', "An impossible constraint triggers a OverconstrainedError");
    assert_equals(err.constraint, Object.keys(constraints)[0], "The name of the not satisfied constraint is given in error.constraint");
  }
}, `getUserMedia(${JSON.stringify(constraints)}) must fail with OverconstrainedError`));
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'GUM-impossible-constraint.https.html — module load failed');
}
