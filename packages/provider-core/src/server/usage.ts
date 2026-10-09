/**
 * The usage reader contract: how a driver tells the server's usage page where
 * its history lives and how to read it.
 *
 * A driver either points at JSONL transcripts that the server's shared engine
 * streams, caches and resumes (`kind: "transcripts"`), or scans its own
 * sources and returns their records (`kind: "scan"`). The server owns
 * pricing, aggregation, de-duplication and the scan cache.
 *
 * @module provider-core/server/usage
 */
import type {
  ProviderInstanceId,
  ServerSettings,
  UsageProviderKind,
  UsageReadError,
  UsageSource,
  UsageTokenTotals,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

/**
 * Billing speed of a request. Faster speeds bill at a model-specific premium.
 * Claude fast mode and Codex `priority` are `fast`; Codex `ultrafast` is its
 * own, more expensive tier.
 */
export type UsageSpeed = "standard" | "fast" | "ultrafast";

export interface UsageRecord {
  readonly provider: UsageProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  /**
   * Rate-table key when the provider's display name carries tiers the table
   * does not know, such as Cursor's `claude-opus-5-5-high`. Defaults to `model`.
   */
  readonly rateModel?: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  readonly reportedCostUsd: number | null;
  /** Only Claude Code and Codex record a speed; other providers are `standard`. */
  readonly speed: UsageSpeed;
  /**
   * Key for cross-file de-duplication, or `null` when the record is inherently
   * unique and needs no dedup.
   */
  readonly dedupeKey: string | null;
}

export const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

export function totalTokens(totals: UsageTokenTotals): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/** A token count from untrusted JSON: a positive finite number, truncated, else 0. */
export function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Epoch milliseconds of an ISO timestamp string, or `null`. */
export function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** JSON fields a format reads. `true` keeps the whole subtree. */
export type SelectedFields = { readonly [key: string]: true | SelectedFields };

/**
 * How the server's JSONL engine reads one provider's transcript lines.
 *
 * Lines arrive one at a time. A line too large to parse whole is projected to
 * `selectFields` and handed to `parseProjected` instead of `parseLine`.
 */
export interface TranscriptUsageFormat<State> {
  readonly selectFields: SelectedFields;
  /**
   * Cheap substring gate applied before `JSON.parse`. Transcripts are mostly
   * tool output; skipping lines that cannot matter is worth an order of
   * magnitude. Lines that only update `State` must pass too.
   */
  mightCarryUsage(line: string): boolean;
  parseLine(line: string, state: State): readonly UsageRecord[];
  parseProjected(projected: unknown, state: State): readonly UsageRecord[];
  /**
   * Present for formats whose records depend on earlier lines. The state at a
   * resume point is persisted in the scan cache through `schema`, so a grown
   * file resumes with it. Absent means every line stands alone.
   */
  readonly state?: {
    readonly initial: () => State;
    readonly schema: Schema.Codec<State, unknown>;
  };
  /**
   * Whether one session's records may appear in several files, such as a
   * rollout copied when it moves. The server then keys those sessions'
   * records for cross-file de-duplication.
   */
  readonly sharedSessionsAcrossFiles?: true;
}

/** A configured instance of the driver, its config already decoded by `driver.configSchema`. */
export interface ProviderUsageInstance<Config> {
  readonly instanceId: ProviderInstanceId;
  /**
   * `undefined` when the stored config does not decode. The instance still has
   * history on disk, so readers that need no config read it anyway.
   */
  readonly config: Config | undefined;
  /** The instance's environment merged over the host environment. */
  readonly environment: NodeJS.ProcessEnv;
  /** Whether settings list the instance, rather than it being the implicit default. */
  readonly configured: boolean;
}

/** One source a `scan` reader read. */
export interface ProviderUsageScan {
  readonly dir: string;
  /** Identity of the source across hosts. Defaults to the filesystem identity of `dir`. */
  readonly volumeId?: string;
  /** Overrides the server's host name in the source fingerprint, for account-wide sources. */
  readonly hostId?: string;
  readonly status?: UsageSource["status"];
  readonly message?: string;
  readonly action?: UsageSource["action"];
  /** Parsed records per file, or `null` when the source does not exist. */
  readonly files:
    | readonly { readonly path: string; readonly records: readonly UsageRecord[] }[]
    | null;
  /** Answered from a cache while a refresh runs. */
  readonly refreshing?: true;
}

export interface ProviderUsageScanInput<Config> {
  readonly instances: ReadonlyArray<ProviderUsageInstance<Config>>;
  /** The settings snapshot the whole read runs against. */
  readonly settings: ServerSettings;
  /** Files last written before this cannot hold records inside the window. */
  readonly windowStartMs: number;
  /** The oldest usage the server keeps; account caches cover back to here. */
  readonly retentionCutoffMs: number;
  /** Wait for a slow refresh instead of answering from a cache. */
  readonly awaitRefresh: boolean;
}

export type ProviderUsageReader<Config, R> =
  | {
      readonly kind: "transcripts";
      readonly provider: UsageProviderKind;
      readonly format: TranscriptUsageFormat<unknown>;
      /**
       * Transcript directories for one instance. The server canonicalizes,
       * de-duplicates and scans them; `fileName` limits a walk to one basename.
       */
      readonly directories: (
        instance: ProviderUsageInstance<Config>,
      ) => Effect.Effect<
        ReadonlyArray<{ readonly dir: string; readonly fileName?: string }>,
        never,
        R
      >;
    }
  | {
      readonly kind: "scan";
      readonly provider: UsageProviderKind;
      /** Fails only when the whole usage read cannot go on; an unreadable source is a status. */
      readonly scan: (
        input: ProviderUsageScanInput<Config>,
      ) => Effect.Effect<ReadonlyArray<ProviderUsageScan>, UsageReadError, R>;
    };
