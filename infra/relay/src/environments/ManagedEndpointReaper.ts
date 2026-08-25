import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as RelayConfiguration from "../Config.ts";
import { managedEndpointTunnelNamePrefix } from "../deploymentConfig.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";

export const MANAGED_ENDPOINT_GRACE_PERIOD_MINUTES = 5;
export const MANAGED_ENDPOINT_SWEEP_PAGE_SIZE = 100;
export const MANAGED_ENDPOINT_SWEEP_DELETE_LIMIT = 100;

export interface ManagedEndpointSweepResult {
  readonly scanned: number;
  readonly deleted: number;
  readonly skippedLegacy: number;
  readonly failed: number;
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
      Effect.catchTag("ManagedEndpointTunnelClientError", (error) =>
        ManagedEndpointProvider.isManagedEndpointNotFound(error.cause)
          ? Effect.succeed(Option.none())
          : Effect.fail(error),
      ),
    );
    if (Option.isNone(current)) {
      return true;
    }
    if (!isExpiredManagedTunnel({ ...input, tunnel: current.value })) {
      return false;
    }
    if ((yield* allocations.listByTunnelNames([input.tunnel.name])).length > 0) {
      return false;
    }
    return yield* tunnels.delete(input.tunnel.id).pipe(
      Effect.as(true),
      Effect.catchTag("ManagedEndpointTunnelClientError", (error) =>
        ManagedEndpointProvider.isManagedEndpointNotFound(error.cause)
          ? Effect.succeed(true)
          : Effect.fail(error),
      ),
    );
  });

  const sweep = Effect.gen(function* () {
    const namespace = config.managedEndpointNamespace;
    if (!namespace) {
      return { scanned: 0, deleted: 0, skippedLegacy: 0, failed: 0 };
    }

    const now = yield* DateTime.now;
    const cutoff = DateTime.subtract(now, { minutes: MANAGED_ENDPOINT_GRACE_PERIOD_MINUTES });
    const cutoffIso = DateTime.formatIso(cutoff);
    const prefix = managedEndpointTunnelNamePrefix(namespace);
    let deleted = 0;
    let skippedLegacy = 0;
    let failed = 0;
    const expired: Array<{
      readonly tunnel: ManagedEndpointProvider.ManagedEndpointTunnel & {
        readonly id: string;
        readonly name: string;
      };
      readonly status: "down" | "inactive";
    }> = [];

    for (const status of ["down", "inactive"] as const) {
      let page = 1;
      while (true) {
        const response = yield* tunnels.list({
          isDeleted: false,
          includePrefix: prefix,
          status,
          existedAt: cutoffIso,
          ...(status === "down" ? { wasInactiveAt: cutoffIso } : {}),
          page,
          perPage: MANAGED_ENDPOINT_SWEEP_PAGE_SIZE,
        });
        expired.push(
          ...response.result
            .map((tunnel) => ({ tunnel, status, prefix, cutoff }))
            .filter(isExpiredManagedTunnel)
            .map(({ tunnel }) => ({ tunnel, status })),
        );

        const totalCount = response.resultInfo?.totalCount;
        if (
          response.result.length === 0 ||
          (typeof totalCount === "number"
            ? page * MANAGED_ENDPOINT_SWEEP_PAGE_SIZE >= totalCount
            : response.result.length < MANAGED_ENDPOINT_SWEEP_PAGE_SIZE)
        ) {
          break;
        }
        page += 1;
      }
    }

    const recorded = yield* allocations.listByTunnelNames(expired.map(({ tunnel }) => tunnel.name));
    const recordedByTunnelName = new Map(
      recorded.map((allocation) => [allocation.tunnelName, allocation]),
    );

    for (const { tunnel, status } of expired) {
      if (deleted >= MANAGED_ENDPOINT_SWEEP_DELETE_LIMIT) {
        break;
      }
      const allocation = recordedByTunnelName.get(tunnel.name);
      if (allocation !== undefined && allocation.tunnelId !== tunnel.id) {
        continue;
      }
      if (allocation !== undefined && !allocation.recoveryEnabled) {
        skippedLegacy += 1;
        continue;
      }

      const result =
        allocation === undefined
          ? yield* deleteOrphan({ tunnel, status, prefix, cutoff }).pipe(Effect.result)
          : yield* provider
              .release({
                userId: allocation.userId,
                environmentId: allocation.environmentId,
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
      } else if (result.success) {
        deleted += 1;
        yield* Effect.logInfo("Deleted an inactive managed tunnel", {
          tunnelId: tunnel.id,
          tunnelName: tunnel.name,
          status,
        });
      }
    }

    return { scanned: expired.length, deleted, skippedLegacy, failed };
  }).pipe(Effect.withSpan("relay.managed_endpoint_reaper.sweep"));

  return ManagedEndpointReaper.of({ sweep });
});

export const layer = Layer.effect(ManagedEndpointReaper, make);
