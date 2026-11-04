import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { relayManagedEndpointAllocations } from "../persistence/schema.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";

const layerWithDb = (db: RelayDb.RelayDb["Service"]) =>
  ManagedEndpointAllocations.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db)));

describe("ManagedEndpointAllocations", () => {
  it.effect("returns recovery support with tunnel allocation lookups", () => {
    const base = {
      userId: "user-1",
      hostname: "environment.example.test",
      tunnelName: "managed-tunnel",
      dnsRecordId: "dns-1",
      readyAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
      generation: 1,
    };
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relayManagedEndpointAllocations);
          return {
            leftJoin: () => ({
              where: () =>
                Effect.succeed([
                  {
                    ...base,
                    environmentId: "environment-1",
                    tunnelId: "tunnel-1",
                    recoveryEnabledAt: "2026-08-25T12:00:00.000Z",
                    recoveryEnvironmentPublicKey: "current-key",
                    linkedEnvironmentPublicKey: "current-key",
                  },
                  {
                    ...base,
                    environmentId: "environment-2",
                    tunnelId: "tunnel-2",
                    recoveryEnabledAt: null,
                    recoveryEnvironmentPublicKey: null,
                    linkedEnvironmentPublicKey: "current-key",
                  },
                  {
                    ...base,
                    environmentId: "environment-3",
                    tunnelId: "tunnel-3",
                    recoveryEnabledAt: "2026-08-25T12:00:00.000Z",
                    recoveryEnvironmentPublicKey: "old-key",
                    linkedEnvironmentPublicKey: "new-key",
                  },
                ]),
            }),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const result = yield* allocations.listByTunnelNames([
        "first-tunnel",
        "second-tunnel",
        "third-tunnel",
      ]);

      expect(result.map((entry) => [entry.tunnelId, entry.recoveryEnabled])).toEqual([
        ["tunnel-1", true],
        ["tunnel-2", false],
        ["tunnel-3", false],
      ]);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("teardown claims leave updatedAt to provisioning writes", () => {
    // The tunnel limit compares link and allocation updatedAt; a claim that bumps it makes a
    // failed revoke cleanup look like a reprovision and keeps holding the user's slot.
    const writes: Array<Record<string, unknown>> = [];
    const fakeDb = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          writes.push(values);
          return {
            where: () => ({ returning: () => Effect.succeed([{ generation: 2 }]) }),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const key = { userId: "user-1", environmentId: "environment-1", generation: 1 };
      yield* allocations.claimDeprovision(key);
      yield* allocations.claimRelease({ ...key, tunnelId: "tunnel-1" });
      yield* allocations.claimRelease({ ...key, tunnelId: "tunnel-1", markReleased: true });

      expect(writes.map((values) => "updatedAt" in values)).toEqual([false, false, true]);
      expect(writes[2]?.["updatedAt"]).toBe(writes[2]?.["tunnelReleasedAt"]);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });
});
