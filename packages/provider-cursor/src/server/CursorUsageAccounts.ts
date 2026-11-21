import type { ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ProviderUsageScan } from "@t3tools/provider-core/server/usage";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  CURSOR_ACCOUNT_CACHE_FILE_NAME,
  CURSOR_ACCOUNT_TTL_MS,
  CURSOR_MIN_FETCH_SPAN_MS,
  cursorFetchRange,
  decodeCursorAccountCaches,
  encodeCursorAccountCaches,
  isCursorCacheFresh,
  mergeCursorFetch,
  type CursorAccountCache,
  type CursorCredentialSource,
} from "./accountCache.ts";
import * as CursorAccountReader from "./CursorAccountReader.ts";
import { readStoredCursorApiKey } from "./credentialStore.ts";

const CURSOR_ACCOUNT_READ_ERROR = "Cursor account usage could not be read.";

const decodeCacheFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>),
);

export class CursorUsageAccounts extends Context.Service<
  CursorUsageAccounts,
  {
    readonly scan: (input: {
      readonly instances: ReadonlyArray<{
        readonly instanceId: ProviderInstanceId;
        readonly environment: NodeJS.ProcessEnv;
      }>;
      readonly windowStartMs: number;
      readonly retentionCutoffMs: number;
      readonly awaitRefresh: boolean;
    }) => Effect.Effect<ReadonlyArray<ProviderUsageScan>>;
    readonly awaitPersisted: Effect.Effect<void>;
  }
