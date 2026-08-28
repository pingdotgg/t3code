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
  failed: 0,
  truncated: false,
});

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const tunnels = yield* ManagedEndpointProvider.ManagedEndpointTunnelClient;
  const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
  const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;

  const deleteOrphan = Effect.fn("relay.managed_endpoint_reaper.delete_orphan")(function* (input: {
    readonly tunnel: ManagedEndpointProvider.ManagedEndpointTunnel & {
      readonly id: string;
      readonly name: string;
    };
    readonly status: "down" | "inactive";
    readonly prefix: string;
    readonly cutoff: DateTime.Utc;
  }) {
    const current = yield* tunnels.get(input.tunnel.id).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        ManagedEndpointTunnelClientError: (error) =>
          ManagedEndpointProvider.isManagedEndpointNotFound(error.cause)
            ? Effect.succeed(Option.none())
            : Effect.fail(error),
      }),
    );
    if (Option.isNone(current)) return true;
    if (!isExpiredManagedTunnel({ ...input, tunnel: current.value })) return false;
    if ((yield* allocations.listByTunnelNames([input.tunnel.name])).length > 0) return false;
    return yield* tunnels.delete(input.tunnel.id).pipe(
      Effect.as(true),
      Effect.catchTags({
        ManagedEndpointTunnelClientError: (error) =>
          ManagedEndpointProvider.isManagedEndpointNotFound(error.cause)
            ? Effect.succeed(true)
            : Effect.fail(error),
      }),
    );
  });

  const sweep = Effect.gen(function* () {
    const mode = config.managedEndpointCleanupMode ?? "off";
    const namespace = config.managedEndpointNamespace;
    if (mode === "off" || !namespace) return emptyResult(mode);

    const now = yield* DateTime.now;
    const cutoff = DateTime.subtract(now, { minutes: MANAGED_ENDPOINT_GRACE_PERIOD_MINUTES });
    const cutoffIso = DateTime.formatIso(cutoff);
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
    }> = [];

    const statuses =
      slot % 2 === 0 ? (["down", "inactive"] as const) : (["inactive", "down"] as const);
    for (const status of statuses) {
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
            .map(({ tunnel }) => ({ tunnel, status })),
        );
      }
    }

    const uniqueExpired = [...new Map(expired.map((entry) => [entry.tunnel.id, entry])).values()];
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
    let failed = 0;

    for (const { tunnel, status } of uniqueExpired) {
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
      wouldDelete += 1;
      if (mode === "dry-run") continue;
      if (attempted >= MANAGED_ENDPOINT_SWEEP_ATTEMPT_LIMIT) {
        truncated = true;
        break;
      }
      attempted += 1;
      const result =
        owner === undefined
          ? yield* deleteOrphan({ tunnel, status, prefix, cutoff }).pipe(Effect.result)
          : yield* provider
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
      failed,
      truncated,
    };
  }).pipe(Effect.withSpan("relay.managed_endpoint_reaper.sweep"));

  return ManagedEndpointReaper.of({ sweep });
});

export const layer = Layer.effect(ManagedEndpointReaper, make);
