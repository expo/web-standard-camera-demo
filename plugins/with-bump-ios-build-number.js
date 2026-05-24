const { withXcodeProject } = require('expo/config-plugins');

// Add a Run Script build phase to the iOS app target that bumps
// CFBundleVersion on every Xcode build. The phase runs after "Process
// Info.plist" (which produces ${TARGET_BUILD_DIR}/${INFOPLIST_PATH}) and
// before "Code Sign", so the bumped value gets baked into the signed app.
//
// We use a build phase rather than a withInfoPlist prebuild mod because
// `expo run:ios` skips prebuild when ios/ already exists. Build phases
// live in the pbxproj, which prebuild *does* regenerate, so the phase
// keeps firing on every successive xcodebuild without needing a prebuild
// each time.
//
// The counter file (build-number.txt at the repo root) is the durable
// record of the most recently produced build number. Each build reads
// it, writes back current + 1, and patches CFBundleVersion to the new
// value.

const BUILD_PHASE_NAME = 'Bump CFBundleVersion';

const SCRIPT = `#!/bin/sh
set -euo pipefail
COUNTER="\${PROJECT_DIR}/../build-number.txt"
if [ -f "$COUNTER" ]; then
  current=$(tr -d '[:space:]' < "$COUNTER")
else
  current=0
fi
case "$current" in
  ''|*[!0-9]*) current=0 ;;
esac
next=$((current + 1))
echo "$next" > "$COUNTER"
INFO_PLIST="\${TARGET_BUILD_DIR}/\${INFOPLIST_PATH}"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $next" "$INFO_PLIST"
echo "Bumped CFBundleVersion to $next"
`;

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withBumpIosBuildNumber = (config) => {
  return withXcodeProject(config, (config) => {
    const proj = config.modResults;
    if (findBuildPhaseUuid(proj, BUILD_PHASE_NAME) != null) {
      return config;
    }
    const target = proj.getFirstTarget();
    const result = proj.addBuildPhase(
      [],
      'PBXShellScriptBuildPhase',
      BUILD_PHASE_NAME,
      target.uuid,
      {
        shellPath: '/bin/sh',
        shellScript: SCRIPT,
        inputPaths: [],
        outputPaths: [],
      }
    );
    // Tell Xcode to skip dependency analysis and run the script every
    // build. Without this the script would be marked "up-to-date" once
    // its (empty) inputs/outputs stopped changing.
    result.buildPhase.alwaysOutOfDate = 1;
    return config;
  });
};

/**
 * @param {any} proj
 * @param {string} name
 * @returns {string | null}
 */
function findBuildPhaseUuid(proj, name) {
  const phases = proj.hash.project.objects.PBXShellScriptBuildPhase || {};
  for (const [uuid, phase] of Object.entries(phases)) {
    if (typeof phase === 'object' && phase && phase.name) {
      const phaseName = String(phase.name).replace(/^"|"$/g, '');
      if (phaseName === name) {
        return uuid;
      }
    }
  }
  return null;
}

module.exports = withBumpIosBuildNumber;
