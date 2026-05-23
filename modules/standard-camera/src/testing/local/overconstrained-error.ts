// @ref LLP 0002#gum-validate-constraints — audio request rejects.
//
// Not a WPT port: the upstream `overconstrained_error.https.html` covers the
// general DOMException-inheritance assertion. This file covers the v1-specific
// behavior of rejecting any audio request with `OverconstrainedError(constraint="audio")`
// — see [LLP 0001](../../../../llp/0001-spec-subset-scope.spec.md).

import { assert_equals, assert_unreached, promise_test, wptSource } from '../testharness';

wptSource(null);

promise_test(async () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true } as any);
    for (const t of stream.getTracks()) t.stop();
    assert_unreached('audio-only getUserMedia should have failed (v1 has no audio)');
  } catch (e) {
    const err = e as Error & { constraint?: string };
    assert_equals(err.name, 'OverconstrainedError', 'audio-only rejects with OverconstrainedError');
    assert_equals(err.constraint, 'audio', 'constraint field is "audio"');
  }
}, 'Audio-only getUserMedia rejects with OverconstrainedError(constraint="audio") in v1');
