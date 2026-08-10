// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Repository governance runs at the Node CLI boundary and accepts an injected clock in tests.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const canonicalUpstreamRepository = "https://github.com/pingdotgg/t3code.git";
const defaultConfigPath = ".auldric/t3-baseline.json";

type JsonRecord = Record<string, unknown>;

interface BaselineConfig {
  readonly upstream: {
    readonly repository: string;
    readonly remote: string;
    readonly branch: string;
    readonly commit: string;
  };
  readonly classification: {
    readonly additiveMarketingRoots: ReadonlyArray<string>;
    readonly distributionConfigurationPaths: ReadonlyArray<string>;
    readonly permanentGovernanceFiles: ReadonlyArray<PermanentGovernanceFile>;
    readonly sharedCoreAllowlist: string;
  };
}

interface PermanentGovernanceFile {
  readonly path: string;
  readonly owner: string;
  readonly reason: string;
  readonly contentSha256: string;
  readonly test: string;
}

interface SharedCoreAllowlistEntry {
  readonly path: string;
  readonly owner: string;
  readonly reason: string;
  readonly expiresOn: string;
  readonly upstream: {
    readonly status: "proposed" | "accepted" | "rejected";
    readonly url: string;
  };
  readonly test: string;
}

interface GitChange {
  readonly status: string;
  readonly paths: ReadonlyArray<string>;
}

export type DriftCategory =
  | "additive-marketing"
  | "downstream-governance"
  | "distribution-configuration"
  | "temporary-shared-core-seam"
  | "unexpected-shared-core";

interface ClassifiedChange extends GitChange {
  readonly category: DriftCategory;
}

export interface BaselineReport {
  readonly ok: boolean;
  readonly repositoryRoot: string;
  readonly baseline: string;
  readonly release: string;
  readonly currentUpstream: string | null;
  readonly ancestry: {
    readonly baselineInRelease: boolean;
    readonly baselineInCurrentUpstream: boolean | null;
  };
  readonly commitDrift: {
    readonly baselineToRelease: {
      readonly behind: number;
      readonly ahead: number;
    };
    readonly releaseToCurrentUpstream: {
      readonly ahead: number;
      readonly behind: number;
    } | null;
  };
  readonly fileDrift: ReadonlyArray<ClassifiedChange>;
  readonly violations: ReadonlyArray<string>;
}

interface InspectOptions {
  readonly repoRoot: string;
  readonly fetchUpstream?: boolean;
  readonly verifyRemote?: boolean;
  readonly requireClean?: boolean;
  readonly now?: Date;
  readonly configPath?: string;
}

class BaselineConfigurationError extends Error {
  override readonly name = "BaselineConfigurationError";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new BaselineConfigurationError(`${label} must be an object`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BaselineConfigurationError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throw new BaselineConfigurationError(`${label} must be an array`);
  }
  return value.map((entry, index) => requireString(entry, `${label}[${index}]`));
}

