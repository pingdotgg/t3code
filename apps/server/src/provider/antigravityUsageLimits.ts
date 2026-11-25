import * as NodeModule from "node:module";

import type { AntigravitySettings, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

const SUMMARY_WINDOW_MINS = new Map([
  ["5h", 5 * 60],
  ["weekly", 7 * 24 * 60],
]);
const AUTO_CACHE_TTL_MS = 5 * 60 * 1000;
const FAIL_COOLDOWN_MS = 60 * 1000;

// Strip ambient Google credentials and T3 launcher internals before spawning the official CLI.
const BLOCKED_CLI_ENV_KEYS = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "GEMINI_HOME",
  "SSH_CONNECTION",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "AGY_CLI_FORCE_FILE_TOKEN_STORAGE",
  "ELECTRON_RUN_AS_NODE",
  "CHROME_CRASHPAD_PIPE_NAME",
]);

const UserInfo = Schema.Struct({ id: Schema.NonEmptyString });
const Quota = Schema.Struct({
  remainingFraction: Schema.optional(Schema.Number),
  resetTime: Schema.optional(Schema.String),
});
const Bucket = Schema.Struct({
  ...Quota.fields,
  bucketId: Schema.NonEmptyString,
  window: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});
const Summary = Schema.Struct({
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        displayName: Schema.optional(Schema.String),
        buckets: Schema.optional(Schema.Array(Bucket)),
      }),
    ),
  ),
  buckets: Schema.optional(Schema.Array(Bucket)),
});

const decodeUserInfo = Schema.decodeUnknownEffect(UserInfo);
const decodeSummary = Schema.decodeUnknownEffect(Summary);

const AntigravityCliUsageErrorReason = Schema.Literals([
  "load_pty",
  "resolve_executable",
  "spawn_failed",
  "invalid_output",
]);

export class AntigravityCliUsageError extends Schema.TaggedError<AntigravityCliUsageError>()(
  "AntigravityCliUsageError",
  {
    reason: AntigravityCliUsageErrorReason,
    executablePath: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "load_pty":
        return "Could not load node-pty to run the official Antigravity CLI.";
      case "resolve_executable":
        return "Could not resolve the configured Antigravity CLI executable.";
      case "spawn_failed":
        return "Could not launch the official Antigravity CLI.";
      case "invalid_output":
        return "Official Antigravity CLI did not return a parseable /usage summary.";
    }
  }
}

export function antigravityUserAgent(platform: NodeJS.Platform, architecture: NodeJS.Architecture) {
  return `antigravity/hub/2.24.0 (aidev_client; os_type=${platform}; arch=${architecture}; cl=963137146)`;
}

