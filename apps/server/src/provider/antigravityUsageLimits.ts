import type {
  AntigravitySettings,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type {
  AntigravityExecutable,
  AntigravityInstallationError,
} from "./AntigravityInstallation.ts";

// Before agy 1.1.11, `/usage` in print mode ran as a billed model turn.
const MIN_USAGE_CLI_VERSION = "1.1.11";
const VERSION_TIMEOUT = "5 seconds";
const USAGE_PROBE_TIMEOUT = "30 seconds";
const MAX_OUTPUT_BYTES = 512 * 1024;
const CACHE_TTL_MS = 60_000;
// Epoch-zero (`1970-01-01T00:00:00Z`) and pre-2000 values are sentinel timestamps for full pools.
const MIN_VALID_RESET_MS = Date.UTC(2000, 0, 1);

const SUMMARY_WINDOW_MINS = new Map<string, number>([
  ["5h", 5 * 60],
  ["weekly", 7 * 24 * 60],
]);

const INTERACTIVE_SIGN_IN_MARKER = "Authentication required. Please visit the URL";

const SIGNED_OUT_PHRASES = [
  "not logged into antigravity",
  "not logged in",
  "not signed in",
  "not authenticated",
  "not-authenticated",
  "unauthenticated",
  "run agy login",
  "please sign in",
  "please log in",
  "sign in to antigravity",
  "no credentials",
  "authentication required",
] as const;

const REMOVED_ENV_KEYS = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "GEMINI_HOME",
  "BROWSER",
  "ELECTRON_RUN_AS_NODE",
  "CHROME_CRASHPAD_PIPE_NAME",
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "SSH_TTY",
  "SSH_AUTH_SOCK",
]);

const CliBucket = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  remaining_fraction: Schema.optional(Schema.Number),
  reset_time: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});

const CliGroup = Schema.Struct({
  name: Schema.optional(Schema.String),
  buckets: Schema.optional(Schema.Array(CliBucket)),
});

const CliUsageEnvelope = Schema.Struct({
  status: Schema.Literal("SUCCESS"),
  command: Schema.Struct({
    name: Schema.Literal("usage"),
    data: Schema.Struct({
      groups: Schema.Array(CliGroup),
    }),
  }),
});

const CliModelTurnEnvelope = Schema.Struct({
  num_turns: Schema.optional(Schema.Number),
  conversation_id: Schema.optional(Schema.String),
});

const StructuredAgyError = Schema.Struct({
  status: Schema.optional(Schema.String),
  error_code: Schema.optional(Schema.Number),
});

const decodeJsonObject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeCliUsageEnvelope = Schema.decodeUnknownOption(CliUsageEnvelope);
const decodeCliModelTurnEnvelope = Schema.decodeUnknownOption(CliModelTurnEnvelope);
const decodeStructuredAgyError = Schema.decodeUnknownOption(
  Schema.fromJsonString(StructuredAgyError),
);

function parsedJsonLines(stdout: string): ReadonlyArray<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const parsed = decodeJsonObject(trimmed);
    if (Option.isSome(parsed)) objects.push(parsed.value);
  }
  return objects;
}

function normalizeResetTime(
  bucket: typeof CliBucket.Type,
  windowDurationMins: number | undefined,
  requestedAt: number,
): string | undefined {
  const raw = bucket.reset_time?.trim();
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_VALID_RESET_MS) return undefined;
  // Untouched summary buckets can report a rolling full-window reset.
  const untouched =
    bucket.remaining_fraction === 1 &&
    bucket.description === undefined &&
    windowDurationMins !== undefined &&
    Math.abs(parsed - requestedAt - windowDurationMins * 60_000) <= 60_000;
  return untouched ? undefined : DateTime.formatIso(DateTime.makeUnsafe(parsed));
}

