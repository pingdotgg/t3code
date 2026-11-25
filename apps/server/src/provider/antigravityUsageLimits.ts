import * as NodeModule from "node:module";

import type { AntigravitySettings, ServerProviderUsageWindow } from "@t3tools/contracts";
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
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

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
const MAX_PTY_OUTPUT_BYTES = 256 * 1024;
const utf8Encoder = new TextEncoder();

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
  "AGY_ADC_AUTH",
  "GEMINI_HOME",
  "SSH_CONNECTION",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "AGY_CLI_FORCE_FILE_TOKEN_STORAGE",
  "ELECTRON_RUN_AS_NODE",
  "CHROME_CRASHPAD_PIPE_NAME",
]);

const UserInfo = Schema.Struct({
  id: Schema.NonEmptyString,
  email: Schema.optional(Schema.NonEmptyString),
});
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
  "output_limit_exceeded",
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
      case "output_limit_exceeded":
        return "Official Antigravity CLI output exceeded the safe buffer limit.";
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
  const digest = yield* (yield* Digest.Digest).digest(Digest.sha256, utf8Encoder.encode(text));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

/** Shared versioned email fingerprint so local CLI and hub readings pool into one account key. */
export const antigravityEmailFingerprint = (email: string) =>
  sha256(`google-account-email-v1\0${email.trim().toLowerCase()}`);

/**
 * Keys an account so local CLI readings and hub readings pool across machines without publishing
 * raw email addresses. Prefers normalized email when `userinfo` provides it, and falls back to
 * the Google account ID when `userinfo` omits email.
 */
export const antigravityAccountFingerprint = (userInfo: unknown) =>
  decodeUserInfo(userInfo).pipe(
    Effect.flatMap((info) => {
      const normalizedEmail = info.email?.trim();
      return normalizedEmail
        ? antigravityEmailFingerprint(normalizedEmail)
        : sha256(`google-account\0${info.id}`);
    }),
  );

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

/**
 * Lightweight incremental VT/ANSI terminal screen buffer.
 * Resolves cursor positioning, screen/line clears, and in-place overwrites in O(chunk.length)
 * time with strictly bounded row and column memory so partial redraws always reflect the latest
 * on-screen values.
 */
class MiniTerminalScreen {
  private readonly maxCols: number;
  private readonly maxRows: number;
  private rows: string[][] = [];
  private row = 0;
  private col = 0;
  private pending = "";

  constructor(cols = 120, maxRows = 160) {
    this.maxCols = cols * 2;
    this.maxRows = maxRows;
  }

  private clampCol(targetCol: number): number {
    return Math.min(this.maxCols - 1, Math.max(0, targetCol));
  }

  private ensureRow(targetRow: number): number {
    const clamped = Math.max(0, Math.min(targetRow, this.maxRows - 1));
    while (this.rows.length <= clamped) {
      this.rows.push([]);
    }
    return clamped;
  }

  private clearScreen(): void {
    this.rows = [];
    this.row = 0;
    this.col = 0;
  }

  write(chunk: string): void {
    const text = this.pending + chunk;
    this.pending = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i] ?? "";
      if (ch === "\x1b") {
        if (i + 1 >= text.length) {
          this.pending = text.slice(i);
          break;
        }
        const next = text[i + 1];
        if (next === "[") {
          let j = i + 2;
          while (j < text.length && (text.charCodeAt(j) < 0x40 || text.charCodeAt(j) > 0x7e)) {
            j++;
          }
          if (j >= text.length) {
            if (text.length - i < 256) this.pending = text.slice(i);
            break;
          }
          const paramsRaw = text.slice(i + 2, j).replace(/^[?>=<]+/, "");
          const finalCh = text[j] ?? "";
          const parts =
            paramsRaw.length > 0 ? paramsRaw.split(";").map((p) => (p === "" ? 0 : Number(p))) : [];
          this.handleCsi(finalCh, parts);
          i = j + 1;
          continue;
        }
        if (next === "]") {
          let j = i + 2;
          let foundEnd = -1;
          while (j < text.length) {
            if (text[j] === "\x07") {
              foundEnd = j + 1;
              break;
            }
            if (text[j] === "\x1b" && j + 1 < text.length && text[j + 1] === "\\") {
              foundEnd = j + 2;
              break;
            }
            j++;
          }
          if (foundEnd === -1) {
            if (text.length - i < 4096) this.pending = text.slice(i);
            break;
          }
          i = foundEnd;
          continue;
        }
        if (next === "(" || next === ")" || next === "*" || next === "+") {
          if (i + 2 >= text.length) {
            this.pending = text.slice(i);
            break;
          }
          i += 3;
          continue;
        }
        i += 2;
        continue;
      }

