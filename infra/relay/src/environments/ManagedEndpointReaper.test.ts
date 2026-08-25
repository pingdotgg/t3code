import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import * as RelayConfiguration from "../Config.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import * as ManagedEndpointReaper from "./ManagedEndpointReaper.ts";

const NOW = "2026-08-25T12:00:00.000Z";
const NOW_MILLIS = DateTime.makeUnsafe(NOW).epochMilliseconds;
const PREFIX = "t3coderelay-managedendpoint-prod-";

function tunnel(input: {
  readonly id: string;
  readonly suffix: string;
  readonly status: "down" | "inactive" | "healthy" | "degraded";
  readonly timestamp?: string | null;
  readonly prefix?: string;
}): ManagedEndpointProvider.ManagedEndpointTunnel {
  return {
    id: input.id,
    name: `${input.prefix ?? PREFIX}${input.suffix}`,
    status: input.status,
    ...(input.timestamp === undefined
      ? {}
      : input.status === "inactive"
        ? { createdAt: input.timestamp }
        : { connsInactiveAt: input.timestamp }),
  };
}

function allocation(input: {
  readonly tunnelId: string;
  readonly recoveryEnabled: boolean;
}): ManagedEndpointAllocations.ManagedEndpointTunnelAllocation {
  return {
    userId: "user-1",
    environmentId: `environment-${input.tunnelId}`,
    hostname: `${input.tunnelId}.example.test`,
    tunnelId: input.tunnelId,
    tunnelName: `${PREFIX}aaaaaaaaaaaaaaaa`,
    dnsRecordId: "dns-1",
    readyAt: "2026-08-25T11:00:00.000Z",
    updatedAt: "2026-08-25T11:00:00.000Z",
    recoveryEnabled: input.recoveryEnabled,
  };
}