function quotaWindow(
  id: string,
  label: string,
  bucket: typeof CliBucket.Type,
  kind: ServerProviderUsageWindow["kind"],
  windowDurationMins: number | undefined,
  requestedAt: number,
): ServerProviderUsageWindow | undefined {
  if (bucket.remaining_fraction === undefined || !Number.isFinite(bucket.remaining_fraction)) {
    return undefined;
  }
  const resetsAt = normalizeResetTime(bucket, windowDurationMins, requestedAt);
  return {
    id,
    label,
    kind,
    usedPercent: (1 - Math.max(0, Math.min(1, bucket.remaining_fraction))) * 100,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

/**
 * Parses `agy -p /usage --output-format json` stdout into Antigravity usage windows.
 * Returns `undefined` when stdout does not contain a valid `usage` SUCCESS envelope.
 */
export function antigravityCliUsageWindows(
  stdout: string,
  requestedAt: number,
): ReadonlyArray<ServerProviderUsageWindow> | undefined {
  for (const candidate of parsedJsonLines(stdout)) {
    const decoded = decodeCliUsageEnvelope(candidate);
    if (Option.isNone(decoded)) continue;
    const windows = new Map<string, ServerProviderUsageWindow>();
    for (const group of decoded.value.command.data.groups) {
      for (const bucket of group.buckets ?? []) {
        if (bucket.disabled) continue;
        const id = bucket.id?.trim();
        if (!id) continue;
        // Argon and Carbon are metered separately from the default Gemini buckets.
        const family = id.startsWith("gemini-argon-")
          ? group.name?.trim() || "Gemini Argon"
          : id.startsWith("gemini-carbon-")
            ? group.name?.trim() || "Gemini Carbon"
            : id.startsWith("gemini-")
              ? "Gemini"
              : id.startsWith("3p-")
                ? "Claude & GPT (shared)"
                : group.name?.trim() || id;
        const weekly = bucket.window === "weekly";
        const session = bucket.window === "5h";
        const windowDurationMins = SUMMARY_WINDOW_MINS.get(bucket.window ?? "");
        const window = quotaWindow(
          id,
          `${family} · ${weekly ? "Weekly" : session ? "5-hour" : bucket.name?.trim() || "Quota"}`,
          bucket,
          weekly ? "weekly" : session ? "session" : "other",
          windowDurationMins,
          requestedAt,
        );
        if (window) windows.set(window.id, window);
      }
    }
    return [...windows.values()];
  }
  return undefined;
}

/**
 * Unknown slash commands in print mode can fall back to billed model turns.
 * Any non-zero turn count or conversation ID must latch polling off for that binary.
 */
export function antigravityOutputShowsModelTurn(stdout: string): boolean {
  for (const candidate of parsedJsonLines(stdout)) {
    const decoded = decodeCliModelTurnEnvelope(candidate);
    if (Option.isNone(decoded)) continue;
    const { num_turns, conversation_id } = decoded.value;
    if (typeof num_turns === "number" && num_turns > 0) return true;
    if (typeof conversation_id === "string" && conversation_id.trim().length > 0) return true;
  }
  return false;
}

function extractSemver(raw: string): string | undefined {
  const match = raw.match(/\bv?(\d+\.\d+\.\d+)\b/iu);
  const version = match?.[1];
  return version && parseSemver(version) !== null ? version : undefined;
}

function classifyCliVersion(raw: string): "supported" | "unsupported" | "unknown" {
  const version = extractSemver(raw);
  if (version === undefined) return "unknown";
  return compareSemverVersions(version, MIN_USAGE_CLI_VERSION) >= 0 ? "supported" : "unsupported";
}

function outputLooksSignedOut(output: string): boolean {
  if (!output) return false;
  const lowered = output.toLowerCase();
  if (SIGNED_OUT_PHRASES.some((phrase) => lowered.includes(phrase))) return true;
  for (const line of output.split(/\r?\n/u)) {
    const index = line.indexOf("AGY_ERROR:");
    if (index === -1) continue;
    const parsed = decodeStructuredAgyError(line.slice(index + "AGY_ERROR:".length).trim());
    if (Option.isNone(parsed)) continue;
    if (
      parsed.value.status?.toUpperCase() === "UNAUTHENTICATED" ||
      parsed.value.error_code === 401
    ) {
      return true;
    }
  }
  return false;
}

function buildUsageCliEnv(
  baseEnv: NodeJS.ProcessEnv,
  profileDirectory: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (
      REMOVED_ENV_KEYS.has(upper) ||
      upper.startsWith("ANTIGRAVITY_") ||
      upper.startsWith("AGY_")
    ) {
      continue;
    }
    env[key] = value;
  }
  // Bind CLI state/cache to the instance profile. Root `agy -p /usage` does not accept ACP's
  // `--gemini-dir`/`--app-data-dir` flags, so GEMINI_HOME isolates its runtime directory while
  // letting `agy` authenticate silently via the OS keyring.
  if (profileDirectory) {
    env.GEMINI_HOME = profileDirectory;
  }
  // agy requires "true" (not "1") to suppress background self-updates during probes.
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  return env;
}

export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* (input: {
  readonly authMethod: AntigravitySettings["authMethod"];
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly profileDirectory?: string;
  readonly resolveExecutable: Effect.Effect<AntigravityExecutable, AntigravityInstallationError>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;

  let generation = 0;
  let cached: { readonly limits: ServerProviderUsageLimits; readonly cachedAt: number } | undefined;
  let verifiedVersion: { readonly path: string; readonly supported: boolean } | undefined;
  let latchedModelTurnPath: string | undefined;
  let signedOutHoldPath: string | undefined;

  const checkVersion = Effect.fn("antigravityUsageLimits.checkVersion")(function* (
    executable: AntigravityExecutable,
    env: Record<string, string>,
  ): Effect.fn.Return<"supported" | "unsupported" | "failed"> {
    if (executable.version !== null) {
      const classified = classifyCliVersion(executable.version);
      return classified === "supported" ? "supported" : "unsupported";
    }
    if (verifiedVersion?.path === executable.executablePath) {
      return verifiedVersion.supported ? "supported" : "unsupported";
    }
    const versionProbe = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(executable.executablePath, ["--version"], {
            env,
            extendEnv: false,
            shell: false,
            stdin: "ignore",
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout, maxBytes: 4_096 }),
            collectUint8StreamText({ stream: child.stderr, maxBytes: 4_096 }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { exitCode: Number(exitCode), output: `${stdout.text}\n${stderr.text}` };
      }),
    ).pipe(Effect.timeout(VERSION_TIMEOUT), Effect.option);
    if (Option.isNone(versionProbe) || versionProbe.value.exitCode !== 0) {
      return "failed";
    }
    const classified = classifyCliVersion(versionProbe.value.output);
    if (classified === "unknown") {
      return "failed";
    }
    verifiedVersion = { path: executable.executablePath, supported: classified === "supported" };
    return classified;
  });

  const read = Effect.fn("antigravityUsageLimits.read")(function* () {
    const readGeneration = generation;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const requestedAt = yield* Clock.currentTimeMillis;

    if (input.authMethod !== "oauth-personal" && input.authMethod !== "oauth-business") {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }

    if (cached !== undefined && requestedAt - cached.cachedAt < CACHE_TTL_MS) {
      return cached.limits;
    }

    const executableOption = yield* input.resolveExecutable.pipe(Effect.option);
    if (Option.isNone(executableOption)) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity CLI is not available to read usage limits.",
      });
    }
    const executable = executableOption.value;

    if (latchedModelTurnPath === executable.executablePath) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Antigravity CLI did not handle /usage as a quota command.",
      });
    }

    if (signedOutHoldPath === executable.executablePath) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Sign in to the Antigravity CLI to view usage limits.",
      });
    }

    const env = buildUsageCliEnv(input.baseEnv, input.profileDirectory);
    const versionStatus = yield* checkVersion(executable, env);
    if (versionStatus === "unsupported") {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: `Antigravity CLI ${MIN_USAGE_CLI_VERSION} or newer is required to read usage limits.`,
      });
    }
    if (versionStatus === "failed") {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Could not verify the Antigravity CLI version. Refresh provider status to retry.",
      });
    }

    const nullDevice = platform === "win32" ? "NUL" : "/dev/null";
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-antigravity-usage-",
        });
        const child = yield* spawner.spawn(
          ChildProcess.make(
            executable.executablePath,
            [
              "-p",
              "/usage",
              "--output-format",
              "json",
              "--print-timeout",
              "20s",
              "--log-file",
              nullDevice,
            ],
            {
              cwd,
              env,
              extendEnv: false,
              shell: false,
              stdin: "ignore",
            },
          ),
        );
        let interactiveSignIn = false;
        let stderrBytes = 0;
        const stderrChunks: string[] = [];
        const decoder = new TextDecoder();
        const collectStderr = child.stderr.pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              if (stderrBytes < MAX_OUTPUT_BYTES) {
                const slice =
                  chunk.byteLength > MAX_OUTPUT_BYTES - stderrBytes
                    ? chunk.subarray(0, MAX_OUTPUT_BYTES - stderrBytes)
                    : chunk;
                stderrBytes += slice.byteLength;
                stderrChunks.push(decoder.decode(slice, { stream: true }));
              }
              if (
                !interactiveSignIn &&
                stderrChunks.join("").includes(INTERACTIVE_SIGN_IN_MARKER)
              ) {
                interactiveSignIn = true;
                yield* child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore);
              }
            }),
          ),
        );
        const [stdout] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_OUTPUT_BYTES }),
            collectStderr,
            child.exitCode.pipe(Effect.ignore),
          ],
          { concurrency: "unbounded" },
        );
        stderrChunks.push(decoder.decode());
        return {
          stdout: stdout.text,
          stderr: stderrChunks.join(""),
          interactiveSignIn,
        };
      }),
    );

    if (antigravityOutputShowsModelTurn(outcome.stdout)) {
      if (readGeneration === generation) latchedModelTurnPath = executable.executablePath;
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Antigravity CLI did not handle /usage as a quota command.",
      });
    }

    if (
      outcome.interactiveSignIn ||
      outputLooksSignedOut(outcome.stderr) ||
      outputLooksSignedOut(outcome.stdout)
    ) {
      if (readGeneration === generation) signedOutHoldPath = executable.executablePath;
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Sign in to the Antigravity CLI to view usage limits.",
      });
    }

    const windows = antigravityCliUsageWindows(outcome.stdout, requestedAt);
    if (!windows || windows.length === 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity did not return usable quota information.",
      });
    }

    const limits = makeUsageLimits({ checkedAt, windows });
    if (readGeneration === generation) {
      cached = { limits, cachedAt: requestedAt };
      signedOutHoldPath = undefined;
    }
    return limits;
  });

  const probe: Effect.Effect<ServerProviderUsageLimits> = read().pipe(
    Effect.timeout(USAGE_PROBE_TIMEOUT),
    Effect.catch(() =>
      Effect.gen(function* () {
        return makeUnavailableUsageLimits({
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          reason: "probeFailed",
          message: "Could not read Antigravity limits. Refresh provider status to retry.",
        });
      }),
    ),
  );

  return {
    probe,
    clear: Effect.sync(() => {
      cached = undefined;
      signedOutHoldPath = undefined;
      generation++;
    }),
  };
});
