import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { ManagedEndpointCleanupMode } from "../Config.ts";
import * as RelayConfiguration from "../Config.ts";
import { managedEndpointTunnelNamePrefix } from "../deploymentConfig.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";

export const MANAGED_ENDPOINT_GRACE_PERIOD_MINUTES = 5;
// A tunnel that never connected is usually a link still being set up: a slow
// cloudflared download or a user who walked away mid-pairing. Give it an hour.
export const MANAGED_ENDPOINT_INACTIVE_GRACE_PERIOD_MINUTES = 60;
export const MANAGED_ENDPOINT_SWEEP_PAGE_SIZE = 100;
export const MANAGED_ENDPOINT_SWEEP_ATTEMPT_LIMIT = 100;
export const MANAGED_ENDPOINT_SWEEP_LIST_REQUEST_LIMIT = 10;

export interface ManagedEndpointSweepResult {
  readonly mode: ManagedEndpointCleanupMode;
  readonly listRequests: number;
  readonly scanned: number;
  readonly attempted: number;
  readonly deleted: number;
  readonly wouldDelete: number;
  readonly skippedLegacy: number;
  readonly skippedOrphan: number;
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

const emptyResult = (mode: ManagedEndpointCleanupMode): ManagedEndpointSweepResult => ({
  mode,
  listRequests: 0,
  scanned: 0,
  attempted: 0,
  deleted: 0,
  wouldDelete: 0,
  skippedLegacy: 0,
  skippedOrphan: 0,
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
    const namespace = config.managedEndpointNamespace;
    if (mode === "off" || !namespace) return emptyResult(mode);

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
    let skippedLegacy = 0;
    let skippedOrphan = 0;
    let failed = 0;

    for (const { tunnel, status, cutoff } of uniqueExpired) {
      const cutoffIso = DateTime.formatIso(cutoff);
      const allocation = recordedByTunnelName.get(tunnel.name);
      if (
        allocation !== undefined &&
        allocation.tunnelId !== null &&
        allocation.tunnelId !== tunnel.id
      ) {
        continue;
      }
      const owner = allocation?.tunnelId === tunnel.id ? allocation : undefined;
      if (owner !== undefined && !owner.recoveryEnabled) {
        skippedLegacy += 1;
        continue;
      }
      if (allocation !== undefined && owner === undefined) continue;
      // A tunnel with no allocation row cannot be claimed, so a relink that
      // adopts it by name races any delete here. Count it and leave it for a
      // manual sweep instead.
      if (owner === undefined) {
        skippedOrphan += 1;
        continue;
      }
      wouldDelete += 1;
      if (mode === "dry-run") continue;
      if (attempted >= MANAGED_ENDPOINT_SWEEP_ATTEMPT_LIMIT) {
        truncated = true;
        break;
      }
      attempted += 1;
      const result = yield* provider
        .release({
          userId: owner.userId,
          environmentId: owner.environmentId,
          expectedTunnelId: tunnel.id,
          expectedInactiveBefore: cutoffIso,
          expectedStatus: status,
        })
        .pipe(Effect.result);
      if (result._tag === "Failure") {
        failed += 1;
        yield* Effect.logWarning("Failed to delete an inactive managed tunnel", {
          tunnelId: tunnel.id,
          tunnelName: tunnel.name,
          cause: result.failure,
        });
        if (isRateLimited(result.failure)) {
          truncated = true;
          break;
        }
      } else if (result.success) {
        deleted += 1;
        yield* Effect.logInfo("Deleted an inactive managed tunnel", {
          tunnelId: tunnel.id,
          tunnelName: tunnel.name,
          status,
        });
      }
    }

    return {
      mode,
      listRequests,
      scanned: uniqueExpired.length,
      attempted,
      deleted,
      wouldDelete,
      skippedLegacy,
      skippedOrphan,
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