function requireRepositoryPath(value: unknown, label: string): string {
  const path = requireString(value, label);
  if (
    NodePath.isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new BaselineConfigurationError(`${label} must be a safe repository-relative path`);
  }
  return path;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch (error) {
    throw new BaselineConfigurationError(
      `Cannot read valid JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function loadBaselineConfig(repoRoot: string, configPath: string): BaselineConfig {
  const path = NodePath.resolve(repoRoot, configPath);
  const raw = requireRecord(readJson(path), configPath);
  if (raw.schemaVersion !== 1) {
    throw new BaselineConfigurationError(`${configPath}.schemaVersion must be 1`);
  }

  const upstream = requireRecord(raw.upstream, `${configPath}.upstream`);
  const repository = requireString(upstream.repository, `${configPath}.upstream.repository`);
  const remote = requireString(upstream.remote, `${configPath}.upstream.remote`);
  const branch = requireString(upstream.branch, `${configPath}.upstream.branch`);
  const commit = requireString(upstream.commit, `${configPath}.upstream.commit`);
  if (repository !== canonicalUpstreamRepository || remote !== "upstream" || branch !== "main") {
    throw new BaselineConfigurationError(
      `${configPath}.upstream must remain ${canonicalUpstreamRepository} via upstream/main`,
    );
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new BaselineConfigurationError(`${configPath}.upstream.commit must be a full Git SHA`);
  }

  const classification = requireRecord(raw.classification, `${configPath}.classification`);
  const additiveMarketingRoots = requireStringArray(
    classification.additiveMarketingRoots,
    `${configPath}.classification.additiveMarketingRoots`,
  ).map((entry, index) =>
    requireRepositoryPath(entry, `${configPath}.classification.additiveMarketingRoots[${index}]`),
  );
  const distributionConfigurationPaths = requireStringArray(
    classification.distributionConfigurationPaths,
    `${configPath}.classification.distributionConfigurationPaths`,
  ).map((entry, index) =>
    requireRepositoryPath(
      entry,
      `${configPath}.classification.distributionConfigurationPaths[${index}]`,
    ),
  );
  if (!Array.isArray(classification.permanentGovernanceFiles)) {
    throw new BaselineConfigurationError(
      `${configPath}.classification.permanentGovernanceFiles must be an array`,
    );
  }
  const permanentGovernanceFiles = classification.permanentGovernanceFiles.map((value, index) => {
    const label = `${configPath}.classification.permanentGovernanceFiles[${index}]`;
    const entry = requireRecord(value, label);
    const contentSha256 = requireString(entry.contentSha256, `${label}.contentSha256`);
    if (!/^[0-9a-f]{64}$/u.test(contentSha256)) {
      throw new BaselineConfigurationError(`${label}.contentSha256 must be a lowercase SHA-256`);
    }
    return {
      path: requireRepositoryPath(entry.path, `${label}.path`),
      owner: requireString(entry.owner, `${label}.owner`),
      reason: requireString(entry.reason, `${label}.reason`),
      contentSha256,
      test: requireString(entry.test, `${label}.test`),
    };
  });
  const sharedCoreAllowlist = requireRepositoryPath(
    classification.sharedCoreAllowlist,
    `${configPath}.classification.sharedCoreAllowlist`,
  );

  return {
    upstream: { repository, remote, branch, commit },
    classification: {
      additiveMarketingRoots,
      distributionConfigurationPaths,
      permanentGovernanceFiles,
      sharedCoreAllowlist,
    },
  };
}

function parseDate(value: unknown, label: string): string {
  const date = requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new BaselineConfigurationError(`${label} must use YYYY-MM-DD`);
  }
  return date;
}

function loadAllowlist(
  repoRoot: string,
  path: string,
  today: string,
): ReadonlyMap<string, SharedCoreAllowlistEntry> {
  const raw = requireRecord(readJson(NodePath.resolve(repoRoot, path)), path);
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.entries)) {
    throw new BaselineConfigurationError(
      `${path} must contain schemaVersion 1 and an entries array`,
    );
  }

  const entries = new Map<string, SharedCoreAllowlistEntry>();
  for (const [index, value] of raw.entries.entries()) {
    const label = `${path}.entries[${index}]`;
    const entry = requireRecord(value, label);
    const entryPath = requireRepositoryPath(entry.path, `${label}.path`);
    const owner = requireString(entry.owner, `${label}.owner`);
    const reason = requireString(entry.reason, `${label}.reason`);
    const expiresOn = parseDate(entry.expiresOn, `${label}.expiresOn`);
    const upstream = requireRecord(entry.upstream, `${label}.upstream`);
    const status = requireString(upstream.status, `${label}.upstream.status`);
    if (status !== "proposed" && status !== "accepted" && status !== "rejected") {
      throw new BaselineConfigurationError(
        `${label}.upstream.status must be proposed, accepted, or rejected`,
      );
    }
    const upstreamUrl = requireString(upstream.url, `${label}.upstream.url`);
    if (!/^https:\/\/github\.com\/pingdotgg\/t3code\/(issues|pull)\/\d+$/.test(upstreamUrl)) {
      throw new BaselineConfigurationError(
        `${label}.upstream.url must link to a pingdotgg/t3code issue or pull request`,
      );
    }
    const test = requireString(entry.test, `${label}.test`);
    if (expiresOn < today) {
      throw new BaselineConfigurationError(`${label} expired on ${expiresOn}`);
    }
    if (entries.has(entryPath)) {
      throw new BaselineConfigurationError(`${label}.path duplicates ${entryPath}`);
    }
    entries.set(entryPath, {
      path: entryPath,
      owner,
      reason,
      expiresOn,
      upstream: { status, url: upstreamUrl },
      test,
    });
  }
  return entries;
}

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function runGitResult(repoRoot: string, args: ReadonlyArray<string>): GitResult {
  const result = NodeChildProcess.spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
  };
}

function runGit(repoRoot: string, args: ReadonlyArray<string>): string {
  const result = runGitResult(repoRoot, args);
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || "unknown error"}`);
  }
  return result.stdout;
}

