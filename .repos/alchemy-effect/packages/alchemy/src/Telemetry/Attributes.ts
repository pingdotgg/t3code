import { exec } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import * as Effect from "effect/Effect";

import packageJson from "../../package.json" with { type: "json" };

const ALCHEMY_DIR = nodePath.join(os.homedir(), ".alchemy");
const ID_PATH = nodePath.join(ALCHEMY_DIR, "id");
const DISABLED_PATH = nodePath.join(ALCHEMY_DIR, "telemetry-disabled");

/**
 * OTel resource attributes describing the user, project, runtime, and
 * environment running the alchemy CLI. Computed once per process and
 * attached to every span and metric exported by `TelemetryLive`.
 */
export interface TelemetryAttributes {
  readonly "alchemy.user.id": string;
  readonly "alchemy.session.id": string;
  readonly "alchemy.version": string;
  readonly "alchemy.git.root_commit": string;
  readonly "alchemy.git.origin_hash": string;
  readonly "alchemy.git.branch_hash": string;
  readonly "alchemy.runtime.name": string;
  readonly "alchemy.runtime.version": string;
  readonly "alchemy.ci.provider": string;
  readonly "alchemy.ci": boolean;
  readonly "host.arch": string;
  readonly "os.type": string;
  readonly "os.version": string;
  readonly "host.cpus": number;
  readonly "host.memory_mb": number;
}

const tryRead = (path: string): Effect.Effect<string | null> =>
  Effect.tryPromise({
    try: () => fs.readFile(path, "utf-8").then((s) => s.trim()),
    catch: () => null as never,
  }).pipe(Effect.catch(() => Effect.succeed(null)));

const sha256Hex = (input: string): string =>
  crypto.createHash("sha256").update(input).digest("hex");

const hashStringOrEmpty = (input: string | null): string =>
  input == null || input === "" ? "" : sha256Hex(input);

const execCapture = (cmd: string): Effect.Effect<string | null> =>
  Effect.callback<string | null>((resume) => {
    exec(cmd, { timeout: 1500 }, (err, stdout) => {
      if (err) {
        resume(Effect.succeed(null));
        return;
      }
      resume(Effect.succeed(stdout.toString().trim()));
    });
  });

const getOrCreateUserId: Effect.Effect<string> = Effect.gen(function* () {
  const existing = yield* tryRead(ID_PATH);
  if (existing) return existing;

  const id = crypto.randomUUID();
  yield* Effect.tryPromise({
    try: async () => {
      await fs.mkdir(ALCHEMY_DIR, { recursive: true });
      await fs.writeFile(ID_PATH, id);
    },
    catch: () => null as never,
  }).pipe(Effect.catch(() => Effect.void));
  return id;
});

const getRootCommitHash: Effect.Effect<string | null> = execCapture(
  process.platform === "win32"
    ? `git rev-list --max-parents=0 HEAD | ForEach-Object { if (-not (git cat-file -p $_ | Select-String "^parent ")) { $_ } }`
    : `git rev-list --max-parents=0 HEAD | xargs -r -I{} sh -c 'git cat-file -p {} | grep -q "^parent " || echo {}'`,
);

const getGitOriginUrl: Effect.Effect<string | null> = execCapture(
  "git config --get remote.origin.url",
);

const getBranchName: Effect.Effect<string | null> = execCapture(
  "git rev-parse --abbrev-ref HEAD",
);

const getRuntime = (): { name: string; version: string } => {
  const g = globalThis as unknown as {
    Bun?: { version: string };
    Deno?: { version?: { deno?: string } };
  };
  if (typeof g.Bun !== "undefined") {
    return { name: "bun", version: g.Bun.version };
  }
  if (typeof g.Deno !== "undefined") {
    return { name: "deno", version: g.Deno.version?.deno ?? "" };
  }
  if (globalThis.process?.versions?.node) {
    return { name: "node", version: process.versions.node };
  }
  return { name: "", version: "" };
};

