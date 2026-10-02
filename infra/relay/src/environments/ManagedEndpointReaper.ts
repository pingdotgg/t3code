import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { ManagedEndpointCleanupMode } from "../Config.ts";
import * as RelayConfiguration from "../Config.ts";
import {
  MANAGED_ENDPOINT_ZONE_OWNER_STAGE,
  managedEndpointTunnelNamePrefix,
} from "../deploymentConfig.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";

export const MANAGED_ENDPOINT_GRACE_PERIOD_MINUTES = 5;
// A tunnel that never connected is usually a link still being set up: a slow
// cloudflared download or a user who walked away mid-pairing. Give it an hour.
export const MANAGED_ENDPOINT_INACTIVE_GRACE_PERIOD_MINUTES = 60;
export const MANAGED_ENDPOINT_SWEEP_PAGE_SIZE = 100;
export const MANAGED_ENDPOINT_SWEEP_ATTEMPT_LIMIT = 100;
export const MANAGED_ENDPOINT_SWEEP_LIST_REQUEST_LIMIT = 10;
// Age buckets for legacy candidates, in days since the tunnel went down (or
// was created, for one that never connected).
export const MANAGED_ENDPOINT_LEGACY_AGE_BUCKET_DAYS = [7, 30, 90] as const;
// A host that never registered recovery cannot replace a deleted tunnel on
// its own build. Only delete its tunnel after it has been gone this long:
// a returning host has almost certainly updated by then, and the update
// recovers the tunnel at the same hostname.
export const MANAGED_ENDPOINT_LEGACY_GRACE_PERIOD_DAYS = 30;
// Deletions run a few at a time: each one is a row-locked database
// transaction plus two Cloudflare calls, so one at a time cannot finish a
// full attempt budget inside the cron's timeout. Each holds a Hyperdrive
// connection while it runs; keep this well under the 20-connection origin
// limit that request handlers share.
export const MANAGED_ENDPOINT_SWEEP_DELETE_CONCURRENCY = 4;
// Stop starting deletions this long after the sweep starts, leaving room under
// the cron's two-minute timeout to finish in-flight ones and record the
// counters. Counted from sweep start so slow listing eats into it.
export const MANAGED_ENDPOINT_SWEEP_DELETE_BUDGET_MS = 90_000;

export interface ManagedEndpointSweepResult {
  readonly mode: ManagedEndpointCleanupMode;
  readonly legacyMode: ManagedEndpointCleanupMode;
  readonly listRequests: number;
  readonly scanned: number;
  readonly attempted: number;
  readonly deleted: number;
  readonly wouldDelete: number;
  /** Legacy tunnels past the legacy grace period, and how many were deleted. */
  readonly wouldDeleteLegacy: number;
  readonly deletedLegacy: number;
  readonly skippedLegacy: number;
  /** Legacy candidates, by days since they went down: over 7, 30, and 90. */
  readonly legacyOver7Days: number;
  readonly legacyOver30Days: number;
  readonly legacyOver90Days: number;
  readonly skippedOrphan: number;
  /** The allocation row records a different tunnel under this name. */
  readonly skippedReplaced: number;
  /** The allocation row has not recorded a tunnel yet. */
  readonly skippedUnrecorded: number;
  /** Cloudflare's count of matching tunnels, before page limits. */
  readonly totalDown: number | null;
  readonly totalInactive: number | null;
  readonly failed: number;
  readonly truncated: boolean;
}

export class ManagedEndpointReaper extends Context.Service<
  ManagedEndpointReaper,
  {
    readonly sweep: Effect.Effect<
      ManagedEndpointSweepResult,
      | ManagedEndpointProvider.ManagedEndpointTunnelClientError
      | ManagedEndpointAllocations.ManagedEndpointAllocationPersistenceError
    >;
  }
>()("t3code-relay/environments/ManagedEndpointReaper") {}

function isExpiredManagedTunnel(input: {
  readonly tunnel: ManagedEndpointProvider.ManagedEndpointTunnel;
  readonly status: "down" | "inactive";
  readonly prefix: string;
  readonly cutoff: DateTime.Utc;
}): input is typeof input & {
  readonly tunnel: ManagedEndpointProvider.ManagedEndpointTunnel & {
    readonly id: string;
    readonly name: string;
  };
} {
  const { tunnel, status, prefix, cutoff } = input;
  if (
    typeof tunnel.id !== "string" ||
    typeof tunnel.name !== "string" ||
    tunnel.status !== status ||
    !tunnel.name.startsWith(prefix) ||
    !/^[a-f0-9]{16}$/u.test(tunnel.name.slice(prefix.length))
  ) {
    return false;
  }
  const inactiveAt = status === "down" ? tunnel.connsInactiveAt : tunnel.createdAt;
  if (typeof inactiveAt !== "string") {
    return false;
  }
  const timestamp = DateTime.make(inactiveAt);
  return Option.isSome(timestamp) && timestamp.value.epochMilliseconds <= cutoff.epochMilliseconds;
}