function normalizeRepositoryUrl(url: string): string {
  return url
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

function parseAheadBehind(value: string, label: string): readonly [number, number] {
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 2 || parts.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    throw new Error(`Cannot parse ${label} ahead/behind result: ${value}`);
  }
  return [parts[0]!, parts[1]!];
}

export function parseNameStatus(value: string): ReadonlyArray<GitChange> {
  const tokens = value.split("\0");
  if (tokens.at(-1) === "") {
    tokens.pop();
  }
  const changes: Array<GitChange> = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++]!;
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    const paths = tokens.slice(index, index + pathCount);
    if (paths.length !== pathCount || paths.some((path) => path === "")) {
      throw new Error(`Cannot parse git name-status output at ${status}`);
    }
    changes.push({ status, paths });
    index += pathCount;
  }
  return changes;
}

function classifyChange(
  change: GitChange,
  baselinePaths: ReadonlySet<string>,
  config: BaselineConfig,
  releaseContentSha256: ReadonlyMap<string, string>,
  allowlist: ReadonlyMap<string, SharedCoreAllowlistEntry>,
): ClassifiedChange {
  const distributionPaths = new Set(config.classification.distributionConfigurationPaths);
  if (change.paths.every((path) => distributionPaths.has(path))) {
    return { ...change, category: "distribution-configuration" };
  }

  if (
    change.paths.every(
      (path) =>
        !baselinePaths.has(path) &&
        config.classification.additiveMarketingRoots.some((root) => path.startsWith(root)),
    )
  ) {
    return { ...change, category: "additive-marketing" };
  }

  const governanceFiles = new Map(
    config.classification.permanentGovernanceFiles.map((entry) => [entry.path, entry]),
  );
  if (
    change.paths.every((path) => {
      const entry = governanceFiles.get(path);
      return (
        baselinePaths.has(path) &&
        entry !== undefined &&
        releaseContentSha256.get(path) === entry.contentSha256
      );
    })
  ) {
    return { ...change, category: "downstream-governance" };
  }

  if (change.paths.every((path) => baselinePaths.has(path) && allowlist.has(path))) {
    return { ...change, category: "temporary-shared-core-seam" };
  }

  return { ...change, category: "unexpected-shared-core" };
}

function formatChange(change: ClassifiedChange): string {
  return `${change.status} ${change.paths.join(" -> ")} [${change.category}]`;
}

