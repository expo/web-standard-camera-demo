const { withXcodeProject } = require('expo/config-plugins');

const BUILD_PHASE_NAME = 'Copy bundled TFJS model';

// @ref LLP 0012#demo-6-tensorflowjs-object-lens — TFJS COCO-SSD weight shards
// are binary assets, so iOS copies them into app resources for offline native use.
const SCRIPT = `#!/bin/sh
set -euo pipefail

MODEL_SRC="\${PROJECT_DIR}/../assets/models/coco-ssd-lite-mobilenet-v2"
MODEL_DST="\${TARGET_BUILD_DIR}/\${UNLOCALIZED_RESOURCES_FOLDER_PATH}/TfjsModels/coco-ssd-lite-mobilenet-v2"

if [ ! -d "$MODEL_SRC" ]; then
  echo "error: Missing bundled TFJS model directory at $MODEL_SRC" >&2
  exit 1
fi

rm -rf "$MODEL_DST"
mkdir -p "$MODEL_DST"
cp -R "$MODEL_SRC"/. "$MODEL_DST"/
echo "Copied bundled TFJS model to $MODEL_DST"
`;

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withBundledTfjsModel = (config) => {
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

module.exports = withBundledTfjsModel;
