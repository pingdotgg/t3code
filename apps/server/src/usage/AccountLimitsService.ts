/**
 * AccountLimitsService - the server-wide account rate-limit cache.
 *
 * Fed passively: runtime ingestion forwards every
 * `account.rate-limits.updated` event here (Claude usage snapshots and
 * single-window events, Codex app-server notifications), so the cache costs
 * nothing while sessions run. When asked and Codex has no live snapshot, the
 * newest transcript snapshot is recovered from disk. Claude has no disk
 * fallback: its limits exist only on the live stream, which is why snapshots
 * are persisted across restarts.
 *
 * One snapshot per (provider, instance). Limits belong to provider
 * *accounts*, and the instance is the closest identity every event already
 * carries: with several instances configured (work + personal accounts, the
 * documented multi-account setup), a single per-provider slot makes the
 * accounts overwrite and suppress each other. Two instances logged into the
 * same account simply show the same numbers - honest, and free of credential
 * reads on the event path. Cache rows that predate instance attribution load
 * under the driver's default instance id, which is what the old single-slot
 * world semantically was - see `migratedSlots` for how long that lasts.
 *
 * @module AccountLimitsService
 */
import {
  ACCOUNT_LIMITS_CONTRACT_VERSION,
  AccountLimitsSnapshot,
  type AccountLimitsSummary,
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
  type UsageProviderKind,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";

import { expandHomePath } from "../pathExpansion.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  claudeUsageSnapshotFromUnknown,
  claudeWindowFromRateLimitEvent,
  codexSnapshotFromUnknown,
  isPrimaryCodexLimit,
  sortWindows,
  windowHasTraffic,
} from "./accountLimitsNormalize.ts";
import { readLatestCodexRateLimits } from "./accountLimitsTranscripts.ts";

/** Failed or empty transcript scans are not retried more often than this. */
const CODEX_SEED_MIN_INTERVAL_MS = 60_000;

/** On-disk shape of the snapshot cache: the contract array, JSON-encoded. */
const LimitsCacheFile = Schema.Array(AccountLimitsSnapshot);
const decodeLimitsCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LimitsCacheFile as unknown as Schema.Codec<typeof LimitsCacheFile.Type>),
);
const encodeLimitsCache = Schema.encodeEffect(
  Schema.fromJsonString(LimitsCacheFile as unknown as Schema.Codec<typeof LimitsCacheFile.Type>),
);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

export interface AccountLimitsIngestInput {
  /** Driver kind off the runtime event (`claudeAgent`, `codex`, ...). */
  readonly provider: string;
  /** The event's `payload.rateLimits`, in whatever shape the adapter emitted. */
  readonly payload: unknown;
  readonly createdAt: string;
  /**
   * Instance routing key off the event envelope. Optional during the
   * driver/instance migration; an absent value means the driver's default
   * instance, exactly like the envelope field it mirrors.
   */
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}

export class AccountLimitsService extends Context.Service<
  AccountLimitsService,
  {
    readonly readSummary: () => Effect.Effect<AccountLimitsSummary>;
    readonly ingest: (input: AccountLimitsIngestInput) => Effect.Effect<void>;
  }
>()("t3/usage/AccountLimitsService") {}

/** Empty cache, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  AccountLimitsService,
  AccountLimitsService.of({
    readSummary: () =>
      Effect.succeed({
        contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        snapshots: [],
      }),
    ingest: () => Effect.void,
  }),
);

function providerFromDriver(driver: string): UsageProviderKind | null {
  if (driver === "claudeAgent") return "claude";
  if (driver === "codex") return "codex";
  return null;
}

/**
 * The instance that owns data carrying no instance id: legacy emitters and
 * v1 cache rows. The legacy single-instance world used the driver kind
 * itself as the instance id (see `defaultInstanceIdForDriver`), so this is
 * not a guess - it is what that data always meant.
 */
function defaultInstanceIdForProvider(provider: UsageProviderKind): ProviderInstanceId {
  return defaultInstanceIdForDriver(
    ProviderDriverKind.make(provider === "claude" ? "claudeAgent" : "codex"),
  );
}

/**
 * Map key for one (provider, instance) slot. Structured, not interpolated:
 * no spelling of an instance id can collide with another slot's key.
 */
function slotKey(provider: UsageProviderKind, instanceId: ProviderInstanceId): string {
  return JSON.stringify([provider, instanceId]);
}

/** One codex instance's resolved transcript location. */
export interface CodexSeedTarget {
  readonly instanceId: ProviderInstanceId;
  readonly sessionsDir: string;
  /**
   * Disabled instances still own their transcripts - their sessions share
   * the dir whether or not the instance currently runs - so they count for
   * ambiguity, and only enabled sole owners are actually seeded.
   */
  readonly enabled: boolean;
}

