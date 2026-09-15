/**
 * Oh My Pi subscription usage (`omp usage --json`).
 *
 * The probe enumerates the authenticated accounts per upstream provider, so a
 * report row is proof of credentials: any non-empty provider list means
 * `authenticated`, anything else stays `unknown` (never a false
 * `unauthenticated`).
 *
 * Window-selection rule: every non-expired window from every report is
 * published (sorted session → weekly → monthly → other by `makeUsageLimits`).
 * The banner-driving window is the non-expired window with the highest
 * `usedPercent`; ties break toward the shorter window, then the smallest id
 * (see `selectOmpBannerWindow`). A window whose `resetsAt` is at or before
 * `checkedAt` already reset, so it is dropped instead of shown stale.
 * Labels are prefixed with the provider only when several providers report,
 * so a lone account keeps its plain `5-hour` style label.
 *
 * Refresh policy: probed fresh on every provider status check with a bounded
 * timeout, degraded to no usage limits on any failure. Live turns refine the
 * published windows through the adapter's `account.rate-limits.updated`
 * events, which upsert by the stable `${provider}:${window}` ids built here —
 * the sibling adapter task must reuse `ompUsageWindowId` for its updates to
 * land on the probe's rows.
 *
 * @module provider/Drivers/OmpUsage
 */
import type {
  OmpSettings,
  ServerProviderAuth,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { spawnAndCollect } from "../providerSnapshot.ts";
import { clampPercent, makeUsageLimits } from "../providerUsageLimits.ts";

/** Bound for the read-only `omp usage --json` probe (mirrors Codex's rate-limits probe). */
export const OMP_USAGE_PROBE_TIMEOUT_MS = 3_000;

// Schema Structs ignore unknown keys by default, so forward-compatible CLI
// additions decode fine; every field below stays optional so one missing key
// degrades a single entry instead of failing the whole probe.
const OmpUsageAmountSchema = Schema.Struct({
  used: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.Number),
  usedFraction: Schema.optional(Schema.Number),
  remainingFraction: Schema.optional(Schema.Number),
  unit: Schema.optional(Schema.String),
});

// omp emits timestamps as epoch milliseconds (`"generatedAt": 1789401597111`),
// not ISO strings, and a single wrong type would fail the whole payload decode
// and silently report unauthenticated-but-unknown. Both shapes are accepted
// and normalized where they are read.
const OmpUsageTimestampSchema = Schema.Union([Schema.String, Schema.Number]);

const OmpUsageWindowSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(OmpUsageTimestampSchema),
});

const OmpUsageScopeSchema = Schema.Struct({
  provider: Schema.optional(Schema.String),
  windowId: Schema.optional(Schema.String),
  shared: Schema.optional(Schema.Boolean),
});

const OmpUsageLimitSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  scope: Schema.optional(OmpUsageScopeSchema),
  window: Schema.optional(OmpUsageWindowSchema),
  amount: Schema.optional(OmpUsageAmountSchema),
  status: Schema.optional(Schema.String),
});

const OmpUsageAccountMetadataSchema = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  orgName: Schema.optional(Schema.String),
});

const OmpUsageReportSchema = Schema.Struct({
  provider: Schema.optional(Schema.String),
  fetchedAt: Schema.optional(OmpUsageTimestampSchema),
  // The authenticated account behind this report; omp redacts it only when
  // asked, so the plain probe carries the address the card shows.
  metadata: Schema.optional(OmpUsageAccountMetadataSchema),
  // Decoded entry-by-entry below so one malformed limit cannot sink the rest.
  limits: Schema.optional(Schema.Array(Schema.Unknown)),
});

const OmpUsagePayloadSchema = Schema.Struct({
  generatedAt: Schema.optional(OmpUsageTimestampSchema),
  // Same per-entry tolerance as limits: a bad report is skipped, not fatal.
  reports: Schema.optional(Schema.Array(Schema.Unknown)),
});

export type OmpUsagePayload = typeof OmpUsagePayloadSchema.Type;
type OmpUsageReport = typeof OmpUsageReportSchema.Type;
type OmpUsageLimit = typeof OmpUsageLimitSchema.Type;

/** Best-effort top-level decode: `undefined` means the probe cannot tell anything. */
export function decodeOmpUsageOutput(stdout: string): OmpUsagePayload | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const decoded = Schema.decodeUnknownOption(OmpUsagePayloadSchema)(parsed);
  return Option.getOrUndefined(decoded);
}

function decodeReports(payload: OmpUsagePayload): ReadonlyArray<OmpUsageReport> {
  const reports: Array<OmpUsageReport> = [];
  for (const raw of payload.reports ?? []) {
    const decoded = Schema.decodeUnknownOption(OmpUsageReportSchema)(raw);
    if (Option.isSome(decoded)) {
      reports.push(decoded.value);
    }
  }
  return reports;
}