function harness(input?: {
  readonly tunnels?: ReadonlyArray<ManagedEndpointProvider.ManagedEndpointTunnel>;
  readonly allocations?: ReadonlyArray<ManagedEndpointAllocations.ManagedEndpointTunnelAllocation>;
  readonly namespace?: string;
  readonly failTunnelId?: string;
  readonly missingOnDeleteTunnelId?: string;
  readonly missingOnGetTunnelId?: string;
  readonly reserveOnGetTunnelId?: string;
  readonly refreshedTunnels?: ReadonlyMap<string, ManagedEndpointProvider.ManagedEndpointTunnel>;
  readonly skipTunnelId?: string;
}) {
  const listRequests: ManagedEndpointProvider.ManagedEndpointTunnelListRequest[] = [];
  const deleted: string[] = [];
  const releases: Array<
    Parameters<ManagedEndpointProvider.ManagedEndpointProvider["Service"]["release"]>[0]
  > = [];
  const remaining = [...(input?.tunnels ?? [])];
  const recorded = (input?.allocations ?? []).map((entry) => {
    const matching = remaining.find((candidate) => candidate.id === entry.tunnelId);
    return typeof matching?.name === "string" ? { ...entry, tunnelName: matching.name } : entry;
  });
  const tunnelClient = ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
    get: (tunnelId) =>
      Effect.suspend(() => {
        if (tunnelId === input?.missingOnGetTunnelId) {
          return Effect.fail(
            new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
              operation: "get",
              tunnelId,
              cause: { _tag: "NotFound" },
            }),
          );
        }
        const found =
          input?.refreshedTunnels?.get(tunnelId) ??
          remaining.find((candidate) => candidate.id === tunnelId);
        if (found === undefined) {
          return Effect.fail(
            new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
              operation: "get",
              tunnelId,
              cause: { _tag: "NotFound" },
            }),
          );
        }
        if (tunnelId === input?.reserveOnGetTunnelId && typeof found.name === "string") {
          recorded.push({
            ...allocation({ tunnelId, recoveryEnabled: false }),
            tunnelName: found.name,
          });
        }
        return Effect.succeed(found);
      }),
    list: (request) =>
      Effect.sync(() => {
        listRequests.push(request);
        const matching = remaining.filter((entry) => entry.status === request.status);
        const start = ((request.page ?? 1) - 1) * (request.perPage ?? 100);
        return {
          result: matching.slice(start, start + (request.perPage ?? 100)),
          resultInfo: {
            page: request.page ?? 1,
            perPage: request.perPage ?? 100,
            totalCount: matching.length,
          },
        };
      }),
    create: () => Effect.die("unused"),
    putConfiguration: () => Effect.die("unused"),
    getToken: () => Effect.die("unused"),
    delete: (tunnelId) =>
      tunnelId === input?.failTunnelId || tunnelId === input?.missingOnDeleteTunnelId
        ? Effect.fail(
            new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
              operation: "delete",
              tunnelId,
              cause:
                tunnelId === input?.missingOnDeleteTunnelId
                  ? { _tag: "NotFound" }
                  : "Cloudflare refused the deletion",
            }),
          )
        : Effect.sync(() => {
            deleted.push(tunnelId);
            const index = remaining.findIndex((candidate) => candidate.id === tunnelId);
            if (index !== -1) {
              remaining.splice(index, 1);
            }
          }),
  });
  const allocationService = ManagedEndpointAllocations.ManagedEndpointAllocations.of({
    get: () => Effect.die("unused"),
    reserve: () => Effect.die("unused"),
    recordTunnel: () => Effect.die("unused"),
    recordDns: () => Effect.die("unused"),
    markReady: () => Effect.die("unused"),
    enableRecovery: () => Effect.die("unused"),
    listByTunnelNames: (tunnelNames) =>
      Effect.succeed(recorded.filter((entry) => tunnelNames.includes(entry.tunnelName))),
    claimRelease: () => Effect.die("unused"),
    claimDeprovision: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    removeClaimed: () => Effect.die("unused"),
  });
  const provider = ManagedEndpointProvider.ManagedEndpointProvider.of({
    provision: () => Effect.die("unused"),
    prepareDeprovision: () => Effect.die("unused"),
    deprovision: () => Effect.die("unused"),
    release: (request) =>
      Effect.sync(() => {
        releases.push(request);
        if (request.expectedTunnelId === input?.skipTunnelId) {
          return false;
        }
        if (request.expectedTunnelId !== undefined) {
          deleted.push(request.expectedTunnelId);
          const index = remaining.findIndex(
            (candidate) => candidate.id === request.expectedTunnelId,
          );
          if (index !== -1) {
            remaining.splice(index, 1);
          }
        }
        return true;
      }),
  });
  const config = RelayConfiguration.RelayConfiguration.of({
    relayIssuer: "https://relay.example.test",
    apns: {
      environment: "sandbox",
      teamId: "team-id",
      keyId: "key-id",
      privateKey: Redacted.make("private-key"),
      bundleId: "com.t3tools.t3code.dev",
    },
    apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
    clerkSecretKey: Redacted.make("clerk-secret"),
    clerkPublishableKey: "pk_test_test",
    clerkJwtAudience: "t3-code-relay",
    cloudMintPrivateKey: Redacted.make("cloud-private-key"),
    cloudMintPublicKey: "cloud-public-key",
    managedEndpointBaseDomain: "example.test",
    managedEndpointNamespace: input?.namespace ?? "prod",
  });

  return {
    listRequests,
    deleted,
    releases,
    layer: ManagedEndpointReaper.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          RelayConfiguration.layer(config),
          ManagedEndpointProvider.layerTunnelClient(tunnelClient),
          Layer.succeed(ManagedEndpointProvider.ManagedEndpointProvider, provider),
          Layer.succeed(ManagedEndpointAllocations.ManagedEndpointAllocations, allocationService),
        ),
      ),
    ),
  };
}

