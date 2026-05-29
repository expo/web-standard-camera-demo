// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/MediaDevices-after-discard.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaDevices-after-discard.https.html

import { wptSource, test, assert_equals, assert_throws_dom, assert_true, promise_test, setMediaPermission, setup } from '../testharness';

wptSource('MediaDevices-after-discard.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
let devices;
let child_DOMException;
setup(() => {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  devices = frame.contentWindow.navigator.mediaDevices;
  child_DOMException = frame.contentWindow.DOMException;
  frame.remove();
});

// https://w3c.github.io/mediacapture-main/#dom-mediadevices-getusermedia
// If the current settings object's responsible document is NOT fully active,
// return a promise rejected with a DOMException object whose name attribute
// has the value "InvalidStateError".
promise_test(async () => {
  await setMediaPermission("granted", ["microphone"]);
  // `catch()` is used rather than static Promise methods because microtasks
  // for `PromiseResolve()` do not run when Promises in inactive Documents are
  // involved.  Whether microtasks for `catch()` run depends on the realm of
  // the handler rather than the realm of the Promise.
  // See https://github.com/whatwg/html/issues/5319.
  let promise_already_rejected = false;
  let rejected_reason;
  devices.getUserMedia({audio:true}).catch(reason => {
    promise_already_rejected = true;
    rejected_reason = reason;
  });
  // Race a settled promise to check that the returned promise is already
  // rejected.
  await Promise.reject().catch(() => {
    assert_true(promise_already_rejected,
                'should have returned an already-rejected promise.');
    assert_throws_dom('InvalidStateError', child_DOMException,
                      () => { throw rejected_reason });
  });
}, 'getUserMedia() in a discarded browsing context');

// https://w3c.github.io/mediacapture-main/#dom-mediadevices-enumeratedevices
// https://w3c.github.io/mediacapture-main/#device-enumeration-can-proceed
// Device enumeration can proceed steps return false when device enumeration
// can be exposed is true and the document is not fully active.
promise_test(async () => {
  let promise_state = 'pending';
  // `then()` is used to avoid methods that apply `PromiseResolve()` to
  // Promises from inactive realms, which would lead to microtasks that don't
  // run.
  devices.enumerateDevices().then(() => promise_state = 'resolved',
                                  () => promise_state = 'rejected');
  // Enumerate in the parent document to provide enough time to check that the
  // Promise from the inactive document does not settle.
  await navigator.mediaDevices.enumerateDevices();
  assert_equals(promise_state, 'pending', 'Promise state');
}, 'enumerateDevices() in a discarded browsing context');
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaDevices-after-discard.https.html — module load failed');
}