function iso(value: string | undefined): string | undefined {
  const parsed = value ? DateTime.make(value) : Option.none();
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function quotaWindow(
  id: string,
  label: string,
  quota: typeof Quota.Type,
  kind: ServerProviderUsageWindow["kind"] = "other",
  windowDurationMins?: number,
): ServerProviderUsageWindow | undefined {
  if (quota.remainingFraction === undefined || !Number.isFinite(quota.remainingFraction)) {
    return undefined;
  }
  const resetsAt = iso(quota.resetTime);
  return {
    id,
    label,
    kind,
    usedPercent: (1 - Math.max(0, Math.min(1, quota.remainingFraction))) * 100,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

function summaryResetTime(
  bucket: typeof Bucket.Type,
  windowDurationMins: number | undefined,
  requestedAt: number,
): string | undefined {
  // Untouched summary buckets report a rolling full-window reset.
  const untouched =
    bucket.remainingFraction === 1 &&
    bucket.description === undefined &&
    windowDurationMins !== undefined &&
    Math.abs(Date.parse(bucket.resetTime ?? "") - requestedAt - windowDurationMins * 60_000) <=
      60_000;
  return untouched ? undefined : bucket.resetTime;
}

const sha256 = Effect.fnUntraced(function* (text: string) {
  const digest = yield* (yield* Digest.Digest).digest(
    Digest.sha256,
    new TextEncoder().encode(text),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

/** Keys an account by its Google ID, which matches across machines and hubs; refresh tokens do not. */
export const antigravityAccountFingerprint = (userInfo: unknown) =>
  decodeUserInfo(userInfo).pipe(Effect.flatMap((info) => sha256(`google-account\0${info.id}`)));

/** Windows from a `retrieveUserQuotaSummary` answer requested at `requestedAt`. */
export const antigravitySummaryWindows = (response: unknown, requestedAt: number) =>
  decodeSummary(response).pipe(Effect.map((summary) => summaryWindows(summary, requestedAt)));

function summaryWindows(summary: typeof Summary.Type, requestedAt: number) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  const groups = summary.groups?.some((group) => group.buckets?.length)
    ? summary.groups
    : [{ buckets: summary.buckets }];
  for (const group of groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (bucket.disabled) continue;
      // Argon and Carbon are metered separately from the default Gemini buckets.
      const family = bucket.bucketId.startsWith("gemini-argon-")
        ? group.displayName?.trim() || "Gemini Argon"
        : bucket.bucketId.startsWith("gemini-carbon-")
          ? group.displayName?.trim() || "Gemini Carbon"
          : bucket.bucketId.startsWith("gemini-")
            ? "Gemini"
            : bucket.bucketId.startsWith("3p-")
              ? "Claude & GPT (shared)"
              : group.displayName?.trim() || bucket.bucketId;
      const weekly = bucket.window === "weekly";
      const session = bucket.window === "5h";
      const windowDurationMins = SUMMARY_WINDOW_MINS.get(bucket.window ?? "");
      const window = quotaWindow(
        bucket.bucketId,
        `${family} · ${weekly ? "Weekly" : session ? "5-hour" : bucket.displayName?.trim() || "Quota"}`,
        { ...bucket, resetTime: summaryResetTime(bucket, windowDurationMins, requestedAt) },
        weekly ? "weekly" : session ? "session" : "other",
        windowDurationMins,
      );
      if (window) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}

// A single-executable server resolves native addons on disk only through `require`.
const requireExternal = NodeModule.createRequire(import.meta.url);

function stripAnsiPreserveLines(input: string): string {
  return (
    input
      // Turn cursor positioning and line moves into newlines so TUI cells stay separated.
      .replace(/\x1b\[\d*(?:;\d*)?[Hf]/g, "\n")
      .replace(/\x1b\[\d*[ABEF]/g, "\n")
      .replace(/\x1b\[\d*[CDG]/g, " ")
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b[()][A-Z0-9]/g, "")
      .replace(/\r/g, "\n")
  );
}

function parseRefreshDurationMs(text: string): number | undefined {
  const match = /Refreshes\s+in\s+([^\n]+)/i.exec(text);
  if (!match?.[1]) return undefined;
  let totalMs = 0;
  let matched = false;
  for (const part of match[1].matchAll(/(\d+)\s*([dhms])/gi)) {
    matched = true;
    const value = Number(part[1]);
    const unit = part[2]?.toLowerCase();
    if (unit === "d") totalMs += value * 86_400_000;
    else if (unit === "h") totalMs += value * 3_600_000;
    else if (unit === "m") totalMs += value * 60_000;
    else if (unit === "s") totalMs += value * 1_000;
  }
  return matched && totalMs > 0 ? totalMs : undefined;
}

function normalizeCliQuotaGroup(rawHeader: string): {
  readonly idPrefix: string;
  readonly display: string;
} {
  const upper = rawHeader.trim().toUpperCase();
  if (upper.includes("ARGON")) return { idPrefix: "gemini-argon", display: "Gemini Argon" };
  if (upper.includes("CARBON")) return { idPrefix: "gemini-carbon", display: "Gemini Carbon" };
  if (upper.includes("GEMINI")) return { idPrefix: "gemini", display: "Gemini" };
  if (upper.includes("CLAUDE") || upper.includes("GPT") || upper.includes("3P")) {
    return { idPrefix: "3p", display: "Claude & GPT (shared)" };
  }
  const slug =
    upper
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "group";
  return { idPrefix: slug, display: rawHeader.trim() };
}

export interface ParsedAntigravityCliUsage {
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly accountEmail?: string;
}

/**
 * Parses the rendered output of the official `agy` CLI `/usage` view into T3 usage windows.
 * Keeps T3 from reading OAuth tokens or calling undocumented Google backend endpoints directly.
 */
export function parseAntigravityCliUsageOutput(
  rawOutput: string,
  nowMs: number,
): ParsedAntigravityCliUsage | undefined {
  const clean = stripAnsiPreserveLines(rawOutput);
  const startIdx = clean.lastIndexOf("Models & Quota");
  if (startIdx === -1) return undefined;
  const frame = clean.slice(startIdx);

  const accountMatch = /Account:\s*([^\s\n]+)/i.exec(frame);
  const accountEmail = accountMatch?.[1]?.trim() || undefined;

  const groupMatches = [
    ...frame.matchAll(/(?:^|\n)\s*([A-Z0-9 &+/_-]{3,40}\s+MODELS)\s*(?:\n|$)/g),
  ];
  if (groupMatches.length === 0) return undefined;

  const blockSpecs = [
    {
      re: /Five\s+Hour\s+Limit\s+Remaining/i,
      suffix: "5h",
      labelSuffix: "5-hour",
      kind: "session" as const,
      windowDurationMins: 5 * 60,
    },
    {
      re: /Weekly\s+Limit\s+Remaining/i,
      suffix: "weekly",
      labelSuffix: "Weekly",
      kind: "weekly" as const,
      windowDurationMins: 7 * 24 * 60,
    },
  ];

  const windows: ServerProviderUsageWindow[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < groupMatches.length; i++) {
    const match = groupMatches[i];
    if (!match?.[1] || match.index === undefined) continue;
    const sectionStart = match.index + match[0].length;
    const sectionEnd =
      i + 1 < groupMatches.length ? (groupMatches[i + 1]?.index ?? frame.length) : frame.length;
    const section = frame.slice(sectionStart, sectionEnd);
    const { idPrefix, display } = normalizeCliQuotaGroup(match[1]);

    const foundBlocks = blockSpecs
      .map((spec) => {
        const hit = spec.re.exec(section);
        return hit
          ? { ...spec, index: hit.index, endOfTitle: hit.index + hit[0].length }
          : undefined;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      .toSorted((left, right) => left.index - right.index);

    for (let j = 0; j < foundBlocks.length; j++) {
      const block = foundBlocks[j];
      if (!block) continue;
      const blockEnd =
        j + 1 < foundBlocks.length ? (foundBlocks[j + 1]?.index ?? section.length) : section.length;
      const slice = section.slice(block.endOfTitle, blockEnd);
      const percentMatch = /(\d+(?:\.\d+)?)\s*%/.exec(slice);
      if (!percentMatch?.[1]) continue;
      const remainingPct = Math.max(0, Math.min(100, Number(percentMatch[1])));
      if (!Number.isFinite(remainingPct)) continue;
      const usedPercent = Math.round((100 - remainingPct) * 100) / 100;
      const refreshMs = parseRefreshDurationMs(slice);
      const id = `${idPrefix}-${block.suffix}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      windows.push({
        id,
        label: `${display} · ${block.labelSuffix}`,
        kind: block.kind,
        usedPercent,
        windowDurationMins: block.windowDurationMins,
        ...(refreshMs === undefined
          ? {}
          : { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + refreshMs)) }),
      });
    }
  }

  if (windows.length === 0) return undefined;

  const kindOrder: Record<ServerProviderUsageWindow["kind"], number> = {
    session: 0,
    weekly: 1,
    monthly: 2,
    other: 3,
  };
  const groupOrder = (id: string) => (id.startsWith("gemini-") ? 0 : id.startsWith("3p-") ? 1 : 2);
  windows.sort((left, right) => {
    const groupDiff = groupOrder(left.id) - groupOrder(right.id);
    if (groupDiff !== 0) return groupDiff;
    return (kindOrder[left.kind] ?? 9) - (kindOrder[right.kind] ?? 9);
  });

  return {
    windows,
    ...(accountEmail ? { accountEmail } : {}),
  };
}

export interface AntigravityCliUsageRunInput {
  readonly executablePath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export type AntigravityNodePtyModule = Pick<typeof import("node-pty"), "spawn">;

export function buildAntigravityCliUsageEnv(
  baseEnv: NodeJS.ProcessEnv,
  profileDirectory?: string,
): NodeJS.ProcessEnv {
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    // Windows treats environment variable names as case-insensitive.
    if (BLOCKED_CLI_ENV_KEYS.has(key.toUpperCase())) continue;
    cleanEnv[key] = value;
  }
  if (profileDirectory !== undefined) {
    cleanEnv.GEMINI_HOME = profileDirectory;
  }
  return cleanEnv;
}

export const runOfficialAgyUsagePty = Effect.fn("AntigravityUsageProbe.runOfficialAgyUsagePty")(
  function* (
    input: AntigravityCliUsageRunInput,
    loadPty: () => AntigravityNodePtyModule = () =>
      requireExternal("node-pty") as AntigravityNodePtyModule,
  ) {
    const pty = yield* Effect.try({
      try: loadPty,
      catch: (cause) => new AntigravityCliUsageError({ reason: "load_pty", cause }),
    });

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.TERM = env.TERM || "xterm-256color";

    const bannerReady = yield* Deferred.make<void>();
    const quotaReady = yield* Deferred.make<void>();
    const exited = yield* Deferred.make<void>();

    let raw = "";
    let sentUsage = false;

    const proc = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          pty.spawn(input.executablePath, [], {
            name: "xterm-256color",
            cols: 120,
            rows: 42,
            cwd: input.cwd,
            env,
          }),
        catch: (cause) =>
          new AntigravityCliUsageError({
            reason: "spawn_failed",
            executablePath: input.executablePath,
            cause,
          }),
      }),
      (handle) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            try {
              handle.write("\x1b");
              handle.write("\x03\x03");
            } catch {
              // Ignore write errors if the CLI already exited.
            }
          });
          yield* Effect.sleep("250 millis");
          yield* Effect.sync(() => {
            try {
              handle.kill();
            } catch {
              // Ignore kill errors if already terminated.
            }
          });
        }),
    );

    proc.onData((chunk) => {
      raw += chunk;
      const clean = stripAnsiPreserveLines(raw);
      if (clean.includes("Antigravity CLI")) {
        Deferred.doneUnsafe(bannerReady, Exit.void);
      }
      if (sentUsage && clean.includes("Models & Quota") && clean.includes("Limit Remaining")) {
        const parsed = parseAntigravityCliUsageOutput(raw, 0);
        if (parsed && parsed.windows.length >= 2) {
          Deferred.doneUnsafe(quotaReady, Exit.void);
        }
      }
    });

    proc.onExit(() => {
      Deferred.doneUnsafe(exited, Exit.void);
    });

    yield* Effect.raceFirst(Deferred.await(bannerReady), Deferred.await(exited)).pipe(
      Effect.timeout("10 seconds"),
      Effect.ignore,
    );

    yield* Effect.sleep("900 millis");
    sentUsage = true;
    yield* Effect.sync(() => {
      try {
        proc.write("/usage");
      } catch {
        // Handled below if output is missing.
      }
    });
    yield* Effect.sleep("350 millis");
    yield* Effect.sync(() => {
      try {
        proc.write("\r");
      } catch {
        // Handled below if output is missing.
      }
    });

    yield* Effect.raceFirst(Deferred.await(quotaReady), Deferred.await(exited)).pipe(
      Effect.timeout("18 seconds"),
      Effect.ignore,
    );
    // Allow the final BubbleTea frame (all model groups) to finish flushing.
    yield* Effect.sleep("700 millis");

    if (!parseAntigravityCliUsageOutput(raw, 0)) {
      return yield* new AntigravityCliUsageError({ reason: "invalid_output" });
    }
    return raw;
  },
);

export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* (input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravitySettings["authMethod"];
  readonly resolveExecutable?: Effect.Effect<string, AntigravityCliUsageError>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runCliUsage?: (
    args: AntigravityCliUsageRunInput,
  ) => Effect.Effect<string, AntigravityCliUsageError>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Digest.Digest;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const cliTokenPath = path.join(
    input.profileDirectory,
    "antigravity-acp",
    "antigravity-oauth-token",
  );
  const runCliUsage =
    input.runCliUsage ??
    ((args: AntigravityCliUsageRunInput) => runOfficialAgyUsagePty(args).pipe(Effect.scoped));

  let cached:
    | {
        readonly checkedAt: string;
        readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
        readonly credentialFingerprint?: string;
        readonly cachedAtMs: number;
      }
    | undefined;
  let lastAttemptAtMs = 0;
  let generation = 0;

  const formatCached = (entry: NonNullable<typeof cached>) => ({
    ...makeUsageLimits({ checkedAt: entry.checkedAt, windows: [...entry.windows] }),
    ...(entry.credentialFingerprint ? { credentialFingerprint: entry.credentialFingerprint } : {}),
  });

  const read = Effect.gen(function* () {
    const startedGeneration = generation;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (input.authMethod !== "oauth-personal" && input.authMethod !== "oauth-business") {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }

    const nowMs = yield* Clock.currentTimeMillis;

    // 1. Fresh cache hit: preserve the original checkedAt timestamp.
    if (cached !== undefined && nowMs - cached.cachedAtMs < AUTO_CACHE_TTL_MS) {
      return formatCached(cached);
    }

    // 2. Cooldown after a recent failed attempt (prevents rapid-fire CLI relaunches on error).
    if (lastAttemptAtMs > 0 && nowMs - lastAttemptAtMs < FAIL_COOLDOWN_MS) {
      if (cached !== undefined) {
        return formatCached(cached);
      }
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Could not read Antigravity limits. Refresh provider status to retry.",
      });
    }

    // Personal OAuth profiles isolate sign-ins per profile directory; do not fall through to the
    // shared OS keyring for an unsigned-in personal instance.
    const hasProfileToken = yield* fs.exists(cliTokenPath).pipe(Effect.orElseSucceed(() => false));
    if (input.authMethod === "oauth-personal" && !hasProfileToken) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Sign in with Google to see Antigravity limits.",
      });
    }

    lastAttemptAtMs = nowMs;

    // Only default to "agy" when no executable resolver was supplied; never silently bypass a
    // configured binaryPath that failed installation validation.
    const executablePath = input.resolveExecutable ? yield* input.resolveExecutable : "agy";

    const cleanEnv = buildAntigravityCliUsageEnv(
      input.environment ?? process.env,
      hasProfileToken ? input.profileDirectory : undefined,
    );

    const rawOutput = yield* runCliUsage({
      executablePath,
      env: cleanEnv,
      cwd: homeDirectory,
    });
    const parsedAtMs = yield* Clock.currentTimeMillis;
    const observedAt = DateTime.formatIso(DateTime.makeUnsafe(parsedAtMs));
    const parsed = parseAntigravityCliUsageOutput(rawOutput, parsedAtMs);
    if (!parsed || parsed.windows.length === 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Official Antigravity CLI did not return usable quota information.",
      });
    }

    const credentialFingerprint = parsed.accountEmail
      ? yield* sha256(`google-account-cli\0${parsed.accountEmail.toLowerCase()}`)
      : undefined;

    if (generation === startedGeneration) {
      cached = {
        checkedAt: observedAt,
        windows: parsed.windows,
        ...(credentialFingerprint ? { credentialFingerprint } : {}),
        cachedAtMs: parsedAtMs,
      };
    }

    return {
      ...makeUsageLimits({ checkedAt: observedAt, windows: [...parsed.windows] }),
      ...(credentialFingerprint ? { credentialFingerprint } : {}),
    };
  });

  const probe = read.pipe(
    Effect.provideService(Digest.Digest, crypto),
    Effect.timeout("30 seconds"),
    Effect.catch(() =>
      Effect.gen(function* () {
        if (cached !== undefined) {
          return formatCached(cached);
        }
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
      generation++;
      cached = undefined;
      lastAttemptAtMs = 0;
    }),
  };
});
