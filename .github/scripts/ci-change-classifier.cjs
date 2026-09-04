const path = require("node:path");

const ROOT_DOCUMENTATION = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
]);
const DOCUMENTATION_BASENAMES = new Set([
  "CHANGELOG.md",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "UPSTREAM.md",
]);
const CI_CONTROL_FILES = new Set([
  ".github/workflows/ci.yml",
  ".github/scripts/ci-change-classifier.cjs",
  ".github/scripts/ci-change-classifier.test.cjs",
]);
const WORKSPACE_NODE_INPUTS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "vite.config.ts",
]);
const SERVER_TEST_PACKAGE_ROOTS = [
  "packages/contracts/",
  "packages/effect-acp/",
  "packages/effect-codex-app-server/",
  "packages/shared/",
  "packages/tailscale/",
];
const SERVER_TEST_EXACT_INPUTS = new Set([
  "apps/mobile/src/lib/threadActivity.ts",
  "apps/web/src/lib/contextWindow.ts",
  "apps/web/src/session-logic.ts",
]);
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
  "packages/shared/package.json",
  "packages/shared/src/hostProcess.ts",
  "packages/shared/src/shell.ts",
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

function isDocumentationOrMetadata(file) {
  const basename = path.posix.basename(file);
  return (
    ROOT_DOCUMENTATION.has(file) ||
    DOCUMENTATION_BASENAMES.has(basename) ||
    /\.mdx?$/i.test(file) ||
    file === ".coderabbit.yaml" ||
    file === ".env.example" ||
    file === ".mcp.json" ||
    file.startsWith("docs/") ||
    file.startsWith(".plans/") ||
    file.startsWith(".repos/") ||
    file.startsWith(".agents/") ||
    file.startsWith(".claude/") ||
    file.startsWith(".codex/") ||
    file.startsWith(".cursor/") ||
    file.startsWith(".macroscope/") ||
    file.startsWith(".vscode/") ||
    file.startsWith(".devcontainer/") ||
    file === ".github/CODEOWNERS" ||
    file === ".github/VOUCHED.td" ||
    file === ".github/pull_request_template.md" ||
    file.startsWith(".github/ISSUE_TEMPLATE/") ||
    file.startsWith(".github/triage/")
  );
}

function isGeneratedMobileNativePath(file) {
  return file.startsWith("apps/mobile/ios/") || file.startsWith("apps/mobile/android/");
}

function isMobileNativeInput(file) {
  if (isDocumentationOrMetadata(file) || isGeneratedMobileNativePath(file)) {
    return false;
  }
  return (
    MOBILE_NATIVE_EXACT_INPUTS.has(file) ||
    (file.startsWith("apps/mobile/") && file.endsWith("/.editorconfig")) ||
    (file.startsWith("apps/mobile/") && /\.(?:swift|kt|kts)$/.test(file))
  );
}

function isMobileNativeOnlyInput(file) {
  return (
    isGeneratedMobileNativePath(file) ||
    (isMobileNativeInput(file) &&
      !MOBILE_NATIVE_EXACT_INPUTS.has(file) &&
      (file.endsWith("/.editorconfig") || /\.(?:swift|kt|kts)$/.test(file))) ||
    [
      "apps/mobile/Brewfile",
      "apps/mobile/.swiftlint.yml",
      "apps/mobile/.editorconfig",
      "apps/mobile/detekt.yml",
    ].includes(file)
  );
}

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

function isRustInput(file) {
  return file.startsWith("native/resource-monitor/");
}

function isCheckInput(file) {
  return (
    !isDocumentationOrMetadata(file) &&
    !file.startsWith(".github/workflows/") &&
    !isRustInput(file) &&
    !isMobileNativeOnlyInput(file)
  );
}

function isWorkspaceNodeInput(file) {
  return (
    WORKSPACE_NODE_INPUTS.has(file) ||
    file.startsWith("patches/") ||
    file.startsWith(".vite-hooks/")
  );
}

