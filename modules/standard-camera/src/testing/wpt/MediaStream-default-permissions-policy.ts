// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/MediaStream-default-permissions-policy.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStream-default-permissions-policy.https.html

import { wptSource, test, setMediaPermission } from '../testharness';

wptSource('MediaStream-default-permissions-policy.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
  async function gUM({audio, video}) {
    let stream;
    if (!page_loaded_in_iframe()) {
      await setMediaPermission();
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio, video});
      // getUserMedia must guarantee the number of tracks requested or fail.
      if ((audio && stream.getAudioTracks().length == 0) ||
          (video && stream.getVideoTracks().length == 0)) {
        throw {name: `All requested devices must be present with ` +
                     `audio ${audio} and video ${video}, or fail`};
      }
    } finally {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    }
  }

  async function must_disallow_gUM({audio, video}) {
    try {
      await gUM({audio, video});
    } catch (e) {
      if (e.name == 'NotAllowedError') {
        return;
      }
      throw e;
    }
    throw {name: `audio ${audio} and video ${video} constraints must not be ` +
                 `allowed.`};
  }

  const cross_domain = get_host_info().HTTPS_REMOTE_ORIGIN;
  run_all_fp_tests_allow_self(
    cross_domain,
    'microphone',
    'NotAllowedError',
    async () => {
      await gUM({audio: true});
      if (window.location.href.includes(cross_domain)) {
        await must_disallow_gUM({video: true});
        await must_disallow_gUM({audio: true, video: true});
      }
    }
  );

  run_all_fp_tests_allow_self(
    cross_domain,
    'camera',
    'NotAllowedError',
    async () => {
      await gUM({video: true});
      if (window.location.href.includes(cross_domain)) {
        await must_disallow_gUM({audio: true});
        await must_disallow_gUM({audio: true, video: true});
      }
    }
  );

  run_all_fp_tests_allow_self(
    cross_domain,
    'camera;microphone',
    'NotAllowedError',
    async () => {
      await gUM({audio: true, video: true});
      await gUM({audio: true});
      await gUM({video: true});
    }
  );
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStream-default-permissions-policy.https.html — module load failed');
}