/** Days (fractional) since the tunnel went down, or was created if it never connected. */
function inactiveDaysAt(
  tunnel: ManagedEndpointProvider.ManagedEndpointTunnel,
  status: "down" | "inactive",
  now: DateTime.Utc,
): number | null {
  const since = status === "down" ? tunnel.connsInactiveAt : tunnel.createdAt;
  if (typeof since !== "string") return null;
  const timestamp = DateTime.make(since);
  if (Option.isNone(timestamp)) return null;
  return (now.epochMilliseconds - timestamp.value.epochMilliseconds) / 86_400_000;
}

function isRateLimited(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  if ("_tag" in cause && cause._tag === "TooManyRequests") {
    return true;
  }
  if ("status" in cause && cause.status === 429) {
    return true;
  }
  return "cause" in cause && isRateLimited(cause.cause);
}

function rotatedPages(input: {
  readonly totalCount: number | undefined;
  readonly slot: number;
  readonly limit: number;
}): ReadonlyArray<number> {
  if (input.limit <= 0) return [];
  if (input.totalCount === undefined) {
    return Array.from({ length: input.limit }, (_, index) => index + 2);
  }
  const laterPageCount = Math.max(
    0,
    Math.ceil(input.totalCount / MANAGED_ENDPOINT_SWEEP_PAGE_SIZE) - 1,
  );
  if (laterPageCount === 0) return [];
  const count = Math.min(input.limit, laterPageCount);
  const start = input.slot % laterPageCount;
  return Array.from({ length: count }, (_, index) => 2 + ((start + index) % laterPageCount));
}

