// Whether a change needs the Conn Server checks: the workflow's `changes` job runs this on the
// full diff (`paths` filters see only 3,000 files). scripts/conn-server-checks-paths.test.ts
// fails when a file the checks read is not selected.
// Usage: node .github/scripts/conn-server-checks-paths.cjs <`git diff -z --name-only` output>
const fs = require("node:fs");

// GitHub path filter syntax: `**` crosses folders, `*` does not, and the last matching
// pattern decides (`!` excludes).
// Files the checks' tools read. Tools also find config by walking up from these (rustfmt,
// clippy, postcss, tsconfig, .npmrc, .gitattributes...), so ANCESTOR_DIRS adds that config.
const READ = [
  "apps/conn-server/**",
  "apps/server/**",
  // Every package apps/server imports, and annotation-overlay, whose `prepare` builds on `vp i`.
  "packages/**",
  "!packages/client-runtime/**",
  "packages/client-runtime/src/authorization/remote.ts",
  "packages/client-runtime/src/connection/compatibility.ts",
  "packages/client-runtime/src/connection/model.ts",
  "packages/client-runtime/src/environment/descriptor.ts",
  "packages/client-runtime/src/environment/endpoint.ts",
  "packages/client-runtime/src/errors/translatable.ts",
  "packages/client-runtime/src/orbitGateway/client.ts",
  "packages/client-runtime/src/orbitGateway/operationNotices.ts",
  "packages/client-runtime/src/orbitGateway/realtimeSubscription.ts",
  "packages/client-runtime/src/platform/capabilities.ts",
  "packages/client-runtime/src/providerClients.ts",
  "packages/client-runtime/src/rpc/http.ts",
  "packages/client-runtime/src/sourceControlClients.ts",
  "packages/client-runtime/src/state/models.ts",
  "packages/client-runtime/src/state/orchestrationV2Projection.ts",
  "packages/client-runtime/src/state/shellReducer.ts",
  "packages/client-runtime/src/state/subagentDisplay.ts",
  "packages/client-runtime/src/state/subagentRuntime.ts",
  "packages/client-runtime/src/state/threadCheckpoints.ts",
  "packages/client-runtime/src/state/threadExecution.ts",
  "packages/client-runtime/src/state/threadRelationships.ts",
  "packages/client-runtime/src/threadPullRequests.ts",
  "packages/client-runtime/src/work-log/commandLabel.ts",
  "infra/task-cache/src/remoteCache.ts",
  "scripts/lib/brand-assets.ts",
  "scripts/lib/cached-tests.ts",
  "scripts/lib/cli-executable-imports.ts",
  "scripts/lib/cli-external-packages.ts",
  "scripts/lib/linux-arm64-sea.ts",
  "scripts/lib/public-config.ts",
  "scripts/lib/tagged-source-version.ts",
  // Imported by scripts/e2e.config.ts and scripts/mobile-showcase.config.ts, which the
  // ancestor rule selects as config.
  "scripts/mobile-showcase-environment.ts",
  "scripts/scenarios/shell.ts",
];

// Inputs read by name, not by walking up from them: no config above them counts.
const OTHER = [
  // Install inputs, with the tarballs pnpm-lock.yaml installs from.
  "**/package.json",
  "patches/**",
  "apps/mobile/deps/*.tgz",
  // Cargo reads `.cargo/config.toml` in every folder above the crate.
  "**/.cargo/**",
  // Git applies `.gitattributes` above every file it checks out (line endings of a workflow
  // or a tarball), and by-name inputs such as package.json sit in any folder. Nothing else
  // reads config above these inputs, so the full ancestor rule stays with READ.
  "**/.gitattributes",
  // tools/check.sh checks the Rust toolchain pin in all three.
  ".github/workflows/conn-server-checks.yml",
  ".github/workflows/conn-server-ci.yml",
  ".github/workflows/conn-server-release.yml",
  ".github/scripts/conn-server-checks-paths.cjs",
];

// Vendored references; no job checks them out.
const PATHS = [...READ, ...OTHER, "!.repos/**"];

/** The folders above a READ pattern's files: the root, `apps/`, `packages/client-runtime/`... */
const ANCESTOR_DIRS = new Set(
  READ.filter((path) => !path.startsWith("!")).flatMap((path) => {
    const folders = path.split(/[*?]/)[0].split("/").slice(0, -1);
    return folders.map((_, index) => folders.slice(0, index).join("/")).concat(folders.join("/"));
  }),
);
// Source modules run only when imported, and the test follows imports; docs configure nothing.
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const CONFIG_NAMED = /^\.|\.config\.[^/]+$|rc(\.[^/]+)?$/;
const DOCS = /\.md$|^LICENSE/i;

/** A non-source file directly in a folder above files the checks read, such as rustfmt.toml. */
function isAncestorConfig(file) {
  const slash = file.lastIndexOf("/");
  const name = file.slice(slash + 1);
  if (!ANCESTOR_DIRS.has(slash === -1 ? "" : file.slice(0, slash))) return false;
  if (DOCS.test(name)) return false;
  return !SOURCE.test(name) || CONFIG_NAMED.test(name);
}

function globToRegExp(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (glob.startsWith("**/", index)) {
      pattern += "(?:[\\s\\S]*/)?";
      index += 2;
    } else if (glob.startsWith("**", index)) {
      pattern += "[\\s\\S]*";
      index += 1;
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

const RULES = PATHS.map((path) => ({
  exclude: path.startsWith("!"),
  glob: globToRegExp(path.replace(/^!/, "")),
}));

const OTHER_RULES = OTHER.map(globToRegExp);

/** Whether the file is an input read only by name (a manifest, a tarball, a workflow). */
function readByName(file) {
  return OTHER_RULES.some((glob) => glob.test(file));
}

function matches(file) {
  const included = RULES.reduce(
    (matched, rule) => (rule.glob.test(file) ? !rule.exclude : matched),
    false,
  );
  // `.repos/` is never an ancestor folder, so this keeps its exclusion.
  return included || isAncestorConfig(file);
}

function main() {
  // NUL-separated: git quotes other names with unusual characters, and a name may hold "\n".
  const files = fs.readFileSync(process.argv[2], "utf8").split("\0").filter(Boolean);
  const hit = files.find(matches);
  console.error(
    hit
      ? `Runs the checks: ${JSON.stringify(hit)}`
      : `None of ${files.length} changed files is read.`,
  );
  console.log(`run=${Boolean(hit)}`);
}

if (require.main === module) main();

module.exports = { PATHS, ANCESTOR_DIRS, matches, readByName };
