const path = require("node:path");

const ROOT_DOCUMENTATION = new Set(["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "README.md"]);
const DOCUMENTATION_BASENAMES = new Set(["README.md", "THIRD_PARTY_NOTICES.md", "UPSTREAM.md"]);
const MOBILE_NATIVE_EXACT_INPUTS = new Set([
  ".editorconfig",
  "apps/.editorconfig",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/mobile/package.json",
  "apps/mobile/Brewfile",
  "apps/mobile/.swiftlint.yml",
  "apps/mobile/.editorconfig",
  "apps/mobile/detekt.yml",
  "scripts/package.json",
  "scripts/mobile-native-static-check.ts",
]);
const RELEASE_EXACT_INPUTS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".github/workflows/release.yml",
  "scripts/release-smoke.ts",
  "scripts/update-release-package-versions.ts",
  "scripts/resolve-nightly-release.ts",
  "scripts/merge-update-manifests.ts",
  "scripts/lib/update-manifest.ts",
  "packages/shared/src/schemaJson.ts",
]);

function isReleaseSmokeInput(file) {
  if (isDocumentationOrMetadata(file)) {
    return false;
  }
  return (
    RELEASE_EXACT_INPUTS.has(file) ||
    file.endsWith("/package.json") ||
    file.startsWith("patches/") ||
    file.startsWith("apps/mobile/deps/")
  );
}

function isMobileNativeInput(file) {
  if (isDocumentationOrMetadata(file)) {
    return false;
  }
  if (file.startsWith("apps/mobile/ios/") || file.startsWith("apps/mobile/android/")) {
    return false;
  }
  return (
    MOBILE_NATIVE_EXACT_INPUTS.has(file) ||
    file.startsWith("packages/shared/") ||
    (file.startsWith("apps/mobile/") && file.endsWith("/.editorconfig")) ||
    (file.startsWith("apps/mobile/") && /\.(?:swift|kt|kts)$/.test(file))
  );
}

function isDocumentationOrMetadata(file) {
  const basename = path.posix.basename(file);
  return (
    ROOT_DOCUMENTATION.has(file) ||
    DOCUMENTATION_BASENAMES.has(basename) ||
    /\.mdx?$/i.test(file) ||
    file.startsWith("docs/") ||
    file.startsWith(".plans/") ||
    file.startsWith(".repos/") ||
    (file.startsWith(".agents/skills/") && file.endsWith(".md")) ||
    (file.startsWith(".macroscope/") && file.endsWith(".md")) ||
    file === ".github/VOUCHED.td" ||
    file === ".github/pull_request_template.md" ||
    file.startsWith(".github/ISSUE_TEMPLATE/") ||
    file.startsWith(".github/pr-assets/") ||
    file.startsWith(".github/triage/")
  );
}

function classifyChangedPaths(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      check: true,
      fullCheck: true,
      test: true,
      mobileNative: true,
      releaseSmoke: true,
    };
  }

  const ciControlChanged = files.some((file) =>
    [
      ".github/workflows/ci.yml",
      ".github/scripts/ci-change-classifier.cjs",
      ".github/scripts/ci-change-classifier.test.cjs",
    ].includes(file),
  );
  const workflowChanged = files.some((file) => file.startsWith(".github/workflows/"));
  const productChanged = files.some(
    (file) => !isDocumentationOrMetadata(file) && !file.startsWith(".github/workflows/"),
  );
  return {
    check: productChanged || workflowChanged,
    fullCheck: productChanged || ciControlChanged,
    test: productChanged || ciControlChanged,
    mobileNative: ciControlChanged || files.some(isMobileNativeInput),
    releaseSmoke: ciControlChanged || files.some(isReleaseSmokeInput),
  };
}

async function run({ github, context, core }) {
  let files = [];
  const pathsFromRows = (rows) =>
    rows.flatMap((row) =>
      row.previous_filename ? [row.filename, row.previous_filename] : [row.filename],
    );
  if (context.eventName === "pull_request") {
    const rows = await github.paginate(github.rest.pulls.listFiles, {
      ...context.repo,
      pull_number: context.payload.pull_request.number,
      per_page: 100,
    });
    files = rows.length >= 3_000 ? [] : pathsFromRows(rows);
  } else if (context.eventName === "push") {
    const comparison = await github.rest.repos.compareCommitsWithBasehead({
      ...context.repo,
      basehead: `${context.payload.before}...${context.payload.after}`,
      per_page: 100,
    });
    const comparedFiles = comparison.data.files ?? [];
    files = comparedFiles.length >= 300 ? [] : pathsFromRows(comparedFiles);
  }

  const classification = classifyChangedPaths(files);
  const outputs = {
    check: classification.check,
    full_check: classification.fullCheck,
    test: classification.test,
    mobile_native: classification.mobileNative,
    release_smoke: classification.releaseSmoke,
  };
  for (const [key, value] of Object.entries(outputs)) {
    core.setOutput(key, String(value));
  }
}

module.exports = { classifyChangedPaths, run };