function decodeLimits(report: OmpUsageReport): ReadonlyArray<OmpUsageLimit> {
  const limits: Array<OmpUsageLimit> = [];
  for (const raw of report.limits ?? []) {
    const decoded = Schema.decodeUnknownOption(OmpUsageLimitSchema)(raw);
    if (Option.isSome(decoded)) {
      limits.push(decoded.value);
    }
  }
  return limits;
}

/** Distinct authenticated provider names in first-seen order. */
export function ompUsageProviders(payload: OmpUsagePayload): ReadonlyArray<string> {
  const providers: Array<string> = [];
  for (const report of decodeReports(payload)) {
    const provider = report.provider?.trim();
    if (provider && !providers.includes(provider)) {
      providers.push(provider);
    }
  }
  return providers;
}

/**
 * Auth derived from the probe: a report row enumerates an authenticated
 * account, so any provider present proves credentials. Anything else is
 * `unknown` — the probe cannot distinguish logged-out from broken.
 */
export function ompUsageToAuth(payload: OmpUsagePayload | undefined): ServerProviderAuth {
  const reports = payload ? decodeReports(payload) : [];
  const providers = payload ? ompUsageProviders(payload) : [];
  if (providers.length === 0) {
    return { status: "unknown" };
  }
  // The card only names an account when it has an address; without one an
  // authenticated provider reads as a bare status line.
  const email = reports
    .map((report) => report.metadata?.email?.trim())
    .find((candidate) => candidate !== undefined && candidate.length > 0);
  return {
    status: "authenticated",
    // The single ACP `agent` method backed by local credentials.
    type: "agent",
    ...(email ? { email } : {}),
    label:
      providers.length === 1
        ? providers[0]!
        : `${providers.length} providers: ${providers.join(", ")}`,
  };
}

const MONTH_MINS = 30 * 24 * 60;
const WEEK_MINS = 7 * 24 * 60;

function kindForDurationMins(mins: number): ServerProviderUsageWindow["kind"] {
  if (mins >= MONTH_MINS) {
    return "monthly";
  }
  if (mins >= WEEK_MINS) {
    return "weekly";
  }
  return "session";
}

// omp window ids read like `5h`/`7d`; fall back to token sniffing only when
// the CLI omits `durationMs`, so a rename cannot silently mislabel a window.
function kindForWindowId(windowId: string): ServerProviderUsageWindow["kind"] | undefined {
  const normalized = windowId.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (/(month|30d)/.test(normalized)) {
    return "monthly";
  }
  if (/(week|7d|[^0-9]d\b|\dd\b)/.test(normalized)) {
    return "weekly";
  }
  if (/(hour|session|[^0-9]h\b|\dh\b|min)/.test(normalized)) {
    return "session";
  }
  return undefined;
}

/**
 * Stable probe id. Upstream providers repeat the same window ids (`5h`,
 * `7d`), so the provider prefix keeps their rows distinct and lets runtime
 * `account.rate-limits.updated` events upsert by id onto the probe's rows.
 */
export function ompUsageWindowId(provider: string, windowId: string): string {
  return `${provider}:${windowId}`;
}

// `usedFraction` reads 0–1, but a future CLI may already emit percent; values
// above 1 pass through and the clamp below keeps both scales inside 0–100.
function normalizeUsedPercent(amount: OmpUsageLimit["amount"]): number | undefined {
  if (typeof amount?.usedFraction === "number" && Number.isFinite(amount.usedFraction)) {
    return clampPercent(amount.usedFraction > 1 ? amount.usedFraction : amount.usedFraction * 100);
  }
  if (typeof amount?.remainingFraction === "number" && Number.isFinite(amount.remainingFraction)) {
    const remaining =
      amount.remainingFraction > 1 ? amount.remainingFraction : amount.remainingFraction * 100;
    return clampPercent(100 - remaining);
  }
  if (
    typeof amount?.used === "number" &&
    typeof amount?.limit === "number" &&
    Number.isFinite(amount.used) &&
    Number.isFinite(amount.limit) &&
    amount.limit > 0
  ) {
    return clampPercent((amount.used / amount.limit) * 100);
  }
  return undefined;
}