const emptyResult = (
  mode: ManagedEndpointCleanupMode,
  legacyMode: ManagedEndpointCleanupMode,
): ManagedEndpointSweepResult => ({
  mode,
  legacyMode,
  listRequests: 0,
  scanned: 0,
  attempted: 0,
  deleted: 0,
  wouldDelete: 0,
  wouldDeleteLegacy: 0,
  deletedLegacy: 0,
  skippedLegacy: 0,
  legacyOver7Days: 0,
  legacyOver30Days: 0,
  legacyOver90Days: 0,
  skippedOrphan: 0,
  skippedReplaced: 0,
  skippedUnrecorded: 0,
  totalDown: null,
  totalInactive: null,
  failed: 0,
  truncated: false,
});

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const tunnels = yield* ManagedEndpointProvider.ManagedEndpointTunnelClient;
  const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
  const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;

  const sweep = Effect.gen(function* () {
    const mode = config.managedEndpointCleanupMode ?? "off";
    const legacyMode = config.legacyManagedEndpointCleanupMode ?? "off";
    const namespace = config.managedEndpointNamespace;
    if ((mode === "off" && legacyMode === "off") || !namespace) {
      return emptyResult(mode, legacyMode);
    }
    const sweepStartedAtMillis = yield* Clock.currentTimeMillis;
    // The override exists for the disposable canary stage; prod always
    // waits the full grace period.
    const legacyGraceMinutes =
      namespace !== MANAGED_ENDPOINT_ZONE_OWNER_STAGE &&
      config.legacyTunnelGraceMinutes !== undefined
        ? config.legacyTunnelGraceMinutes
        : MANAGED_ENDPOINT_LEGACY_GRACE_PERIOD_DAYS * 24 * 60;
    const legacyCutoff = DateTime.subtract(yield* DateTime.now, { minutes: legacyGraceMinutes });

    const now = yield* DateTime.now;
    const cutoffFor = (status: "down" | "inactive") =>
      DateTime.subtract(now, {
        minutes:
          status === "down"
            ? MANAGED_ENDPOINT_GRACE_PERIOD_MINUTES
            : MANAGED_ENDPOINT_INACTIVE_GRACE_PERIOD_MINUTES,
      });
    const prefix = managedEndpointTunnelNamePrefix(namespace);
    const slot = Math.floor(
      now.epochMilliseconds / (MANAGED_ENDPOINT_GRACE_PERIOD_MINUTES * 60 * 1_000),
    );
    let listRequests = 0;
    let truncated = false;
    const totals: Record<"down" | "inactive", number | null> = { down: null, inactive: null };
    const expired: Array<{
      readonly tunnel: ManagedEndpointProvider.ManagedEndpointTunnel & {
        readonly id: string;
        readonly name: string;
      };
      readonly status: "down" | "inactive";
      readonly cutoff: DateTime.Utc;
    }> = [];

    for (const status of ["down", "inactive"] as const) {
      const cutoff = cutoffFor(status);
      const cutoffIso = DateTime.formatIso(cutoff);
      const listPage = (page: number) => {
        listRequests += 1;
        return tunnels.list({
          isDeleted: false,
          includePrefix: prefix,
          status,
          existedAt: cutoffIso,
          ...(status === "down" ? { wasInactiveAt: cutoffIso } : {}),
          page,
          perPage: MANAGED_ENDPOINT_SWEEP_PAGE_SIZE,
        });
      };
      const first = yield* listPage(1);
      const totalCount =
        typeof first.resultInfo?.totalCount === "number" ? first.resultInfo.totalCount : undefined;
      totals[status] = totalCount ?? null;
      const pages = rotatedPages({
        totalCount,
        slot,
        limit: Math.floor(MANAGED_ENDPOINT_SWEEP_LIST_REQUEST_LIMIT / 2) - 1,
      });
      const responses = [first, ...(yield* Effect.forEach(pages, listPage, { concurrency: 1 }))];
      if (
        totalCount !== undefined &&
        Math.ceil(totalCount / MANAGED_ENDPOINT_SWEEP_PAGE_SIZE) > responses.length
      ) {
        truncated = true;
      } else if (
        totalCount === undefined &&
        responses.at(-1)?.result.length === MANAGED_ENDPOINT_SWEEP_PAGE_SIZE
      ) {
        truncated = true;
      }
      for (const response of responses) {
        expired.push(
          ...response.result
            .map((tunnel) => ({ tunnel, status, prefix, cutoff }))
            .filter(isExpiredManagedTunnel)
            .map(({ tunnel }) => ({ tunnel, status, cutoff })),
        );
      }
    }

    const collected = [...new Map(expired.map((entry) => [entry.tunnel.id, entry])).values()];
    // Start each sweep one attempt budget further along so a run of
    // candidates whose deletes keep failing cannot hold the budget forever
    // and starve everything listed after them.
    const offset =
      collected.length === 0 ? 0 : (slot * MANAGED_ENDPOINT_SWEEP_ATTEMPT_LIMIT) % collected.length;
    const uniqueExpired = [...collected.slice(offset), ...collected.slice(0, offset)];
    const recorded = yield* allocations.listByTunnelNames(
      uniqueExpired.map(({ tunnel }) => tunnel.name),
    );
    const recordedByTunnelName = new Map(
      recorded.map((allocation) => [allocation.tunnelName, allocation]),
    );
    let attempted = 0;
    let deleted = 0;
    let wouldDelete = 0;
    const candidates: Array<{
      readonly owner: ManagedEndpointAllocations.ManagedEndpointTunnelAllocation;
      readonly tunnel: ManagedEndpointProvider.ManagedEndpointTunnel & {
        readonly id: string;
        readonly name: string;
      };
      readonly status: "down" | "inactive";
      readonly legacy: boolean;
      readonly inactiveBefore: string;
    }> = [];
    let wouldDeleteLegacy = 0;
    let deletedLegacy = 0;
    let skippedLegacy = 0;
    const legacyOverDays = new Map<number, number>(
      MANAGED_ENDPOINT_LEGACY_AGE_BUCKET_DAYS.map((days) => [days, 0]),
    );
    let skippedOrphan = 0;
    let skippedReplaced = 0;
    let skippedUnrecorded = 0;
    let failed = 0;

    for (const { tunnel, status, cutoff } of uniqueExpired) {
      const allocation = recordedByTunnelName.get(tunnel.name);
      if (
        allocation !== undefined &&
        allocation.tunnelId !== null &&
        allocation.tunnelId !== tunnel.id
      ) {
        skippedReplaced += 1;
        continue;
      }
      const owner = allocation?.tunnelId === tunnel.id ? allocation : undefined;
      if (allocation !== undefined && owner === undefined) {
        skippedUnrecorded += 1;
        continue;
      }
      // A tunnel with no allocation row cannot be claimed, so a relink that
      // adopts it by name races any delete here. Count it and leave it for a
      // manual sweep instead.
      if (owner === undefined) {
        skippedOrphan += 1;
        continue;
      }
      const legacy = !owner.recoveryEnabled;
      if (legacy) {
        skippedLegacy += 1;
        const inactiveDays = inactiveDaysAt(tunnel, status, now);
        for (const days of MANAGED_ENDPOINT_LEGACY_AGE_BUCKET_DAYS) {
          if (inactiveDays !== null && inactiveDays > days) {
            legacyOverDays.set(days, (legacyOverDays.get(days) ?? 0) + 1);
          }
        }
        if (
          legacyMode === "off" ||
          !isExpiredManagedTunnel({ tunnel, status, prefix, cutoff: legacyCutoff })
        ) {
          continue;
        }
        wouldDeleteLegacy += 1;
        if (legacyMode === "dry-run") continue;
      } else {
        if (mode === "off") continue;
        wouldDelete += 1;
        if (mode === "dry-run") continue;
      }
      if (candidates.length >= MANAGED_ENDPOINT_SWEEP_ATTEMPT_LIMIT) {
        truncated = true;
        break;
      }
      candidates.push({
        owner,
        tunnel,
        status,
        legacy,
        // The release re-reads the tunnel and deletes only if it is still in
        // this status and inactive since before this cutoff.
        inactiveBefore: DateTime.formatIso(legacy ? legacyCutoff : cutoff),
      });
    }

    const deleteDeadline = sweepStartedAtMillis + MANAGED_ENDPOINT_SWEEP_DELETE_BUDGET_MS;
    let stopDeleting = false;
    yield* Effect.forEach(
      candidates,
      (candidate) =>
        Effect.gen(function* () {
          if (stopDeleting || (yield* Clock.currentTimeMillis) >= deleteDeadline) {
            stopDeleting = true;
            truncated = true;
            return;
          }
          attempted += 1;
          const result = yield* provider
            .release({
              userId: candidate.owner.userId,
              environmentId: candidate.owner.environmentId,
              expectedTunnelId: candidate.tunnel.id,
              expectedInactiveBefore: candidate.inactiveBefore,
              expectedStatus: candidate.status,
              // Only a legacy host needs an update to recover; tell its user so.
              ...(candidate.legacy ? { markReleased: true } : {}),
            })
            .pipe(Effect.result);
          if (result._tag === "Failure") {
            failed += 1;
            yield* Effect.logWarning("Failed to delete an inactive managed tunnel", {
              tunnelId: candidate.tunnel.id,
              tunnelName: candidate.tunnel.name,
              legacy: candidate.legacy,
              cause: result.failure,
            });
            if (isRateLimited(result.failure)) {
              stopDeleting = true;
              truncated = true;
            }
          } else if (result.success) {
            deleted += 1;
            if (candidate.legacy) deletedLegacy += 1;
            yield* Effect.logInfo("Deleted an inactive managed tunnel", {
              tunnelId: candidate.tunnel.id,
              tunnelName: candidate.tunnel.name,
              status: candidate.status,
              legacy: candidate.legacy,
            });
          }
        }),
      { concurrency: MANAGED_ENDPOINT_SWEEP_DELETE_CONCURRENCY, discard: true },
    );

    return {
      mode,
      legacyMode,
      listRequests,
      scanned: uniqueExpired.length,
      attempted,
      deleted,
      wouldDelete,
      wouldDeleteLegacy,
      deletedLegacy,
      skippedLegacy,
      legacyOver7Days: legacyOverDays.get(7) ?? 0,
      legacyOver30Days: legacyOverDays.get(30) ?? 0,
      legacyOver90Days: legacyOverDays.get(90) ?? 0,
      skippedOrphan,
      skippedReplaced,
      skippedUnrecorded,
      totalDown: totals.down,
      totalInactive: totals.inactive,
      failed,
      truncated,
    };
  }).pipe(
    // Dry-run rollout reads these counters from the exported span.
    Effect.tap((result) =>
      Effect.annotateCurrentSpan(
        Object.fromEntries(
          Object.entries(result).map(([key, value]) => [
            `relay.managed_endpoint_reaper.${key}`,
            value,
          ]),
        ),
      ),
    ),
    Effect.withSpan("relay.managed_endpoint_reaper.sweep"),
  );

  return ManagedEndpointReaper.of({ sweep });
});

export const layer = Layer.effect(ManagedEndpointReaper, make);