      if (ch === "\r") {
        this.col = 0;
        i++;
        continue;
      }
      if (ch === "\n") {
        this.row = this.ensureRow(this.row + 1);
        this.col = 0;
        i++;
        continue;
      }
      if (ch === "\b") {
        this.col = Math.max(0, this.col - 1);
        i++;
        continue;
      }
      if (ch === "\t") {
        this.col = this.clampCol(this.col + (8 - (this.col % 8)));
        i++;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) {
        i++;
        continue;
      }

      const r = this.ensureRow(this.row);
      const line = this.rows[r]!;
      const safeCol = this.clampCol(this.col);
      while (line.length < safeCol) line.push(" ");
      line[safeCol] = ch;
      this.col = this.clampCol(safeCol + 1);
      i++;
    }
  }

  private handleCsi(finalCh: string, parts: ReadonlyArray<number>): void {
    const p1 = parts[0] || 0;
    const p2 = parts[1] || 0;
    switch (finalCh) {
      case "H":
      case "f":
        this.row = this.ensureRow((p1 || 1) - 1);
        this.col = this.clampCol((p2 || 1) - 1);
        break;
      case "A":
        this.row = Math.max(0, this.row - (p1 || 1));
        break;
      case "B":
        this.row = this.ensureRow(this.row + (p1 || 1));
        break;
      case "C":
        this.col = this.clampCol(this.col + (p1 || 1));
        break;
      case "D":
        this.col = Math.max(0, this.col - (p1 || 1));
        break;
      case "E":
        this.row = this.ensureRow(this.row + (p1 || 1));
        this.col = 0;
        break;
      case "F":
        this.row = Math.max(0, this.row - (p1 || 1));
        this.col = 0;
        break;
      case "G":
        this.col = this.clampCol((p1 || 1) - 1);
        break;
      case "J":
        if (p1 === 2 || p1 === 3) {
          this.clearScreen();
        } else if (p1 === 0) {
          const r = this.ensureRow(this.row);
          const line = this.rows[r]!;
          line.length = Math.min(line.length, this.col);
          this.rows.length = r + 1;
        } else if (p1 === 1) {
          for (let r = 0; r < this.row && r < this.rows.length; r++) {
            this.rows[r] = [];
          }
          const current = this.rows[this.row];
          if (current) {
            for (let c = 0; c <= this.col && c < current.length; c++) {
              current[c] = " ";
            }
          }
        }
        break;
      case "K": {
        const r = this.ensureRow(this.row);
        const line = this.rows[r]!;
        if (p1 === 0) {
          line.length = Math.min(line.length, this.col);
        } else if (p1 === 1) {
          for (let c = 0; c <= this.col && c < line.length; c++) {
            line[c] = " ";
          }
        } else if (p1 === 2) {
          this.rows[r] = [];
        }
        break;
      }
      default:
        break;
    }
  }

  toText(): string {
    return this.rows.map((line) => line.join("").replace(/\s+$/, "")).join("\n");
  }
}

function renderTerminalOutput(input: string): string {
  const screen = new MiniTerminalScreen(120, 160);
  screen.write(input);
  return screen.toText();
}