describe("ManagedEndpointReaper", () => {
  it.effect("removes expired down and inactive tunnels from recoverable environments", () => {
    const state = harness({
      tunnels: [
        tunnel({
          id: "down-1",
          suffix: "aaaaaaaaaaaaaaaa",
          status: "down",
          timestamp: "2026-08-25T11:55:00.000Z",
        }),
        tunnel({
          id: "inactive-1",
          suffix: "bbbbbbbbbbbbbbbb",
          status: "inactive",
          timestamp: "2026-08-25T11:54:00.000Z",
        }),
      ],
      allocations: [
        allocation({ tunnelId: "down-1", recoveryEnabled: true }),
        allocation({ tunnelId: "inactive-1", recoveryEnabled: true }),
      ],
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect(yield* reaper.sweep).toEqual({
        scanned: 2,
        deleted: 2,
        skippedLegacy: 0,
        failed: 0,
      });
      expect(state.deleted).toEqual(["down-1", "inactive-1"]);
      expect(state.releases.map((request) => request.expectedTunnelId)).toEqual([
        "down-1",
        "inactive-1",
      ]);
      expect(state.listRequests).toEqual([
        {
          isDeleted: false,
          includePrefix: PREFIX,
          status: "down",
          existedAt: "2026-08-25T11:55:00.000Z",
          wasInactiveAt: "2026-08-25T11:55:00.000Z",
          page: 1,
          perPage: 100,
        },
        {
          isDeleted: false,
          includePrefix: PREFIX,
          status: "inactive",
          existedAt: "2026-08-25T11:55:00.000Z",
          page: 1,
          perPage: 100,
        },
      ]);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("keeps recent tunnels, other stages, and tunnels without valid timestamps", () => {
    const state = harness({
      tunnels: [
        tunnel({
          id: "recent",
          suffix: "aaaaaaaaaaaaaaaa",
          status: "down",
          timestamp: "2026-08-25T11:55:01.000Z",
        }),
        tunnel({
          id: "other-stage",
          prefix: `${PREFIX}julius-`,
          suffix: "bbbbbbbbbbbbbbbb",
          status: "down",
          timestamp: "2026-08-25T11:00:00.000Z",
        }),
        tunnel({
          id: "missing-time",
          suffix: "cccccccccccccccc",
          status: "inactive",
          timestamp: null,
        }),
      ],
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect(yield* reaper.sweep).toEqual({
        scanned: 0,
        deleted: 0,
        skippedLegacy: 0,
        failed: 0,
      });
      expect(state.deleted).toEqual([]);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("keeps tunnels owned by environments that cannot recover yet", () => {
    const state = harness({
      tunnels: [
        tunnel({
          id: "legacy",
          suffix: "aaaaaaaaaaaaaaaa",
          status: "down",
          timestamp: "2026-08-25T11:00:00.000Z",
        }),
      ],
      allocations: [allocation({ tunnelId: "legacy", recoveryEnabled: false })],
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect(yield* reaper.sweep).toEqual({
        scanned: 1,
        deleted: 0,
        skippedLegacy: 1,
        failed: 0,
      });
      expect(state.deleted).toEqual([]);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("removes expired tunnels that no longer have an allocation", () => {
    const state = harness({
      tunnels: [
        tunnel({
          id: "orphan",
          suffix: "aaaaaaaaaaaaaaaa",
          status: "inactive",
          timestamp: "2026-08-25T11:00:00.000Z",
        }),
      ],
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect((yield* reaper.sweep).deleted).toBe(1);
      expect(state.deleted).toEqual(["orphan"]);
      expect(state.releases).toEqual([]);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("keeps an orphan tunnel that reconnects before deletion", () => {
    const listed = tunnel({
      id: "reconnected",
      suffix: "aaaaaaaaaaaaaaaa",
      status: "down",
      timestamp: "2026-08-25T11:00:00.000Z",
    });
    const state = harness({
      tunnels: [listed],
      refreshedTunnels: new Map([
        [
          "reconnected",
          tunnel({
            id: "reconnected",
            suffix: "aaaaaaaaaaaaaaaa",
            status: "healthy",
          }),
        ],
      ]),
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect((yield* reaper.sweep).deleted).toBe(0);
      expect(state.deleted).toEqual([]);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("treats an already deleted orphan tunnel as successfully removed", () => {
    const state = harness({
      tunnels: [
        tunnel({
          id: "gone",
          suffix: "aaaaaaaaaaaaaaaa",
          status: "down",
          timestamp: "2026-08-25T11:00:00.000Z",
        }),
      ],
      missingOnDeleteTunnelId: "gone",
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect(yield* reaper.sweep).toEqual({
        scanned: 1,
        deleted: 1,
        skippedLegacy: 0,
        failed: 0,
      });
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("does not delete an orphan tunnel reserved during the status check", () => {
    const state = harness({
      tunnels: [
        tunnel({
          id: "reserved",
          suffix: "aaaaaaaaaaaaaaaa",
          status: "down",
          timestamp: "2026-08-25T11:00:00.000Z",
        }),
      ],
      reserveOnGetTunnelId: "reserved",
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect((yield* reaper.sweep).deleted).toBe(0);
      expect(state.deleted).toEqual([]);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("does not count a tunnel that was replaced before its release", () => {
    const state = harness({
      tunnels: [
        tunnel({
          id: "replaced",
          suffix: "aaaaaaaaaaaaaaaa",
          status: "down",
          timestamp: "2026-08-25T11:00:00.000Z",
        }),
      ],
      allocations: [allocation({ tunnelId: "replaced", recoveryEnabled: true })],
      skipTunnelId: "replaced",
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect((yield* reaper.sweep).deleted).toBe(0);
      expect(state.deleted).toEqual([]);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("continues after an orphan tunnel deletion fails", () => {
    const state = harness({
      tunnels: [
        tunnel({
          id: "failed",
          suffix: "aaaaaaaaaaaaaaaa",
          status: "down",
          timestamp: "2026-08-25T11:00:00.000Z",
        }),
        tunnel({
          id: "next",
          suffix: "bbbbbbbbbbbbbbbb",
          status: "down",
          timestamp: "2026-08-25T11:00:00.000Z",
        }),
      ],
      failTunnelId: "failed",
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect(yield* reaper.sweep).toEqual({
        scanned: 2,
        deleted: 1,
        skippedLegacy: 0,
        failed: 1,
      });
      expect(state.deleted).toEqual(["next"]);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("continues past a page of older hosts to find recoverable tunnels", () => {
    const entries = Array.from({ length: 101 }, (_, index) =>
      tunnel({
        id: `tunnel-${index}`,
        suffix: index.toString(16).padStart(16, "0"),
        status: "down",
        timestamp: "2026-08-25T11:00:00.000Z",
      }),
    );
    const state = harness({
      tunnels: entries,
      allocations: entries.map((entry, index) =>
        allocation({ tunnelId: entry.id!, recoveryEnabled: index === 100 }),
      ),
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect(yield* reaper.sweep).toEqual({
        scanned: 101,
        deleted: 1,
        skippedLegacy: 100,
        failed: 0,
      });
      expect(state.deleted).toEqual(["tunnel-100"]);
      expect(
        state.listRequests
          .filter((request) => request.status === "down")
          .map((request) => request.page),
      ).toEqual([1, 2]);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("collects every page before deletions shift Cloudflare pagination", () => {
    const entries = Array.from({ length: 120 }, (_, index) =>
      tunnel({
        id: `tunnel-${index}`,
        suffix: index.toString(16).padStart(16, "0"),
        status: "down",
        timestamp: "2026-08-25T11:00:00.000Z",
      }),
    );
    const state = harness({
      tunnels: entries,
      allocations: entries
        .slice(50, 100)
        .map((entry) => allocation({ tunnelId: entry.id!, recoveryEnabled: false })),
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect(yield* reaper.sweep).toEqual({
        scanned: 120,
        deleted: 70,
        skippedLegacy: 50,
        failed: 0,
      });
      expect(state.deleted).toContain("tunnel-119");
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("limits each cleanup run to 100 tunnel deletions", () => {
    const state = harness({
      tunnels: Array.from({ length: 105 }, (_, index) =>
        tunnel({
          id: `tunnel-${index}`,
          suffix: index.toString(16).padStart(16, "0"),
          status: "down",
          timestamp: "2026-08-25T11:00:00.000Z",
        }),
      ),
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect((yield* reaper.sweep).deleted).toBe(100);
      expect(state.deleted).toHaveLength(100);
    }).pipe(Effect.provide(state.layer));
  });
});
