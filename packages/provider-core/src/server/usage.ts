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

export type UsageSpeed = "standard" | "fast" | "ultrafast";

export interface UsageRecord {
  readonly provider: UsageProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  readonly rateModel?: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  readonly reportedCostUsd: number | null;
  readonly speed: UsageSpeed;
  readonly unresolvedServiceTierTurnId?: string;
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

export function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export type SelectedFields = { readonly [key: string]: true | SelectedFields };

export interface TranscriptUsageFormat<State> {
  readonly selectFields: SelectedFields;
  /** ASCII markers must match every relevant line, including state-only updates. */
  readonly usageMarkers: readonly [string, ...string[]];
  parseLine(line: string, state: State): readonly UsageRecord[];
  parseProjected(projected: unknown, state: State): readonly UsageRecord[];
  /** Cumulative malformed or inconsistent usage records, including skipped records. */
  readMalformedRecords?(state: State): number;
  /**
   * Present for formats whose records depend on earlier lines. The state at a
   * resume point is persisted in the scan cache through `schema`, so a grown
   * file resumes with it. Absent means every line stands alone.
   */
  readonly state?: {
    readonly initial: () => State;
    readonly schema: Schema.Codec<State, unknown>;
  };
  /** Enable cross-file deduplication when session records can appear in multiple files. */
  readonly sharedSessionsAcrossFiles?: true;
}

export interface ProviderUsageInstance<Config> {
  readonly instanceId: ProviderInstanceId;
  /** Undefined for invalid stored config; config-independent readers should still read history. */
  readonly config: Config | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly configured: boolean;
}

export interface ProviderUsageScan {
  readonly dir: string;
  readonly volumeId?: string;
  readonly hostId?: string;
  readonly status?: UsageSource["status"];
  readonly message?: string;
  readonly action?: UsageSource["action"];
  readonly files:
    | readonly { readonly path: string; readonly records: readonly UsageRecord[] }[]
    | null;
  readonly refreshing?: true;
}

export interface ProviderUsageScanInput<Config> {
  readonly instances: ReadonlyArray<ProviderUsageInstance<Config>>;
  readonly settings: ServerSettings;
  readonly windowStartMs: number;
  readonly retentionCutoffMs: number;
  readonly awaitRefresh: boolean;
}

export type ProviderUsageReader<Config, R> =
  | {
      readonly kind: "transcripts";
      readonly provider: UsageProviderKind;
      readonly format: TranscriptUsageFormat<unknown>;
      readonly resolveServiceTiers?: (
        records: readonly UsageRecord[],
      ) => Effect.Effect<ReadonlyMap<UsageRecord, UsageSpeed>, never, R>;
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