>()("@t3tools/provider-cursor/server/CursorUsageAccounts") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const accountReader = yield* CursorAccountReader.CursorAccountReader;
  const digest = yield* Digest.Digest;

  const cachePath = path.join(host.paths.stateDir, CURSOR_ACCOUNT_CACHE_FILE_NAME);
  const caches = new Map<string, CursorAccountCache>();
  let cacheDirty = false;
  /** Failed refreshes share the cache TTL to prevent repeated requests; null means no login. */
  const failures = new Map<string, { readonly atMs: number; readonly error: string | null }>();
  const refreshes = new Map<string, Deferred.Deferred<void>>();
  /** Widest range the next read asks for, narrowed after failures until the cache is complete. */
  const fetchSpans = new Map<string, number>();

  const ensureLoaded = yield* Effect.cached(
    fileSystem.readFileString(cachePath).pipe(
      Effect.flatMap((raw) => decodeCacheFile(raw)),
      Effect.catchCause(() => Effect.succeed(null)),
      Effect.map((document) => {
        for (const [key, cache] of decodeCursorAccountCaches(document)) caches.set(key, cache);
      }),
    ),
  );

  // Serialize snapshots; clear dirty before encoding and restore it on failure so changes retry.
  const persistLock = yield* Semaphore.make(1);
  const persist = Effect.gen(function* () {
    if (!cacheDirty) return;
    cacheDirty = false;
    yield* Effect.sync(() => encodeCursorAccountCaches(caches)).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: cachePath, contents })),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchCause(() =>
        Effect.sync(() => {
          cacheDirty = true;
        }),
      ),
    );
  }).pipe(persistLock.withPermit, Effect.withSpan("CursorUsageAccounts.persist"));

  const pendingPersists = new Set<Fiber.Fiber<void>>();
  const schedulePersist = Effect.forkDetach(persist).pipe(
    Effect.map((fiber) => {
      pendingPersists.add(fiber);
      fiber.addObserver(() => pendingPersists.delete(fiber));
    }),
  );
  const awaitPersisted = Effect.suspend(() => Fiber.awaitAll([...pendingPersists])).pipe(
    Effect.asVoid,
  );
  yield* Effect.addFinalizer(() => awaitPersisted);

  const refreshLock = yield* Semaphore.make(2);
  const refreshAccount = Effect.fn("CursorUsageAccounts.refreshAccount")(function* (
    credential: CursorCredentialSource,
    credentialKey: string,
    retentionStartMs: number,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    let checkedAccount = false;
    let span = fetchSpans.get(credentialKey) ?? Number.POSITIVE_INFINITY;
    // Widen after each success so a span narrowed by earlier failures recovers in a few reads.
    let widening = true;
    let widened = false;
    for (;;) {
      const base = caches.get(credentialKey);
      const range = cursorFetchRange(base, retentionStartMs, nowMs, span);
      const result = yield* accountReader.read(credential, range.sinceMs, range.untilMs);
      if (
        !checkedAccount &&
        base !== undefined &&
        result.accountKey !== null &&
        result.accountKey !== base.accountKey
      ) {
        caches.delete(credentialKey);
        cacheDirty = true;
        checkedAccount = true;
        continue;
      }
      checkedAccount = true;
      if (result.missing || result.error !== null || result.accountKey === null) {
        // A large account's full history can outlast the read deadlines; try a narrower range.
        span = Math.max(CURSOR_MIN_FETCH_SPAN_MS, (range.untilMs - range.sinceMs) / 2);
        fetchSpans.set(credentialKey, span);
        if (widened) {
          // The span before widening just worked: keep going with it instead of failing.
          widened = false;
          widening = false;
          continue;
        }
        failures.set(credentialKey, {
          atMs: nowMs,
          error: result.missing || result.error !== null ? result.error : CURSOR_ACCOUNT_READ_ERROR,
        });
        yield* schedulePersist;
        return;
      }
      const merged = mergeCursorFetch(
        base,
        result.accountKey,
        range,
        result.records,
        nowMs,
        retentionStartMs,
      );
      caches.set(credentialKey, merged.cache);
      failures.delete(credentialKey);
      if (merged.changed) cacheDirty = true;
      yield* schedulePersist;
      if (merged.cache.sinceMs <= retentionStartMs && merged.cache.untilMs >= nowMs) break;
      widened = widening && Number.isFinite(span);
      if (widened) {
        span *= 2;
        fetchSpans.set(credentialKey, span);
      }
    }
    fetchSpans.delete(credentialKey);
  }, refreshLock.withPermit);

  const startRefresh = (
    credential: CursorCredentialSource,
    credentialKey: string,
    retentionStartMs: number,
  ) =>
    // Enroll and fork atomically so interruption cannot strand a registered refresh.
    Effect.uninterruptible(
      Effect.gen(function* () {
        const current = refreshes.get(credentialKey);
        if (current !== undefined) return current;
        const done = Deferred.makeUnsafe<void>();
        refreshes.set(credentialKey, done);
        // Detached: a departing client must not cancel a fetch later reads reuse.
        yield* refreshAccount(credential, credentialKey, retentionStartMs).pipe(
          Effect.catchCause(() =>
            Clock.currentTimeMillis.pipe(
              Effect.map((atMs) =>
                failures.set(credentialKey, { atMs, error: CURSOR_ACCOUNT_READ_ERROR }),
              ),
            ),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              refreshes.delete(credentialKey);
              return Deferred.succeed(done, undefined);
            }),
          ),
          Effect.forkDetach,
        );
        return done;
      }),
    );

  const accountSource = Effect.fn("CursorUsageAccounts.accountSource")(function* (
    credential: CursorCredentialSource,
    windowStartMs: number,
    retentionStartMs: number,
    awaitRefresh: boolean,
  ) {
    yield* ensureLoaded;
    const credentialKey = `api-key:${Hex.encode(yield* digest.digest(Digest.sha256, new TextEncoder().encode(credential.apiKey)))}`;
    const nowMs = yield* Clock.currentTimeMillis;
    const recentFailure = failures.get(credentialKey);
    const staleCache = caches.get(credentialKey);
    // Stale cached history still answers a plain read so the usage page never waits on a slow
    // account read; only reads that ask for a refresh block on one, and a first-ever read shows
    // a refreshing source while its cache is being built.
    const needsRefresh =
      (recentFailure === undefined || nowMs - recentFailure.atMs >= CURSOR_ACCOUNT_TTL_MS) &&
      !isCursorCacheFresh(caches.get(credentialKey), nowMs, retentionStartMs);
    let refreshing = false;
    if (needsRefresh && (staleCache === undefined || awaitRefresh)) {
      const refresh = yield* startRefresh(credential, credentialKey, retentionStartMs);
      if (awaitRefresh) {
        yield* Deferred.await(refresh);
        if (
          !failures.has(credentialKey) &&
          !isCursorCacheFresh(caches.get(credentialKey), nowMs, retentionStartMs)
        ) {
          const retry = yield* startRefresh(credential, credentialKey, retentionStartMs);
          yield* Deferred.await(retry);
        }
      } else refreshing = true;
    } else if (needsRefresh && staleCache !== undefined) {
      // A plain read with a stale cache still warms the cache in the background.
      yield* startRefresh(credential, credentialKey, retentionStartMs);
    }

    const cache = caches.get(credentialKey);
    const failure = refreshing ? undefined : failures.get(credentialKey);
    const failureMessage = failure === undefined ? undefined : failure.error;
    if (failureMessage === null) return null;
    if (cache === undefined) {
      return {
        dir: "cursor-account",
        ...(refreshing
          ? { files: [], refreshing: true }
          : { files: null, message: failureMessage ?? CURSOR_ACCOUNT_READ_ERROR }),
      } satisfies ProviderUsageScan;
    }
    // Account history spans machines; a stable fingerprint prevents duplicate environment counts.
    const source = `cursor-account:${cache.accountKey}`;
    return {
      dir: source,
      hostId: "cursor.com",
      volumeId: cache.accountKey,
      files: [
        {
          path: source,
          records: cache.records.filter((record) => record.timestampMs >= windowStartMs),
        },
      ],
      ...(failureMessage === undefined
        ? { status: "ok" }
        : { status: "partial", message: failureMessage }),
      ...(refreshing ? { refreshing: true } : {}),
    } satisfies ProviderUsageScan;
  });

  const scan: CursorUsageAccounts["Service"]["scan"] = Effect.fn("CursorUsageAccounts.scan")(
    function* ({ instances, windowStartMs, retentionCutoffMs, awaitRefresh }) {
      const apiKeys = yield* Effect.forEach(instances, ({ instanceId, environment }) =>
        environment.CURSOR_API_KEY?.trim()
          ? Effect.succeed(environment.CURSOR_API_KEY.trim())
          : readStoredCursorApiKey(instanceId).pipe(
              Effect.provideService(ProviderHost.ProviderHost, host),
              Effect.orElseSucceed(() => undefined),
            ),
      );
      const uniqueApiKeys = [...new Set(apiKeys.filter((apiKey) => apiKey !== undefined))];
      if (uniqueApiKeys.length > 0) {
        const sources: ReadonlyArray<ProviderUsageScan | null> = yield* Effect.forEach(
          uniqueApiKeys,
          (apiKey) =>
            accountSource(
              { kind: "apiKey", apiKey },
              windowStartMs,
              retentionCutoffMs,
              awaitRefresh,
            ),
          { concurrency: 2 },
        );
        // Keys for one account share its source, and a repeated source would count sessions twice.
        // A failed key can hold older records, so a current read wins, then a refresh the client
        // must follow up on.
        const rank = (source: ProviderUsageScan) =>
          source.status === "ok" ? 2 : source.refreshing ? 1 : 0;
        const byAccount = new Map<string, ProviderUsageScan>();
        for (const source of sources) {
          if (source === null) continue;
          const kept = byAccount.get(source.dir);
          if (kept === undefined || rank(source) > rank(kept)) {
            byAccount.set(source.dir, source);
          }
        }
        return [...byAccount.values()];
      }
      return [];
    },
  );

  return CursorUsageAccounts.of({ scan, awaitPersisted });
});

export const layer = Layer.effect(CursorUsageAccounts, make);