const CI_PROVIDERS = [
  { env: "GITHUB_ACTIONS", provider: "GitHub Actions", isCI: true },
  { env: "GITLAB_CI", provider: "GitLab CI", isCI: true },
  { env: "CIRCLECI", provider: "CircleCI", isCI: true },
  { env: "JENKINS_URL", provider: "Jenkins", isCI: true },
  { env: "TRAVIS", provider: "Travis CI", isCI: true },
  { env: "BUILDKITE", provider: "Buildkite", isCI: true },
  { env: "NOW_BUILDER", provider: "Vercel", isCI: true },
  { env: "VERCEL", provider: "Vercel", isCI: false },
] as const;

const getCIEnvironment = (): { provider: string; isCI: boolean } => {
  for (const p of CI_PROVIDERS) {
    if (process.env[p.env]) {
      return { provider: p.provider, isCI: p.isCI };
    }
  }
  return { provider: "", isCI: !!process.env.CI };
};

const TELEMETRY_DISABLED_ENV = (): boolean =>
  !!process.env.ALCHEMY_TELEMETRY_DISABLED ||
  !!process.env.DO_NOT_TRACK ||
  !!process.env.NO_TRACK;

/**
 * `true` if telemetry is disabled via environment variable
 * (`DO_NOT_TRACK`, `NO_TRACK`, `ALCHEMY_TELEMETRY_DISABLED`) or via a
 * persisted opt-out file at `~/.alchemy/telemetry-disabled`.
 */
export const isTelemetryDisabled: Effect.Effect<boolean> = Effect.gen(
  function* () {
    if (TELEMETRY_DISABLED_ENV()) return true;
    const persisted = yield* tryRead(DISABLED_PATH);
    return persisted === "true";
  },
);

/**
 * Persists an opt-out so future invocations skip telemetry without needing
 * an env var.
 */
export const setTelemetryDisabled: Effect.Effect<void> = Effect.tryPromise({
  try: async () => {
    await fs.mkdir(ALCHEMY_DIR, { recursive: true });
    await fs.writeFile(DISABLED_PATH, "true");
  },
  catch: () => null as never,
}).pipe(Effect.catch(() => Effect.void));

export const setTelemetryEnabled: Effect.Effect<void> = Effect.tryPromise({
  try: () => fs.rm(DISABLED_PATH, { force: true }),
  catch: () => null as never,
}).pipe(Effect.catch(() => Effect.void));

const collectAttributesUncached: Effect.Effect<TelemetryAttributes> =
  Effect.gen(function* () {
    const [userId, rootCommit, originUrl, branch] = yield* Effect.all(
      [
        getOrCreateUserId,
        getRootCommitHash,
        getGitOriginUrl,
        getBranchName,
      ] as const,
      { concurrency: "unbounded" },
    );

    const runtime = getRuntime();
    const ci = getCIEnvironment();

    return {
      "alchemy.user.id": userId,
      "alchemy.session.id":
        process.env.ALCHEMY_TELEMETRY_SESSION_ID ?? crypto.randomUUID(),
      "alchemy.version": packageJson.version,
      "alchemy.git.root_commit": rootCommit ?? "",
      "alchemy.git.origin_hash": hashStringOrEmpty(originUrl),
      "alchemy.git.branch_hash": hashStringOrEmpty(branch),
      "alchemy.runtime.name": runtime.name,
      "alchemy.runtime.version": runtime.version,
      "alchemy.ci.provider": ci.provider,
      "alchemy.ci": ci.isCI,
      "host.arch": os.arch(),
      "os.type": os.platform(),
      "os.version": os.release(),
      "host.cpus": os.cpus().length,
      "host.memory_mb": Math.round(os.totalmem() / 1024 / 1024),
    } satisfies TelemetryAttributes;
  });

let cachedAttrs: TelemetryAttributes | undefined;

/**
 * Resolves the {@link TelemetryAttributes} for the current process. Cached
 * so file I/O and `git` invocations only run once per CLI invocation; every
 * subsequent caller gets the same record (and therefore the same session
 * id).
 */
export const collectAttributes: Effect.Effect<TelemetryAttributes> =
  Effect.suspend(() =>
    cachedAttrs !== undefined
      ? Effect.succeed(cachedAttrs)
      : collectAttributesUncached.pipe(
          Effect.tap((a) =>
            Effect.sync(() => {
              cachedAttrs = a;
            }),
          ),
        ),
  );