function parseRefreshDurationMs(text: string): number | undefined {
  const matches = [...text.matchAll(/Refreshes\s+in\s+([^\n]+)/gi)];
  const last = matches[matches.length - 1];
  if (!last?.[1]) return undefined;
  let totalMs = 0;
  let matched = false;
  for (const part of last[1].matchAll(/(\d+)\s*([dhms])/gi)) {
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

function parseRenderedAntigravityCliUsage(
  clean: string,
  nowMs: number,
): ParsedAntigravityCliUsage | undefined {
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
      const percentMatches = [...slice.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
      const lastPercent = percentMatches[percentMatches.length - 1];
      if (!lastPercent?.[1]) continue;
      const remainingPct = Math.max(0, Math.min(100, Number(lastPercent[1])));
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

/**
 * Parses the rendered output of the official `agy` CLI `/usage` view into T3 usage windows.
 * Keeps T3 from reading OAuth tokens or calling undocumented Google backend endpoints directly.
 */
export function parseAntigravityCliUsageOutput(
  rawOutput: string,
  nowMs: number,
): ParsedAntigravityCliUsage | undefined {
  return parseRenderedAntigravityCliUsage(renderTerminalOutput(rawOutput), nowMs);
}

export interface AntigravityCliUsageRunInput {
  readonly executablePath: string;
  readonly args?: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export type AntigravityNodePtyModule = Pick<typeof import("node-pty"), "spawn">;

export function buildAntigravityCliUsageEnv(
  baseEnv: NodeJS.ProcessEnv,
  options?: {
    readonly isolatedHome?: string;
    readonly isolatedGeminiHome?: string;
    readonly gcpProject?: string;
    readonly gcpLocation?: string;
  },
): NodeJS.ProcessEnv {
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    // Windows treats environment variable names as case-insensitive.
    if (BLOCKED_CLI_ENV_KEYS.has(key.toUpperCase())) continue;
    cleanEnv[key] = value;
  }
  if (options?.isolatedHome !== undefined) {
    cleanEnv.HOME = options.isolatedHome;
    cleanEnv.USERPROFILE = options.isolatedHome;
  }
  // Keep GEMINI_HOME pointed strictly at the isolated empty config root so neither global nor
  // profile MCP servers or hooks can load during background usage reads.
  if (options?.isolatedGeminiHome !== undefined) {
    cleanEnv.GEMINI_HOME = options.isolatedGeminiHome;
  }
  if (options?.gcpProject) {
    cleanEnv.GOOGLE_CLOUD_PROJECT = options.gcpProject;
  }
  if (options?.gcpLocation) {
    cleanEnv.GOOGLE_CLOUD_LOCATION = options.gcpLocation;
  }
  cleanEnv.TERM = cleanEnv.TERM || "xterm-256color";
  return cleanEnv;
}

const IsolatedCliSettings = Schema.Struct({
  trustedWorkspaces: Schema.Array(Schema.String),
  onboardingComplete: Schema.Boolean,
  colorScheme: Schema.String,
});
const encodeIsolatedCliSettings = Schema.encodeSync(Schema.fromJsonString(IsolatedCliSettings));

/**
 * Creates a scoped, empty home directory with minimal onboarding state and empty MCP/hook configs
 * so background `/usage` probes never spawn configured global or profile MCP servers or hooks.
 */
const makeIsolatedCliHome = Effect.fn("AntigravityUsageProbe.makeIsolatedCliHome")(function* (
  executablePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.gen(function* () {
    const isolatedHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-usage-" });
    const isolatedGeminiHome = path.join(isolatedHome, ".gemini");
    const cliDir = path.join(isolatedGeminiHome, "antigravity-cli");
    const cfgDir = path.join(isolatedGeminiHome, "config");
    yield* fs.makeDirectory(cliDir, { recursive: true });
    yield* fs.makeDirectory(cfgDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(cliDir, "settings.json"),
      encodeIsolatedCliSettings({
        trustedWorkspaces: [isolatedHome],
        onboardingComplete: true,
        colorScheme: "terminal",
      }),
    );
    yield* fs.writeFileString(
      path.join(cliDir, "onboarding.json"),
      '{"onboardingComplete":true,"completed":true}',
    );
    yield* fs.writeFileString(path.join(cfgDir, "mcp_config.json"), '{"mcpServers":{}}');
    yield* fs.writeFileString(path.join(cfgDir, "hooks.json"), "{}");
    return { isolatedHome, isolatedGeminiHome };
  }).pipe(
    Effect.mapError(
      (cause) =>
        new AntigravityCliUsageError({
          reason: "spawn_failed",
          executablePath,
          cause,
        }),
    ),
  );
});

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
    const singleWindowSeen = yield* Deferred.make<void>();
    const outputLimitExceeded = yield* Deferred.make<void>();
    const exited = yield* Deferred.make<void>();

    const screen = new MiniTerminalScreen(120, 160);
    let totalBytes = 0;
    let limitHit = false;
    let sentUsage = false;
    let dataSub: { dispose(): void } | undefined;
    let exitSub: { dispose(): void } | undefined;

    const proc = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          pty.spawn(input.executablePath, [...(input.args ?? [])], {
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
          yield* Deferred.await(exited).pipe(Effect.timeout("250 millis"), Effect.ignore);
          const exitedGracefully = yield* Deferred.isDone(exited);
          if (!exitedGracefully) {
            yield* Effect.sync(() => {
              try {
                handle.kill();
              } catch {
                // Ignore kill errors if already terminated.
              }
            });
            // Keep the scope (temp home + executable lease) open until the process exits or
            // the bounded wait completes.
            yield* Deferred.await(exited).pipe(Effect.timeout("1500 millis"), Effect.ignore);
          }
          yield* Effect.sync(() => {
            try {
              dataSub?.dispose();
            } catch {
              // Ignore listener disposal errors.
            }
            try {
              exitSub?.dispose();
            } catch {
              // Ignore listener disposal errors.
            }
          });
        }),
    );

    dataSub = proc.onData((chunk) => {
      if (limitHit) return;
      totalBytes += utf8Encoder.encode(chunk).byteLength;
      if (totalBytes > MAX_PTY_OUTPUT_BYTES) {
        limitHit = true;
        Deferred.doneUnsafe(outputLimitExceeded, Exit.void);
        return;
      }

      screen.write(chunk);

      if (!sentUsage) {
        if (chunk.includes("Antigravity CLI") || screen.toText().includes("Antigravity CLI")) {
          Deferred.doneUnsafe(bannerReady, Exit.void);
        }
        return;
      }

      const rendered = screen.toText();
      if (rendered.includes("Models & Quota") && rendered.includes("Limit Remaining")) {
        const parsed = parseRenderedAntigravityCliUsage(rendered, 0);
        if (parsed && parsed.windows.length >= 2) {
          Deferred.doneUnsafe(quotaReady, Exit.void);
        } else if (parsed && parsed.windows.length === 1) {
          Deferred.doneUnsafe(singleWindowSeen, Exit.void);
        }
      }
    });

    exitSub = proc.onExit(() => {
      Deferred.doneUnsafe(exited, Exit.void);
    });

    // Worst-case timeline stays well under the 30s outer probe timeout:
    // 8s banner + 0.9s + 0.35s + 12s quota + 0.7s flush + 1.75s teardown = 23.7s max.
    yield* Effect.raceFirst(
      Deferred.await(bannerReady),
      Effect.raceFirst(Deferred.await(exited), Deferred.await(outputLimitExceeded)),
    ).pipe(Effect.timeout("8 seconds"), Effect.ignore);

    if (!limitHit) {
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

      const singleWindowSettled = Deferred.await(singleWindowSeen).pipe(
        Effect.andThen(Effect.sleep("2 seconds")),
      );
      yield* Effect.raceFirst(
        Deferred.await(quotaReady),
        Effect.raceFirst(
          singleWindowSettled,
          Effect.raceFirst(Deferred.await(exited), Deferred.await(outputLimitExceeded)),
        ),
      ).pipe(Effect.timeout("12 seconds"), Effect.ignore);

      // Allow the final BubbleTea frame (all model groups) to finish flushing.
      yield* Effect.sleep("700 millis");
    }

    if (limitHit) {
      return yield* new AntigravityCliUsageError({
        reason: "output_limit_exceeded",
        executablePath: input.executablePath,
      });
    }

    const finalRendered = screen.toText();
    if (!parseRenderedAntigravityCliUsage(finalRendered, 0)) {
      return yield* new AntigravityCliUsageError({
        reason: "invalid_output",
        executablePath: input.executablePath,
      });
    }
    return finalRendered;
  },
);

export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* (input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravitySettings["authMethod"];
  readonly gcpProject?: string;
  readonly gcpLocation?: string;
  readonly resolveExecutable?: Effect.Effect<string, AntigravityCliUsageError, Scope.Scope>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runCliUsage?: (
    args: AntigravityCliUsageRunInput,
  ) => Effect.Effect<string, AntigravityCliUsageError>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Digest.Digest;
  const probeGate = yield* Semaphore.make(1);
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

    // Personal OAuth profiles isolate sign-ins per profile directory via file token storage;
    // do not fall through to a standalone host sign-in when the profile is unsigned-in.
    // Enterprise (`oauth-business`) instances do not force file storage and may keep credentials
    // exclusively in the OS keyring, so allow them to probe with their configured project.
    if (input.authMethod === "oauth-personal") {
      const hasProfileToken = yield* fs
        .exists(cliTokenPath)
        .pipe(Effect.orElseSucceed(() => false));
      if (!hasProfileToken) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Sign in with Google to see Antigravity limits.",
        });
      }
    }

    const rawOutput = yield* Effect.scoped(
      Effect.gen(function* () {
        // Hold any installation lease and isolated home through PTY exit.
        const executablePath = input.resolveExecutable ? yield* input.resolveExecutable : "agy";
        const { isolatedHome, isolatedGeminiHome } = yield* makeIsolatedCliHome(executablePath);
        const cleanEnv = buildAntigravityCliUsageEnv(input.environment ?? process.env, {
          isolatedHome,
          isolatedGeminiHome,
          ...(input.authMethod === "oauth-business" && input.gcpProject
            ? { gcpProject: input.gcpProject }
            : {}),
          ...(input.authMethod === "oauth-business" && input.gcpLocation
            ? { gcpLocation: input.gcpLocation }
            : {}),
        });
        const cliArgs =
          input.authMethod === "oauth-business" && input.gcpProject
            ? ["--project", input.gcpProject]
            : [];
        return yield* runCliUsage({
          executablePath,
          args: cliArgs,
          env: cleanEnv,
          cwd: isolatedHome,
        });
      }),
    ).pipe(
      Effect.tapError(() =>
        Effect.gen(function* () {
          if (generation === startedGeneration) {
            lastAttemptAtMs = yield* Clock.currentTimeMillis;
          }
        }),
      ),
    );

    const parsedAtMs = yield* Clock.currentTimeMillis;
    const observedAt = DateTime.formatIso(DateTime.makeUnsafe(parsedAtMs));
    const parsed = parseAntigravityCliUsageOutput(rawOutput, parsedAtMs);
    if (!parsed || parsed.windows.length === 0) {
      if (generation === startedGeneration) {
        lastAttemptAtMs = parsedAtMs;
      }
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Official Antigravity CLI did not return usable quota information.",
      });
    }

    const credentialFingerprint = parsed.accountEmail
      ? yield* antigravityEmailFingerprint(parsed.accountEmail)
      : undefined;

    if (generation === startedGeneration) {
      cached = {
        checkedAt: observedAt,
        windows: parsed.windows,
        ...(credentialFingerprint ? { credentialFingerprint } : {}),
        cachedAtMs: parsedAtMs,
      };
      lastAttemptAtMs = 0;
    }

    return {
      ...makeUsageLimits({ checkedAt: observedAt, windows: [...parsed.windows] }),
      ...(credentialFingerprint ? { credentialFingerprint } : {}),
    };
  });

  const probe = probeGate
    .withPermits(1)(read)
    .pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
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