function isNonServerTestInput(file) {
  if (
    isDocumentationOrMetadata(file) ||
    isRustInput(file) ||
    isMobileNativeOnlyInput(file) ||
    file.startsWith(".github/")
  ) {
    return false;
  }
  if (isWorkspaceNodeInput(file)) return true;
  if (file.startsWith("apps/server/") || file.startsWith("apps/marketing/")) return false;
  if (
    file.startsWith("apps/web/") ||
    file.startsWith("apps/desktop/") ||
    file.startsWith("apps/mobile/") ||
    file.startsWith("packages/") ||
    file.startsWith("scripts/") ||
    file.startsWith("infra/") ||
    file.startsWith("oxlint-plugin-t3code/")
  ) {
    return true;
  }
  if (file.startsWith("assets/") || file.startsWith("packaging/") || file === "t3.json") {
    return false;
  }
  return true;
}

function isServerTestInput(file) {
  if (
    isDocumentationOrMetadata(file) ||
    isRustInput(file) ||
    isMobileNativeOnlyInput(file) ||
    file.startsWith(".github/")
  ) {
    return false;
  }
  if (isWorkspaceNodeInput(file)) return true;
  if (SERVER_TEST_EXACT_INPUTS.has(file)) return true;
  if (file.startsWith("apps/server/") || file.startsWith("scripts/")) return true;
  if (SERVER_TEST_PACKAGE_ROOTS.some((root) => file.startsWith(root))) return true;
  if (
    file.startsWith("apps/") ||
    file.startsWith("packages/") ||
    file.startsWith("infra/") ||
    file.startsWith("oxlint-plugin-t3code/") ||
    file.startsWith("assets/") ||
    file.startsWith("packaging/") ||
    file === "t3.json"
  ) {
    return false;
  }
  return true;
}

function allGates(value) {
  return {
    check: value,
    fullCheck: value,
    test: value,
    testServer: value,
    rust: value,
    mobileNative: value,
    releaseSmoke: value,
  };
}

function classifyChangedPaths(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return allGates(true);
  }
  if (files.some((file) => CI_CONTROL_FILES.has(file))) {
    return allGates(true);
  }

  const workflowChanged = files.some((file) => file.startsWith(".github/workflows/"));
  const fullCheck = files.some(isCheckInput);
  return {
    check: fullCheck || workflowChanged,
    fullCheck,
    test: files.some(isNonServerTestInput),
    testServer: files.some(isServerTestInput),
    rust: files.some(isRustInput),
    mobileNative: files.some(isMobileNativeInput),
    releaseSmoke: files.some(isReleaseSmokeInput),
  };
}

async function run({ github, context, core }) {
  const pathsFromRows = (rows) =>
    rows.flatMap((row) =>
      row.previous_filename ? [row.filename, row.previous_filename] : [row.filename],
    );
  let files = [];

  if (context.eventName === "pull_request") {
    const rows = await github.paginate(github.rest.pulls.listFiles, {
      ...context.repo,
      pull_number: context.payload.pull_request.number,
      per_page: 100,
    });
    const expected = context.payload.pull_request.changed_files;
    files =
      Number.isSafeInteger(expected) && rows.length === expected && rows.length < 3_000
        ? pathsFromRows(rows)
        : [];
  } else if (context.eventName === "push") {
    const comparison = await github.rest.repos.compareCommitsWithBasehead({
      ...context.repo,
      basehead: `${context.payload.before}...${context.payload.after}`,
      per_page: 100,
    });
    const comparedFiles = comparison.data.files ?? [];
    files = comparedFiles.length < 300 ? pathsFromRows(comparedFiles) : [];
  }

  const classification = classifyChangedPaths(files);
  const outputs = {
    check: classification.check,
    full_check: classification.fullCheck,
    test: classification.test,
    test_server: classification.testServer,
    rust: classification.rust,
    mobile_native: classification.mobileNative,
    release_smoke: classification.releaseSmoke,
  };
  for (const [key, value] of Object.entries(outputs)) {
    core.setOutput(key, String(value));
  }
}

module.exports = { classifyChangedPaths, run };