function parseIsoDate(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** omp timestamps arrive as epoch milliseconds or, in older builds, ISO text. */
function ompTimestampToMillis(value: string | number | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  return parseIsoDate(value?.trim());
}

// Effect represents dates through `DateTime`; this mirrors the Codex usage
// mapping, which builds its reset timestamps the same way.
function isoFromMillis(value: number): string | undefined {
  const dateTime = DateTime.make(value);
  return Option.isSome(dateTime) ? DateTime.formatIso(dateTime.value) : undefined;
}

function ompUsageLimitToWindow(input: {
  readonly provider: string;
  readonly limit: OmpUsageLimit;
  readonly qualifyLabel: boolean;
  readonly checkedAtMs: number | undefined;
}): ServerProviderUsageWindow | undefined {
  const { provider, limit, qualifyLabel, checkedAtMs } = input;
  const windowId =
    limit.window?.id?.trim() || limit.scope?.windowId?.trim() || limit.id?.trim() || undefined;
  if (!windowId) {
    return undefined;
  }
  const usedPercent = normalizeUsedPercent(limit.amount);
  if (usedPercent === undefined) {
    return undefined;
  }
  const resetsAtMs = ompTimestampToMillis(limit.window?.resetsAt);
  if (resetsAtMs !== undefined && checkedAtMs !== undefined && resetsAtMs <= checkedAtMs) {
    return undefined;
  }
  const durationMins =
    typeof limit.window?.durationMs === "number" &&
    Number.isFinite(limit.window.durationMs) &&
    limit.window.durationMs > 0
      ? Math.round(limit.window.durationMs / 60_000)
      : undefined;
  const kind =
    durationMins !== undefined
      ? kindForDurationMins(durationMins)
      : (kindForWindowId(windowId) ?? "other");
  const baseLabel = limit.label?.trim() || limit.window?.label?.trim() || windowId;
  const resetsAt = resetsAtMs !== undefined ? isoFromMillis(resetsAtMs) : undefined;
  return {
    id: ompUsageWindowId(provider, windowId),
    kind,
    label: qualifyLabel ? `${provider} · ${baseLabel}` : baseLabel,
    usedPercent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(durationMins !== undefined ? { windowDurationMins: durationMins } : {}),
  };
}

/** Every publishable window across all reports; `undefined` when none survive. */
export function ompUsageToLimits(input: {
  readonly payload: OmpUsagePayload | undefined;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  if (!input.payload) {
    return undefined;
  }
  const reports = decodeReports(input.payload);
  const providers = ompUsageProviders(input.payload);
  const qualifyLabel = providers.length > 1;
  const checkedAtMs = parseIsoDate(input.checkedAt);
  const windows: Array<ServerProviderUsageWindow> = [];
  for (const report of reports) {
    const provider = report.provider?.trim() || "omp";
    for (const limit of decodeLimits(report)) {
      const window = ompUsageLimitToWindow({
        provider,
        limit,
        qualifyLabel,
        checkedAtMs,
      });
      if (window) {
        windows.push(window);
      }
    }
  }
  if (windows.length === 0) {
    return undefined;
  }
  return makeUsageLimits({ checkedAt: input.checkedAt, windows });
}

const BANNER_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

/**
 * The window the composer banner is driven by: highest spend first, then the
 * shorter window, then the smallest id. Purely a selection rule — publishing
 * keeps every window via `makeUsageLimits` ordering.
 */
export function selectOmpBannerWindow(
  windows: Iterable<ServerProviderUsageWindow>,
): ServerProviderUsageWindow | undefined {
  let selected: ServerProviderUsageWindow | undefined;
  for (const window of windows) {
    if (
      !selected ||
      window.usedPercent > selected.usedPercent ||
      (window.usedPercent === selected.usedPercent &&
        (BANNER_KIND_ORDER[window.kind] - BANNER_KIND_ORDER[selected.kind] ||
          window.id.localeCompare(selected.id)) < 0)
    ) {
      selected = window;
    }
  }
  return selected;
}

export interface OmpUsageProbeResult {
  readonly auth: ServerProviderAuth;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
}

const degradedOmpUsage: OmpUsageProbeResult = { auth: { status: "unknown" } };

function degradedOmpUsageResult(reason: string): Effect.Effect<OmpUsageProbeResult> {
  return Effect.as(Effect.logDebug(`Oh My Pi usage probe degraded: ${reason}.`), degradedOmpUsage);
}

/**
 * Read-only `omp usage --json` probe. Never fails and never blocks startup:
 * every failure mode (missing CLI, timeout, non-zero exit, malformed JSON,
 * empty reports) degrades to unknown auth with no usage limits, leaving the
 * version/ACP health check to report CLI problems.
 */
export const probeOmpUsage = (
  ompSettings: Pick<OmpSettings, "binaryPath">,
  checkedAt: string,
  environment?: NodeJS.ProcessEnv,
): Effect.Effect<OmpUsageProbeResult, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const probe = Effect.gen(function* () {
    const command = ompSettings.binaryPath || "omp";
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      ["usage", "--json"],
      environment ? { env: environment } : {},
    );
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(environment ? { env: environment } : { extendEnv: true }),
        shell: spawnCommand.shell,
      }),
    );
  });
  return probe.pipe(
    Effect.timeoutOption(OMP_USAGE_PROBE_TIMEOUT_MS),
    Effect.flatMap((result) => {
      if (Option.isNone(result)) {
        return degradedOmpUsageResult("timed out");
      }
      const output = result.value;
      if (output.code !== 0) {
        return degradedOmpUsageResult(`exited with status ${output.code}`);
      }
      const payload = decodeOmpUsageOutput(output.stdout);
      if (!payload) {
        return degradedOmpUsageResult("unparseable output");
      }
      const usageLimits = ompUsageToLimits({ payload, checkedAt });
      return Effect.succeed({
        auth: ompUsageToAuth(payload),
        ...(usageLimits ? { usageLimits } : {}),
      } satisfies OmpUsageProbeResult);
    }),
    Effect.catch(() => degradedOmpUsageResult("spawn failed")),
  );
};
