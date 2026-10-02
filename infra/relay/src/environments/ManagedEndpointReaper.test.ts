import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

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

function recoverableOwners(
  tunnels: ReadonlyArray<ManagedEndpointProvider.ManagedEndpointTunnel>,
): ReadonlyArray<ManagedEndpointAllocations.ManagedEndpointTunnelAllocation> {
  return tunnels.map((entry) => allocation({ tunnelId: entry.id!, recoveryEnabled: true }));
}

function allocation(input: {
  readonly tunnelId: string | null;
  readonly recoveryEnabled: boolean;
}): ManagedEndpointAllocations.ManagedEndpointTunnelAllocation {
  return {
    userId: "user-1",
    environmentId: `environment-${input.tunnelId ?? "pending"}`,
    hostname: `${input.tunnelId ?? "pending"}.example.test`,
    tunnelId: input.tunnelId,
    tunnelName: `${PREFIX}aaaaaaaaaaaaaaaa`,
    dnsRecordId: "dns-1",
    readyAt: "2026-08-25T11:00:00.000Z",
    origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
    updatedAt: "2026-08-25T11:00:00.000Z",
    generation: 1,
    tunnelReleasedAt: null,
    recoveryEnabled: input.recoveryEnabled,
  };
}

function harness(input?: {
  readonly tunnels?: ReadonlyArray<ManagedEndpointProvider.ManagedEndpointTunnel>;
  readonly allocations?: ReadonlyArray<ManagedEndpointAllocations.ManagedEndpointTunnelAllocation>;
  readonly namespace?: string;
  readonly failTunnelId?: string;
  readonly rateLimitedTunnelId?: string;
  readonly failAllDeletes?: boolean;
  readonly failDeleteWhen?: (tunnelId: string) => boolean;
  readonly missingOnDeleteTunnelId?: string;
  readonly missingOnGetTunnelId?: string;
  readonly reserveOnGetTunnelId?: string;
  readonly refreshedTunnels?: ReadonlyMap<string, ManagedEndpointProvider.ManagedEndpointTunnel>;
  readonly skipTunnelId?: string;
  readonly cleanupMode?: RelayConfiguration.ManagedEndpointCleanupMode;
  readonly legacyCleanupMode?: RelayConfiguration.ManagedEndpointCleanupMode;
  readonly legacyTunnelGraceMinutes?: number;
  /** Simulated time each release takes, advanced on the test clock. */
  readonly releaseDelayMs?: number;
  /** Simulated time each Cloudflare list request takes. */
  readonly listDelayMs?: number;
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
      Effect.gen(function* () {
        if (input?.listDelayMs !== undefined) {
          yield* TestClock.adjust(input.listDelayMs);
        }
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
      input?.failAllDeletes === true ||
      input?.failDeleteWhen?.(tunnelId) === true ||
      tunnelId === input?.failTunnelId ||
      tunnelId === input?.rateLimitedTunnelId ||
      tunnelId === input?.missingOnDeleteTunnelId
        ? Effect.fail(
            new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
              operation: "delete",
              tunnelId,
              cause:
                tunnelId === input?.missingOnDeleteTunnelId
                  ? { _tag: "NotFound" }
                  : tunnelId === input?.rateLimitedTunnelId
                    ? {
                        cause: {
                          _tag: "TooManyRequests",
                          message: "Cloudflare rate limit exceeded",
                          retryAfter: 60,
                        },
                      }
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
    withClaimedTunnel: () => Effect.die("unused"),
    claimDeprovision: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    removeClaimed: () => Effect.die("unused"),
  });
  const provider = ManagedEndpointProvider.ManagedEndpointProvider.of({
    provision: () => Effect.die("unused"),
    reconcileOrigin: () => Effect.die("unused"),
    prepareDeprovision: () => Effect.die("unused"),
    deprovision: () => Effect.die("unused"),
    release: (request) =>
      Effect.gen(function* () {
        releases.push(request);
        if (input?.releaseDelayMs !== undefined) {
          yield* TestClock.adjust(input.releaseDelayMs);
        }
        if (request.expectedTunnelId === input?.skipTunnelId) {
          return false;
        }
        if (request.expectedTunnelId !== undefined) {
          // Surface Cloudflare failures the same way the real release does.
          yield* tunnelClient.delete(request.expectedTunnelId).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedEndpointProvider.ManagedEndpointDeprovisioningFailed({
                  stage: "delete-tunnel",
                  userId: request.userId,
                  environmentId: request.environmentId,
                  tunnelId: request.expectedTunnelId!,
                  cause,
                }),
            ),
          );
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
    managedEndpointCleanupMode: input?.cleanupMode ?? "enabled",
    legacyManagedEndpointCleanupMode: input?.legacyCleanupMode ?? "off",
    ...(input?.legacyTunnelGraceMinutes === undefined
      ? {}
      : { legacyTunnelGraceMinutes: input.legacyTunnelGraceMinutes }),
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
          timestamp: "2026-08-25T10:59:00.000Z",
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
      expect(yield* reaper.sweep).toMatchObject({
        scanned: 2,
        deleted: 2,
        skippedLegacy: 0,
        failed: 0,
      });
      expect(state.deleted).toEqual(["down-1", "inactive-1"]);
      // A host that registered recovery gets a new tunnel on its own.
      expect(state.releases.some((release) => release.markReleased === true)).toBe(false);
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
          existedAt: "2026-08-25T11:00:00.000Z",
          page: 1,
          perPage: 100,
        },
      ]);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("keeps a tunnel that never connected until it is an hour old", () => {
    const state = harness({
      tunnels: [
        tunnel({
          id: "pairing",
          suffix: "cccccccccccccccc",
          status: "inactive",
          timestamp: "2026-08-25T11:30:00.000Z",
        }),
      ],
      allocations: [allocation({ tunnelId: "pairing", recoveryEnabled: true })],
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect((yield* reaper.sweep).deleted).toBe(0);
      expect(state.deleted).toEqual([]);
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
      expect(yield* reaper.sweep).toMatchObject({
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
      expect(yield* reaper.sweep).toMatchObject({
        scanned: 1,
        deleted: 0,
        skippedLegacy: 1,
        failed: 0,
      });
      expect(state.deleted).toEqual([]);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("counts an expired tunnel with no allocation instead of deleting it", () => {
    const state = harness({
      tunnels: [
        tunnel({
          id: "orphan",
          suffix: "cccccccccccccccc",
          status: "down",
          timestamp: "2026-08-25T11:00:00.000Z",
        }),
      ],
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect(yield* reaper.sweep).toMatchObject({
        scanned: 1,
        wouldDelete: 0,
        deleted: 0,
        skippedOrphan: 1,
      });
      expect(state.deleted).toEqual([]);
    }).pipe(Effect.provide(state.layer));
  });
  it.effect("keeps an expired tunnel while its allocation is incomplete", () => {
    const state = harness({
      tunnels: [
        tunnel({
          id: "unrecorded",
          suffix: "aaaaaaaaaaaaaaaa",
          status: "inactive",
          timestamp: "2026-08-25T11:00:00.000Z",
        }),
      ],
      allocations: [allocation({ tunnelId: null, recoveryEnabled: false })],
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect((yield* reaper.sweep).deleted).toBe(0);
      expect(state.deleted).toEqual([]);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("measures legacy age, uncounted skips, and Cloudflare totals", () => {
    const down = (id: string, suffix: string, timestamp: string) =>
      tunnel({ id, suffix, status: "down", timestamp });
    const tunnels = [
      // Legacy owners, down for 1, 10, 40, and 100 days, plus one just past
      // seven days, which must already count as over seven.
      down("legacy-1d", "1111111111111111", "2026-08-24T11:00:00.000Z"),
      down("legacy-7d1h", "7777777777777777", "2026-08-18T11:00:00.000Z"),
      down("legacy-10d", "2222222222222222", "2026-08-15T11:00:00.000Z"),
      down("legacy-40d", "3333333333333333", "2026-07-16T11:00:00.000Z"),
      down("legacy-100d", "4444444444444444", "2026-05-17T11:00:00.000Z"),
      // The allocation now records a different tunnel under this name.
      down("stale", "5555555555555555", "2026-08-25T11:00:00.000Z"),
      // The allocation has not recorded a tunnel yet.
      down("pending", "6666666666666666", "2026-08-25T11:00:00.000Z"),
    ];
    const state = harness({
      tunnels,
      allocations: [
        allocation({ tunnelId: "legacy-1d", recoveryEnabled: false }),
        allocation({ tunnelId: "legacy-7d1h", recoveryEnabled: false }),
        allocation({ tunnelId: "legacy-10d", recoveryEnabled: false }),
        allocation({ tunnelId: "legacy-40d", recoveryEnabled: false }),
        allocation({ tunnelId: "legacy-100d", recoveryEnabled: false }),
        {
          ...allocation({ tunnelId: "current", recoveryEnabled: true }),
          tunnelName: `${PREFIX}5555555555555555`,
        },
        {
          ...allocation({ tunnelId: null, recoveryEnabled: false }),
          tunnelName: `${PREFIX}6666666666666666`,
        },
      ],
      cleanupMode: "dry-run",
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect(yield* reaper.sweep).toMatchObject({
        scanned: 7,
        skippedLegacy: 5,
        legacyOver7Days: 4,
        legacyOver30Days: 2,
        legacyOver90Days: 1,
        skippedReplaced: 1,
        skippedUnrecorded: 1,
        totalDown: 7,
        totalInactive: 0,
        wouldDelete: 0,
      });
    }).pipe(Effect.provide(state.layer));
  });

  describe("legacy cleanup", () => {
    const legacyTunnels = [
      // Down for 10 days: inside the legacy grace period.
      tunnel({
        id: "legacy-recent",
        suffix: "1111111111111111",
        status: "down",
        timestamp: "2026-08-15T12:00:00.000Z",
      }),
      // Down for 40 days: past it.
      tunnel({
        id: "legacy-old",
        suffix: "2222222222222222",
        status: "down",
        timestamp: "2026-07-16T12:00:00.000Z",
      }),
      // Never connected, created 40 days ago.
      tunnel({
        id: "legacy-never",
        suffix: "3333333333333333",
        status: "inactive",
        timestamp: "2026-07-16T12:00:00.000Z",
      }),
    ];
    const legacyOwners = legacyTunnels.map((entry) =>
      allocation({ tunnelId: entry.id!, recoveryEnabled: false }),
    );

    it.effect("leaves legacy tunnels alone while legacy cleanup is off", () => {
      const state = harness({ tunnels: legacyTunnels, allocations: legacyOwners });
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MILLIS);
        const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
        expect(yield* reaper.sweep).toMatchObject({
          skippedLegacy: 3,
          wouldDeleteLegacy: 0,
          deletedLegacy: 0,
        });
        expect(state.deleted).toEqual([]);
      }).pipe(Effect.provide(state.layer));
    });

    it.effect("counts legacy tunnels past the grace period in dry-run", () => {
      const state = harness({
        tunnels: legacyTunnels,
        allocations: legacyOwners,
        legacyCleanupMode: "dry-run",
      });
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MILLIS);
        const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
        expect(yield* reaper.sweep).toMatchObject({
          legacyMode: "dry-run",
          wouldDeleteLegacy: 2,
          deletedLegacy: 0,
          attempted: 0,
        });
        expect(state.deleted).toEqual([]);
      }).pipe(Effect.provide(state.layer));
    });

    it.effect("deletes only legacy tunnels past the grace period", () => {
      const state = harness({
        tunnels: legacyTunnels,
        allocations: legacyOwners,
        legacyCleanupMode: "enabled",
      });
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MILLIS);
        const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
        expect(yield* reaper.sweep).toMatchObject({
          wouldDeleteLegacy: 2,
          deletedLegacy: 2,
          deleted: 2,
        });
        expect([...state.deleted].sort()).toEqual(["legacy-never", "legacy-old"]);
        // A legacy host needs an update to recover, so its user is told why.
        expect(state.releases.every((release) => release.markReleased === true)).toBe(true);
        // The release re-checks each tunnel against the 30-day cutoff, not
        // the 5-minute cutoff used for recoverable tunnels.
        for (const release of state.releases) {
          expect(release.expectedInactiveBefore).toBe("2026-07-26T12:00:00.000Z");
        }
      }).pipe(Effect.provide(state.layer));
    });

    it.effect.each([
      { stage: "canary", expected: 3 },
      { stage: "prod", expected: 2 },
    ] as const)(
      "applies the grace-period override only off prod ($stage)",
      ({ stage, expected }) => {
        const stageLegacyTunnels = legacyTunnels.map((entry) => ({
          ...entry,
          name: entry.name!.replace(PREFIX, `t3coderelay-managedendpoint-${stage}-`),
        }));
        const state = harness({
          namespace: stage,
          tunnels: stageLegacyTunnels,
          allocations: legacyOwners,
          legacyCleanupMode: "dry-run",
          // Ten minutes: the 10-day-old tunnel qualifies only if this applies.
          legacyTunnelGraceMinutes: 10,
        });
        return Effect.gen(function* () {
          yield* TestClock.setTime(NOW_MILLIS);
          const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
          expect((yield* reaper.sweep).wouldDeleteLegacy).toBe(expected);
        }).pipe(Effect.provide(state.layer));
      },
    );

    it.effect("runs legacy cleanup while recoverable cleanup is off", () => {
      const recoverable = tunnel({
        id: "recoverable",
        suffix: "4444444444444444",
        status: "down",
        timestamp: "2026-08-25T11:00:00.000Z",
      });
      const state = harness({
        tunnels: [...legacyTunnels, recoverable],
        allocations: [
          ...legacyOwners,
          allocation({ tunnelId: "recoverable", recoveryEnabled: true }),
        ],
        cleanupMode: "off",
        legacyCleanupMode: "enabled",
      });
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MILLIS);
        const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
        expect(yield* reaper.sweep).toMatchObject({ wouldDelete: 0, deletedLegacy: 2 });
        expect(state.deleted).not.toContain("recoverable");
      }).pipe(Effect.provide(state.layer));
    });
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

  it.effect("stops the sweep after a structured Cloudflare rate limit error", () => {
    const state = harness({
      tunnels: [
        tunnel({
          id: "limited",
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
      allocations: [
        allocation({ tunnelId: "limited", recoveryEnabled: true }),
        allocation({ tunnelId: "next", recoveryEnabled: true }),
      ],
      rateLimitedTunnelId: "limited",
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect(yield* reaper.sweep).toMatchObject({
        attempted: 1,
        deleted: 0,
        failed: 1,
        truncated: true,
      });
      expect(state.deleted).toEqual([]);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("starts no new deletion after a rate limit, even with deletions in flight", () => {
    // Enough candidates to fill every concurrent slot several times over.
    const entries = Array.from({ length: 12 }, (_, index) =>
      tunnel({
        id: index === 0 ? "limited" : `ok-${index}`,
        suffix: index.toString(16).padStart(16, "0"),
        status: "down",
        timestamp: "2026-08-25T11:00:00.000Z",
      }),
    );
    const state = harness({
      tunnels: entries,
      allocations: recoverableOwners(entries),
      rateLimitedTunnelId: "limited",
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      const result = yield* reaper.sweep;
      expect(result.truncated).toBe(true);
      expect(result.failed).toBe(1);
      // Releases already running may finish, but none start afterwards.
      expect(result.attempted).toBeLessThanOrEqual(
        ManagedEndpointReaper.MANAGED_ENDPOINT_SWEEP_DELETE_CONCURRENCY,
      );
      expect(state.releases.length).toBe(result.attempted);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("stops starting deletions when the sweep's time budget runs out", () => {
    const entries = Array.from({ length: 40 }, (_, index) =>
      tunnel({
        id: `slow-${index}`,
        suffix: index.toString(16).padStart(16, "0"),
        status: "down",
        timestamp: "2026-08-25T11:00:00.000Z",
      }),
    );
    const state = harness({
      tunnels: entries,
      allocations: recoverableOwners(entries),
      // Ten seconds each: the 90-second budget allows about 9 rounds.
      releaseDelayMs: 10_000,
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      const result = yield* reaper.sweep;
      expect(result.truncated).toBe(true);
      expect(result.attempted).toBeGreaterThan(0);
      expect(result.attempted).toBeLessThan(entries.length);
      expect(result.deleted).toBe(result.attempted);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("counts listing time against the deletion budget", () => {
    const entries = Array.from({ length: 40 }, (_, index) =>
      tunnel({
        id: `slow-${index}`,
        suffix: index.toString(16).padStart(16, "0"),
        status: "down",
        timestamp: "2026-08-25T11:00:00.000Z",
      }),
    );
    const sweepWith = (listDelayMs: number) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MILLIS);
        const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
        return (yield* reaper.sweep).attempted;
      }).pipe(
        Effect.provide(
          harness({
            tunnels: entries,
            allocations: recoverableOwners(entries),
            releaseDelayMs: 10_000,
            listDelayMs,
          }).layer,
        ),
      );

    return Effect.gen(function* () {
      const fastListing = yield* sweepWith(0);
      // Two list requests of 20 seconds each use 40 of the 90-second budget.
      const slowListing = yield* sweepWith(20_000);
      expect(slowListing).toBeLessThan(fastListing);
    });
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
      expect(yield* reaper.sweep).toMatchObject({
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
      allocations: entries.map((entry, index) =>
        allocation({ tunnelId: entry.id!, recoveryEnabled: index < 50 || index >= 100 }),
      ),
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect(yield* reaper.sweep).toMatchObject({
        scanned: 120,
        deleted: 70,
        skippedLegacy: 50,
        failed: 0,
      });
      expect(state.deleted).toContain("tunnel-119");
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("limits each cleanup run to 100 tunnel deletions", () => {
    const entries = Array.from({ length: 105 }, (_, index) =>
      tunnel({
        id: `tunnel-${index}`,
        suffix: index.toString(16).padStart(16, "0"),
        status: "down",
        timestamp: "2026-08-25T11:00:00.000Z",
      }),
    );
    const state = harness({ tunnels: entries, allocations: recoverableOwners(entries) });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect((yield* reaper.sweep).deleted).toBe(100);
      expect(state.deleted).toHaveLength(100);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("records dry-run counters on the sweep span", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const expired = [
      tunnel({
        id: "recoverable",
        suffix: "aaaaaaaaaaaaaaaa",
        status: "down",
        timestamp: "2026-08-25T11:00:00.000Z",
      }),
      tunnel({
        id: "legacy",
        suffix: "bbbbbbbbbbbbbbbb",
        status: "down",
        timestamp: "2026-08-25T11:00:00.000Z",
      }),
    ];
    const state = harness({
      cleanupMode: "dry-run",
      tunnels: expired,
      allocations: [
        allocation({ tunnelId: "recoverable", recoveryEnabled: true }),
        allocation({ tunnelId: "legacy", recoveryEnabled: false }),
      ],
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      yield* reaper.sweep;
      const sweepSpan = spans.find((span) => span.name === "relay.managed_endpoint_reaper.sweep");
      expect(Object.fromEntries(sweepSpan?.attributes ?? [])).toMatchObject({
        "relay.managed_endpoint_reaper.mode": "dry-run",
        "relay.managed_endpoint_reaper.scanned": 2,
        "relay.managed_endpoint_reaper.wouldDelete": 1,
        "relay.managed_endpoint_reaper.skippedLegacy": 1,
        "relay.managed_endpoint_reaper.deleted": 0,
      });
      expect(state.deleted).toEqual([]);
    }).pipe(Effect.provide(state.layer), Effect.withTracer(tracer));
  });

  it.effect("does no Cloudflare work while cleanup is off", () => {
    const state = harness({
      cleanupMode: "off",
      tunnels: [
        tunnel({
          id: "expired",
          suffix: "aaaaaaaaaaaaaaaa",
          status: "down",
          timestamp: "2026-08-25T11:00:00.000Z",
        }),
      ],
      allocations: [allocation({ tunnelId: "expired", recoveryEnabled: true })],
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect(yield* reaper.sweep).toEqual({
        mode: "off",
        legacyMode: "off",
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
      expect(state.listRequests).toEqual([]);
      expect(state.deleted).toEqual([]);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("reports candidates without mutating them in dry-run mode", () => {
    const state = harness({
      cleanupMode: "dry-run",
      tunnels: [
        tunnel({
          id: "expired",
          suffix: "aaaaaaaaaaaaaaaa",
          status: "down",
          timestamp: "2026-08-25T11:00:00.000Z",
        }),
      ],
      allocations: [allocation({ tunnelId: "expired", recoveryEnabled: true })],
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect(yield* reaper.sweep).toMatchObject({
        mode: "dry-run",
        scanned: 1,
        attempted: 0,
        deleted: 0,
        wouldDelete: 1,
      });
      expect(state.deleted).toEqual([]);
      expect(state.releases).toEqual([]);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("caps failed deletion attempts and Cloudflare list pages", () => {
    const entries = Array.from({ length: 250 }, (_, index) =>
      tunnel({
        id: `failed-${index}`,
        suffix: index.toString(16).padStart(16, "0"),
        status: "down",
        timestamp: "2026-08-25T11:00:00.000Z",
      }),
    );
    const state = harness({
      tunnels: entries,
      allocations: recoverableOwners(entries),
      failAllDeletes: true,
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MILLIS);
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      expect(yield* reaper.sweep).toMatchObject({
        attempted: 100,
        deleted: 0,
        failed: 100,
        truncated: true,
      });
      expect(state.listRequests.length).toBeLessThanOrEqual(
        ManagedEndpointReaper.MANAGED_ENDPOINT_SWEEP_LIST_REQUEST_LIMIT,
      );
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("rotates the deletion order so persistent failures do not starve later tunnels", () => {
    const entries = Array.from({ length: 200 }, (_, index) =>
      tunnel({
        id: `tunnel-${index}`,
        suffix: index.toString(16).padStart(16, "0"),
        status: "down",
        timestamp: "2026-08-25T11:00:00.000Z",
      }),
    );
    // The first 100 candidates always fail to delete.
    const state = harness({
      tunnels: entries,
      allocations: recoverableOwners(entries),
      failDeleteWhen: (id) => Number(id.split("-")[1]) < 100,
    });

    return Effect.gen(function* () {
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      yield* TestClock.setTime(NOW_MILLIS);
      yield* reaper.sweep;
      yield* TestClock.setTime(NOW_MILLIS + 5 * 60 * 1_000);
      yield* reaper.sweep;
      const later = state.deleted.filter((id) => Number(id.split("-")[1]) >= 100);
      expect(later.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("rotates bounded pages across a large legacy prefix", () => {
    const entries = Array.from({ length: 1_000 }, (_, index) =>
      tunnel({
        id: `legacy-${index}`,
        suffix: index.toString(16).padStart(16, "0"),
        status: "down",
        timestamp: "2026-08-25T11:00:00.000Z",
      }),
    );
    const state = harness({
      cleanupMode: "dry-run",
      tunnels: entries,
      allocations: entries.map((entry) =>
        allocation({ tunnelId: entry.id!, recoveryEnabled: false }),
      ),
    });

    return Effect.gen(function* () {
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      yield* TestClock.setTime(NOW_MILLIS);
      yield* reaper.sweep;
      const firstPages = state.listRequests
        .filter((request) => request.status === "down")
        .map((request) => request.page);
      state.listRequests.length = 0;
      yield* TestClock.setTime(NOW_MILLIS + 5 * 60 * 1_000);
      yield* reaper.sweep;
      const secondPages = state.listRequests
        .filter((request) => request.status === "down")
        .map((request) => request.page);
      expect(firstPages).not.toEqual(secondPages);
      expect(firstPages).toHaveLength(5);
      expect(secondPages).toHaveLength(5);
    }).pipe(Effect.provide(state.layer));
  });

  it.effect("rotates the attempt budget across both statuses over consecutive sweeps", () => {
    const entries = (["down", "inactive"] as const).flatMap((status) =>
      Array.from({ length: 100 }, (_, index) =>
        tunnel({
          id: `${status}-${index}`,
          suffix: `${status === "down" ? "a" : "b"}${index.toString(16).padStart(15, "0")}`,
          status,
          timestamp: "2026-08-25T10:00:00.000Z",
        }),
      ),
    );
    const state = harness({ tunnels: entries, allocations: recoverableOwners(entries) });

    return Effect.gen(function* () {
      const reaper = yield* ManagedEndpointReaper.ManagedEndpointReaper;
      yield* TestClock.setTime(NOW_MILLIS);
      yield* reaper.sweep;
      const firstStatus = state.deleted[0]!.split("-")[0];
      expect(state.deleted).toHaveLength(100);
      expect(state.deleted.every((id) => id.startsWith(`${firstStatus}-`))).toBe(true);

      state.deleted.length = 0;
      yield* TestClock.setTime(NOW_MILLIS + 5 * 60 * 1_000);
      yield* reaper.sweep;
      expect(state.deleted).toHaveLength(100);
      expect(state.deleted.every((id) => !id.startsWith(`${firstStatus}-`))).toBe(true);
    }).pipe(Effect.provide(state.layer));
  });
});