/**
 * Sole-owner sessions dirs only. Shadow homes share `sessions/` with the
 * home they overlay (see CodexHomeLayout), and a transcript names no
 * account - so a directory that several instances write cannot be
 * attributed honestly, and seeding it into any one of them invents data
 * (seeding it into all of them invents more). Those dirs are skipped: live
 * events still meter every instance; the transcripts just stop pretending
 * to know whose usage they hold. Pure and exported for tests.
 */
export function planCodexTranscriptSeeds(
  targets: readonly CodexSeedTarget[],
): readonly CodexSeedTarget[] {
  const byDir = new Map<string, readonly CodexSeedTarget[]>();
  for (const target of targets) {
    byDir.set(target.sessionsDir, [...(byDir.get(target.sessionsDir) ?? []), target]);
  }
  return [...byDir.values()].flatMap((owners) => (owners.length === 1 ? owners : []));
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const hostEnvironment = yield* HostProcessEnvironment;

  const snapshots = new Map<string, AccountLimitsSnapshot>();
  /**
   * Slot keys holding rows migrated from the v1 single-slot cache. A v1 row
   * was "whichever account wrote last", not "the default instance" - the
   * default id is only the least-wrong home for it. The first write proves
   * the point either way: landing on the default slot confirms the row,
   * landing on any other instance of the same provider proves the migrated
   * row may belong to somebody else, so it is evicted rather than shown as
   * a ghost account forever. A transcript seed is a write like any other:
   * a sole-owner sessions dir is the same evidence of a distinct account
   * that a live event is, and the v1 row is no less ambiguous for having
   * been contradicted from disk. A default instance with transcripts of its
   * own re-seeds in the same pass, so nothing real is lost.
   */
  const migratedSlots = new Set<string>();
  const cachePath = path.join(config.stateDir, "account-limits.json");
  let lastCodexSeedAttemptAtMs = 0;

  // Restarts must not lose the Claude snapshot (stream-only, no disk source),
  // so the cache is persisted. Same Effect.cached trick as the usage scan
  // cache: concurrent first readers await one load.
  const ensureLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const stored = yield* fileSystem.readFileString(cachePath).pipe(
        Effect.flatMap((raw) => decodeLimitsCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (stored === null) return;
      for (const snapshot of stored) {
        // Rows written before instance attribution migrate to the default
        // instance rather than being discarded: Claude has no disk source,
        // so a wiped cache is an empty Limits strip until a session runs.
        const instanceId = snapshot.instanceId ?? defaultInstanceIdForProvider(snapshot.provider);
        const key = slotKey(snapshot.provider, instanceId);
        if (!snapshots.has(key)) {
          // Pre-upgrade caches were written before untouched windows were
          // filtered, so a bare 0%/no-reset row can come back from disk.
          snapshots.set(key, {
            ...snapshot,
            instanceId,
            windows: snapshot.windows.filter(windowHasTraffic),
          });
          if (snapshot.instanceId === undefined) migratedSlots.add(key);
        }
      }
    }),
  );

  /**
   * All snapshot mutations - event ingest (worker fiber), the transcript
   * seed and instance eviction (RPC fiber) - run under this one permit, so
   * each ordering guard, map write, and persist is atomic with respect to
   * the others. Without it a concurrent pair can both pass their guard
   * against the same prior snapshot and land in either order, rolling the
   * state backwards. Reads stay lock-free.
   */
  const stateLock = yield* Semaphore.make(1);

  // A cache we cannot write is a colder next start, not a failure. Only
  // called while holding `stateLock`, which is what serializes writes; the
  // temp-file + rename keeps a crashed write from tearing the file.
  const persist = Effect.fn("AccountLimitsService.persist")(function* () {
    // A still-unconfirmed migrated row is written back in its v1 shape (no
    // instanceId): the marker lives only in memory, and persisting the
    // synthesized id would make the row look settled after any restart -
    // permanently exempt from the other-instance eviction in `store`.
    const rows = [...snapshots.entries()].map(([key, snapshot]) => {
      if (!migratedSlots.has(key)) return snapshot;
      const { instanceId: _instanceId, ...rest } = snapshot;
      return rest;
    });
    yield* encodeLimitsCache(rows).pipe(
      Effect.flatMap((serialized) =>
        writeFileStringAtomically({ filePath: cachePath, contents: serialized }),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchCause(() => Effect.void),
    );
  });

  const store = Effect.fn("AccountLimitsService.store")(function* (
    snapshot: AccountLimitsSnapshot & { readonly instanceId: ProviderInstanceId },
  ) {
    const key = slotKey(snapshot.provider, snapshot.instanceId);
    // Windows reach this map from more places than the provider parsers:
    // the streamed Claude patch assembles its own array, and a patch can
    // carry a window the account has never metered. Enforcing the filter at
    // the single write path keeps the no-untouched-windows invariant true
    // for every caller, present and future.
    snapshots.set(key, { ...snapshot, windows: snapshot.windows.filter(windowHasTraffic) });
    // A write to a slot settles what that slot is; a write to any OTHER
    // instance of the provider evicts a still-unconfirmed migrated row (see
    // `migratedSlots`). Live events and transcript seeds count alike.
    migratedSlots.delete(key);
    const defaultKey = slotKey(snapshot.provider, defaultInstanceIdForProvider(snapshot.provider));
    if (key !== defaultKey && migratedSlots.has(defaultKey)) {
      snapshots.delete(defaultKey);
      migratedSlots.delete(defaultKey);
    }
    yield* persist();
  });

  const ingestClaude = Effect.fn("AccountLimitsService.ingestClaude")(function* (
    payload: unknown,
    createdAt: string,
    instanceId: ProviderInstanceId,
  ) {
    const previous = snapshots.get(slotKey("claude", instanceId));
    const full = claudeUsageSnapshotFromUnknown(payload);
    if (full !== null) {
      // Rate limits do not apply to this account (API key / Bedrock / Vertex):
      // nothing to show, and nothing worth clearing a previous snapshot over.
      // An APPLICABLE snapshot stores even with zero windows - all meters
      // untouched means the previous readings are gone, not still current.
      if (!full.rateLimitsApply) return;
      yield* store({
        provider: "claude",
        instanceId,
        plan: full.plan ?? previous?.plan ?? null,
        windows: full.windows,
        asOf: createdAt,
        source: "live",
      });
      return;
    }
    // The streamed event names one window; patch it into whatever set the
    // last full snapshot from the same instance established.
    const window = claudeWindowFromRateLimitEvent(payload);
    if (window === null) return;
    // An untouched streamed window (no utilization, no reset clock) carries
    // no reading - replacing the metered window it names would delete real
    // data, so it must leave the previous set alone entirely.
    if (!windowHasTraffic(window)) return;
    const windows = sortWindows([
      ...(previous?.windows ?? []).filter((existing) => existing.id !== window.id),
      window,
    ]);
    yield* store({
      provider: "claude",
      instanceId,
      plan: previous?.plan ?? null,
      windows,
      asOf: createdAt,
      source: "live",
    });
  });

  const ingestCodex = Effect.fn("AccountLimitsService.ingestCodex")(function* (
    payload: unknown,
    createdAt: string,
    instanceId: ProviderInstanceId,
  ) {
    const snapshot = codexSnapshotFromUnknown(payload);
    if (snapshot === null) return;
    // Per-model side meters (Spark) are not surfaced.
    if (!isPrimaryCodexLimit(snapshot.limitId)) return;
    if (snapshot.windows.length === 0) return;
    const previous = snapshots.get(slotKey("codex", instanceId));
    yield* store({
      provider: "codex",
      instanceId,
      plan: snapshot.plan ?? previous?.plan ?? null,
      windows: snapshot.windows,
      asOf: createdAt,
      source: "live",
    });
  });

  const ingest = Effect.fn("AccountLimitsService.ingest")(function* (
    input: AccountLimitsIngestInput,
  ) {
    const provider = providerFromDriver(input.provider);
    if (provider === null) return;
    const instanceId = input.providerInstanceId ?? defaultInstanceIdForProvider(provider);
    yield* ensureLoaded;
    yield* stateLock.withPermits(1)(
      Effect.gen(function* () {
        // Guard against out-of-order delivery: an event older than what is
        // already stored must not roll the snapshot backwards. Per slot -
        // one instance's traffic must not suppress another's.
        const existing = snapshots.get(slotKey(provider, instanceId));
        if (existing !== undefined && input.createdAt < existing.asOf) return;
        if (provider === "claude") {
          yield* ingestClaude(input.payload, input.createdAt, instanceId);
        } else {
          yield* ingestCodex(input.payload, input.createdAt, instanceId);
        }
      }),
    );
  });

  /**
   * Recovers Codex snapshots from session transcripts when they are newer
   * than what the cache holds - which covers both a cold cache and Codex
   * sessions driven outside T3 Code. Instances are enumerated the same way
   * the registry derives them, so the legacy single-instance mirror is
   * included; only sessions dirs owned by exactly one instance are read
   * (see `planCodexTranscriptSeeds`).
   */
  const maybeSeedCodexFromTranscripts = Effect.fn("AccountLimitsService.seedCodex")(function* (
    nowMs: number,
    configMap: ProviderInstanceConfigMap | null,
  ) {
    if (configMap === null) return;
    if (nowMs - lastCodexSeedAttemptAtMs < CODEX_SEED_MIN_INTERVAL_MS) return;
    lastCodexSeedAttemptAtMs = nowMs;

    const targets: CodexSeedTarget[] = [];
    for (const [rawInstanceId, entry] of Object.entries(configMap)) {
      if (entry.driver !== "codex") continue;
      const codexSettings = yield* decodeCodexSettings(entry.config ?? {}).pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (codexSettings === null) continue;
      // Where the spawned CLI actually writes: an explicit homePath wins,
      // else the CODEX_HOME its child env would carry (instance override,
      // then ambient) - resolveCodexHomeLayout alone answers ~/.codex even
      // when the CLI it describes is writing somewhere else.
      let sessionsParent: string;
      const envOverride = entry.environment
        ?.find((variable) => variable.name === "CODEX_HOME")
        ?.value.trim();
      // A shadow overlay pins the layout: spawn overrides CODEX_HOME with
      // the overlay path, so an instance env value never reaches the CLI.
      const envHome =
        codexSettings.homePath.trim() === "" && codexSettings.shadowHomePath.trim() === ""
          ? envOverride || hostEnvironment["CODEX_HOME"]?.trim() || ""
          : "";
      if (envHome !== "") {
        sessionsParent = expandHomePath(envHome);
      } else {
        const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
          Effect.provideService(Path.Path, path),
        );
        sessionsParent = layout.sharedHomePath;
      }
      const sessionsDir = path.join(sessionsParent, "sessions");
      // Compare filesystem identity, not spellings: a symlinked home and its
      // target are one directory, and treating them as two would hand the
      // same account-ambiguous transcripts to both.
      const canonical = yield* fileSystem
        .realPath(sessionsDir)
        .pipe(Effect.catchCause(() => Effect.succeed(sessionsDir)));
      targets.push({
        instanceId: ProviderInstanceId.make(rawInstanceId),
        sessionsDir: canonical,
        enabled: entry.enabled !== false,
      });
    }

    for (const target of planCodexTranscriptSeeds(targets)) {
      if (!target.enabled) continue;
      const found = yield* Effect.promise(() =>
        readLatestCodexRateLimits(target.sessionsDir, nowMs),
      );
      if (found === null) continue;
      const asOf = DateTime.formatIso(DateTime.makeUnsafe(found.asOfMs));
      // The slow transcript reads happened outside the lock; only the
      // guard-and-store is serialized against live ingests.
      yield* stateLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = snapshots.get(slotKey("codex", target.instanceId));
          // ISO-8601 strings order lexicographically.
          if (existing !== undefined && existing.asOf >= asOf) return;
          yield* store({
            provider: "codex",
            instanceId: target.instanceId,
            plan: found.snapshot.plan ?? existing?.plan ?? null,
            windows: found.snapshot.windows,
            asOf,
            source: "transcript",
          });
        }),
      );
    }
  });

  const readSummary = Effect.fn("AccountLimitsService.readSummary")(function* () {
    yield* ensureLoaded;
    const nowMs = yield* Clock.currentTimeMillis;
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    const configMap = settings === null ? null : deriveProviderInstanceConfigMap(settings);
    yield* maybeSeedCodexFromTranscripts(nowMs, configMap).pipe(
      Effect.catchCause(() => Effect.void),
    );
    // A deleted instance takes its rows with it - anything else leaves a
    // ghost account forcing the captioned multi-row UI forever. A merely
    // disabled instance keeps its cache (re-enabling restores it) but stays
    // out of the summary. Default instances always derive, so single-account
    // setups are untouched by either rule.
    if (configMap !== null) {
      yield* stateLock.withPermits(1)(
        Effect.gen(function* () {
          let evicted = false;
          for (const [key, snapshot] of snapshots) {
            const instanceId =
              snapshot.instanceId ?? defaultInstanceIdForProvider(snapshot.provider);
            const entry = configMap[instanceId];
            // Gone entirely, or reconfigured to a different driver: either
            // way the row's data belongs to an account this id no longer
            // names, and a stale row would be captioned with the NEW
            // driver's display name.
            if (entry === undefined || providerFromDriver(entry.driver) !== snapshot.provider) {
              snapshots.delete(key);
              migratedSlots.delete(key);
              evicted = true;
            }
          }
          if (evicted) yield* persist();
        }),
      );
    }
    const visible = [...snapshots.values()].filter((snapshot) => {
      if (configMap === null) return true;
      const instanceId = snapshot.instanceId ?? defaultInstanceIdForProvider(snapshot.provider);
      return configMap[instanceId]?.enabled !== false;
    });
    return {
      contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
      readAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      // Codepoint order, not localeCompare: instance ids are user-authored
      // slugs and the summary's order must not change with the host locale.
      snapshots: visible.sort((a, b) => {
        const left = `${a.provider} ${a.instanceId ?? ""}`;
        const right = `${b.provider} ${b.instanceId ?? ""}`;
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    } satisfies AccountLimitsSummary;
  });

  return { readSummary, ingest } as const;
});

export const layer = Layer.effect(AccountLimitsService, make);