export function formatBaselineReport(report: BaselineReport): string {
  const lines = [
    `T3 baseline guard: ${report.ok ? "PASS" : "FAIL"}`,
    `baseline: ${report.baseline}`,
    `release: ${report.release}`,
    `current upstream: ${report.currentUpstream ?? "unavailable"}`,
    `baseline ancestor of release: ${report.ancestry.baselineInRelease ? "yes" : "no"}`,
    `baseline → release: ${report.commitDrift.baselineToRelease.behind} behind, ${report.commitDrift.baselineToRelease.ahead} ahead`,
  ];
  if (report.commitDrift.releaseToCurrentUpstream) {
    lines.push(
      `release → current upstream: ${report.commitDrift.releaseToCurrentUpstream.ahead} ahead, ${report.commitDrift.releaseToCurrentUpstream.behind} behind`,
    );
  }
  lines.push(`file drift: ${report.fileDrift.length} changed path set(s)`);
  lines.push(...report.fileDrift.map((change) => `  ${formatChange(change)}`));
  if (report.violations.length > 0) {
    lines.push("violations:", ...report.violations.map((violation) => `  - ${violation}`));
  }
  return lines.join("\n");
}

function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function inspectBaseline(options: InspectOptions): BaselineReport {
  const repoRoot = NodePath.resolve(options.repoRoot);
  const config = loadBaselineConfig(repoRoot, options.configPath ?? defaultConfigPath);
  const allowlist = loadAllowlist(
    repoRoot,
    config.classification.sharedCoreAllowlist,
    todayUtc(options.now ?? new Date()),
  );
  const violations: Array<string> = [];

  if (options.requireClean !== false) {
    const dirty = runGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]).trim();
    if (dirty !== "") {
      violations.push("working tree is not clean, so the release diff would be incomplete");
    }
  }

  if (options.verifyRemote !== false) {
    let remote = runGitResult(repoRoot, ["remote", "get-url", config.upstream.remote]);
    if (!remote.ok && options.fetchUpstream) {
      runGit(repoRoot, ["remote", "add", config.upstream.remote, config.upstream.repository]);
      remote = runGitResult(repoRoot, ["remote", "get-url", config.upstream.remote]);
    }
    if (!remote.ok) {
      violations.push(`missing canonical remote ${config.upstream.remote}`);
    } else if (
      normalizeRepositoryUrl(remote.stdout) !== normalizeRepositoryUrl(config.upstream.repository)
    ) {
      violations.push(
        `${config.upstream.remote} points to ${remote.stdout.trim()}, expected ${config.upstream.repository}`,
      );
    } else if (options.fetchUpstream) {
      runGit(repoRoot, [
        "fetch",
        "--prune",
        "--no-tags",
        config.upstream.remote,
        `+refs/heads/${config.upstream.branch}:refs/remotes/${config.upstream.remote}/${config.upstream.branch}`,
      ]);
    }
  }

  const baseline = config.upstream.commit;
  const baselineObject = runGitResult(repoRoot, ["rev-parse", "--verify", `${baseline}^{commit}`]);
  if (!baselineObject.ok) {
    throw new Error(`Pinned T3 commit ${baseline} is unavailable; run this command with --fetch`);
  }

  const release = runGit(repoRoot, ["rev-parse", "HEAD^{commit}"]).trim();
  const upstreamRef = `refs/remotes/${config.upstream.remote}/${config.upstream.branch}`;
  const upstreamResult = runGitResult(repoRoot, [
    "rev-parse",
    "--verify",
    `${upstreamRef}^{commit}`,
  ]);
  const currentUpstream = upstreamResult.ok ? upstreamResult.stdout.trim() : null;
  if (currentUpstream === null && options.verifyRemote !== false) {
    violations.push(`missing ${upstreamRef}; run this command with --fetch`);
  }

  const baselineInRelease = runGitResult(repoRoot, [
    "merge-base",
    "--is-ancestor",
    baseline,
    release,
  ]).ok;
  if (!baselineInRelease) {
    violations.push("the recorded T3 baseline is not an ancestor of the release commit");
  }

  const baselineInCurrentUpstream =
    currentUpstream === null
      ? null
      : runGitResult(repoRoot, ["merge-base", "--is-ancestor", baseline, currentUpstream]).ok;
  if (baselineInCurrentUpstream === false) {
    violations.push("the recorded T3 baseline is not in current upstream/main history");
  }

  const [baselineBehind, baselineAhead] = parseAheadBehind(
    runGit(repoRoot, ["rev-list", "--left-right", "--count", `${baseline}...${release}`]),
    "baseline to release",
  );
  const releaseToCurrentUpstream =
    currentUpstream === null
      ? null
      : parseAheadBehind(
          runGit(repoRoot, [
            "rev-list",
            "--left-right",
            "--count",
            `${release}...${currentUpstream}`,
          ]),
          "release to current upstream",
        );

  const baselinePaths = new Set(
    runGit(repoRoot, ["ls-tree", "-r", "--name-only", "-z", baseline]).split("\0").filter(Boolean),
  );
  const permanentGovernancePaths = new Set<string>();
  const releaseContentSha256 = new Map<string, string>();
  for (const entry of config.classification.permanentGovernanceFiles) {
    if (!baselinePaths.has(entry.path)) {
      throw new BaselineConfigurationError(
        `permanent governance file ${entry.path} is not T3-owned at the baseline`,
      );
    }
    if (permanentGovernancePaths.has(entry.path)) {
      throw new BaselineConfigurationError(`permanent governance file duplicates ${entry.path}`);
    }
    permanentGovernancePaths.add(entry.path);
    const content = runGit(repoRoot, ["show", `${release}:${entry.path}`]);
    releaseContentSha256.set(
      entry.path,
      NodeCrypto.createHash("sha256").update(content).digest("hex"),
    );
  }
  for (const entry of allowlist.values()) {
    if (!baselinePaths.has(entry.path)) {
      throw new BaselineConfigurationError(
        `${config.classification.sharedCoreAllowlist} lists ${entry.path}, but it is not T3-owned at the baseline`,
      );
    }
  }

  const fileDrift = parseNameStatus(
    runGit(repoRoot, [
      "diff",
      "--name-status",
      "--find-renames",
      "--find-copies",
      "-z",
      baseline,
      release,
    ]),
  ).map((change) => classifyChange(change, baselinePaths, config, releaseContentSha256, allowlist));
  for (const change of fileDrift) {
    if (change.category === "unexpected-shared-core") {
      violations.push(`unexpected shared-core edit: ${change.paths.join(" -> ")}`);
    }
  }

  return {
    ok: violations.length === 0,
    repositoryRoot: repoRoot,
    baseline,
    release,
    currentUpstream,
    ancestry: { baselineInRelease, baselineInCurrentUpstream },
    commitDrift: {
      baselineToRelease: { behind: baselineBehind, ahead: baselineAhead },
      releaseToCurrentUpstream:
        releaseToCurrentUpstream === null
          ? null
          : { ahead: releaseToCurrentUpstream[0], behind: releaseToCurrentUpstream[1] },
    },
    fileDrift,
    violations,
  };
}

interface CliOptions {
  readonly repoRoot: string;
  readonly fetchUpstream: boolean;
  readonly json: boolean;
}

function parseCliOptions(args: ReadonlyArray<string>): CliOptions {
  let repoRoot = process.cwd();
  let fetchUpstream = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--fetch") {
      fetchUpstream = true;
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--repo") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--repo requires a path");
      }
      repoRoot = value;
      index += 1;
    } else if (argument === "--help") {
      process.stdout.write(
        "Usage: node scripts/auldric/check-t3-baseline.ts [--fetch] [--json] [--repo PATH]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  const resolvedRoot = runGit(repoRoot, ["rev-parse", "--show-toplevel"]).trim();
  return { repoRoot: resolvedRoot, fetchUpstream, json };
}

function main(): void {
  try {
    const options = parseCliOptions(process.argv.slice(2));
    const report = inspectBaseline(options);
    process.stdout.write(
      `${options.json ? JSON.stringify(report, null, 2) : formatBaselineReport(report)}\n`,
    );
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? NodeURL.pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main();
}
