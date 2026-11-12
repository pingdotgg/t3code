// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous sha256 fixture mirrors the stored token hash.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PgClient } from "@effect/sql-pg/PgClient";
import { PGlite } from "@electric-sql/pglite";
import { makeWithDefaults } from "drizzle-orm/effect-postgres";
import * as FileSystem from "effect/FileSystem";
import * as Devices from "./Devices.ts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlError from "effect/sql/SqlError";
import { relayEnvironmentLinks, relayWidgetRevocations } from "../persistence/schema.ts";
import * as RelayDb from "../db.ts";
import * as RelayConfiguration from "../Config.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as ApnsClient from "./ApnsClient.ts";
import * as AgentWidgetRefresh from "./AgentWidgetRefresh.ts";
import type { ApnsDeliveryJobPayload } from "./apnsDeliveryJobs.ts";

const token = "a".repeat(64);
const tokenHash = NodeCrypto.createHash("sha256").update(token).digest("hex");
const device = {
  userId: "user-a",
  deviceId: "phone-a",
  platform: "ios",
  widgetAccessTokenHash: tokenHash,
  widgetPushToken: "abc123",
  bundleId: "com.t3tools.t3code.dev",
  apsEnvironment: "sandbox" as const,
};
const job: ApnsDeliveryJobPayload = {
  version: 1,
  jobId: "job",
  kind: "widget_refresh",
  target: { userId: device.userId, deviceId: device.deviceId, token: device.widgetPushToken },
  aggregate: null,
  notification: null,
  createdAt: "1970-01-01T00:00:00Z",
  expiresAt: "1970-01-01T00:10:00Z",
};
const state: RelayAgentActivityState = {
  environmentId: EnvironmentId.make("env-a"),
  threadId: ThreadId.make("thread-a"),
  projectTitle: "Widget test",
  threadTitle: "Finish background refresh",
  modelTitle: "Test agent",
  phase: "running",
  headline: "Working",
  updatedAt: "1970-01-01T00:00:00Z",
  deepLink: "/threads/env-a/thread-a",
};

function fixture(
  response: ApnsClient.ApnsDeliveryResult = { ok: true, status: 200, apnsId: "apns-id" },
  database?: RelayDb.RelayDb["Service"],
) {
  let present = true;
  let revokedBeforeClaim = false;
  const currentDevice = { ...device };
  let revocationsAllowed = true;
  let failCleanup = false;
  const revocations = new Set<string>();
  let activity = state;
  const queries: Array<ReadonlyArray<unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const reads: Array<string> = [];
  const pushes: Array<
    Parameters<ApnsClient.ApnsClient["Service"]["sendPushNotificationRequest"]>[0]
  > = [];
  const queued: Array<
    Parameters<ApnsDeliveryQueue.ApnsDeliveryQueue["Service"]["enqueueLiveActivity"]>[0]
  > = [];
  const dialect = new PgDialect();
  const select = (condition: SQL) => {
    const params = dialect.sqlToQuery(condition).params;
    queries.push(params);
    const authorized =
      present &&
      (params.includes(tokenHash) ||
        (params.includes(device.userId) &&
          (!params.includes(device.deviceId) ||
            params.includes(currentDevice.widgetPushToken ?? ""))));
    const result = Effect.succeed(authorized ? [{ ...currentDevice }] : []);
    return Object.assign(result, {
      limit: () =>
        Object.assign(result, { for: () => (revokedBeforeClaim ? Effect.succeed([]) : result) }),
    });
  };
  const db = {
    $client: { withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect },
    select: () => ({
      from: (table: unknown) => ({
        where:
          table === relayWidgetRevocations
            ? (condition: SQL) => {
                const params = dialect.sqlToQuery(condition).params;
                const result = Effect.succeed(revocations.has(String(params[0])) ? [{}] : []);
                return Object.assign(result, { limit: () => result });
              }
            : table === relayEnvironmentLinks
              ? (condition: SQL) => {
                  const params = dialect.sqlToQuery(condition).params;
                  queries.push(params);
                  return Effect.succeed(params.includes(true) ? [] : [{ environmentId: "env-a" }]);
                }
              : select,
      }),
    }),
    insert: () => ({
      values: ({ tokenHash }: { tokenHash: string }) => ({
        onConflictDoNothing: () =>
          Effect.sync(() => {
            revocations.add(tokenHash);
          }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: SQL) => {
          const result = Effect.suspend(() => {
            if (failCleanup && values.widgetAccessTokenHash === null) {
              failCleanup = false;
              return Effect.fail(
                new SqlError.SqlError({
                  reason: new SqlError.ConnectionError({
                    cause: new Error("cleanup write failed"),
                  }),
                }),
              );
            }
            return Effect.sync(() => {
              updates.push(values);
              const params = dialect.sqlToQuery(condition).params;
              queries.push(params);
              if (params.includes(tokenHash) && values.widgetAccessTokenHash === null)
                present = false;
              if (
                params.includes(tokenHash) ||
                params.includes(currentDevice.widgetPushToken ?? "")
              ) {
                Object.assign(currentDevice, values);
              }
              return { rowCount: present ? 1 : 0 };
            });
          });
          return Object.assign(result, {
            returning: () =>
              result.pipe(Effect.map(() => (present ? [{ deviceId: device.deviceId }] : []))),
          });
        },
      }),
    }),
  } as unknown as RelayDb.RelayDb["Service"];
  const layer = AgentWidgetRefresh.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RelayDb.RelayDb, database ?? db),
        Layer.succeed(AgentWidgetRefresh.WidgetRevocationRateLimiter, {
          allow: Effect.sync(() => revocationsAllowed),
        }),
        Layer.succeed(AgentActivityRows.AgentActivityRows, {
          upsert: () => Effect.succeed(true),
          remove: () => Effect.void,
          pruneTerminal: () => Effect.void,
          acknowledgeDelivery: () => Effect.void,
          getForUserThread: () => Effect.succeed(null),
          listForUser: ({ userId }) =>
            Effect.sync(() => {
              reads.push(userId);
              return userId === device.userId ? [activity] : [];
            }),
        }),
        Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueue, {
          enqueueLiveActivity: (input) =>
            Effect.sync(() => {
              queued.push(input);
              return {
                deviceId: input.deviceId,
                kind: input.kind,
                ok: true,
                queued: true,
                apnsStatus: null,
                apnsReason: null,
                apnsId: null,
              };
            }),
          enqueuePushNotification: () => Effect.die("unexpected alert"),
        }),
        Layer.succeed(ApnsClient.ApnsClient, {
          makeLiveActivityRequest: () => {
            throw new Error("unexpected activity");
          },
          makePushNotificationRequest: () => {
            throw new Error("unexpected alert");
          },
          sendLiveActivityRequest: () => Effect.die("unexpected activity"),
          sendPushNotificationRequest: (input) =>
            Effect.sync(() => {
              pushes.push(input);
              return response;
            }),
        }),
        Layer.succeed(RelayConfiguration.RelayConfiguration, {
          relayIssuer: "https://relay.test",
          clerkSecretKey: Redacted.make("test"),
          clerkPublishableKey: "test",
          clerkJwtAudience: "test",
          apnsDeliveryJobSigningSecret: Redacted.make("test"),
          cloudMintPrivateKey: Redacted.make("test"),
          cloudMintPublicKey: "test",
          managedEndpointBaseDomain: undefined,
          managedEndpointNamespace: undefined,
          apns: {
            teamId: "team",
            keyId: "key",
            bundleId: "com.t3tools.t3code",
            environment: "production",
            privateKey: Redacted.make("test"),
          },
        }),
      ),
    ),
  );
  return {
    layer,
    queries,
    updates,
    reads,
    pushes,
    queued,
    revoke: () => {
      present = false;
    },
    expireBeforeClaim: () => {
      revokedBeforeClaim = true;
    },
    failNextCleanup: () => {
      failCleanup = true;
    },
    allowRevocations: (allowed: boolean) => {
      revocationsAllowed = allowed;
    },
    complete: () => {
      activity = { ...activity, phase: "completed", headline: "Done" };
    },
  };
}

describe("AgentWidgetRefresh", () => {
  it.effect(
    "keeps revocation effective before a late registration and across registration retries",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pg = yield* Effect.acquireRelease(
          Effect.promise(() => PGlite.create()),
          (client) => Effect.promise(() => client.close()),
        );
        const migrations = new URL("../../migrations/postgres/", import.meta.url).pathname;
        for (const folder of (yield* fs.readDirectory(migrations)).toSorted()) {
          const migration = yield* fs.readFileString(`${migrations}/${folder}/migration.sql`);
          yield* Effect.promise(() => pg.exec(migration));
        }
        const client = {
          unsafe: (query: string, params: ReadonlyArray<unknown> = []) => {
            const result = Effect.promise(() =>
              pg.query<Record<string, unknown>>(query, [...params]),
            );
            return Object.assign(result.pipe(Effect.map((result) => result.rows)), {
              raw: result,
              withoutTransform: result.pipe(Effect.map((result) => result.rows)),
              values: result.pipe(
                Effect.map((result) =>
                  result.rows.map((row) => result.fields.map((field) => row[field.name])),
                ),
              ),
            });
          },
        } as unknown as PgClient;
        const db = yield* makeWithDefaults().pipe(Effect.provideService(PgClient, client));
        const registration = {
          deviceId: device.deviceId,
          label: "Phone",
          platform: "ios" as const,
          widgetAccessToken: token,
          preferences: {
            notificationsEnabled: false,
            liveActivitiesEnabled: false,
            notifyOnApproval: true,
            notifyOnInput: true,
            notifyOnCompletion: true,
            notifyOnFailure: true,
          },
        };
        yield* Effect.gen(function* () {
          const widgets = yield* AgentWidgetRefresh.AgentWidgetRefresh;
          const devices = yield* Devices.Devices;
          yield* widgets.revoke({ token });
          for (let attempt = 0; attempt < 2; attempt++) {
            yield* devices.register({ userId: device.userId, registration });
            expect((yield* Effect.flip(widgets.refresh({ token })))._tag).toBe(
              "WidgetRefreshUnauthorized",
            );
          }
          const nextToken = "b".repeat(64);
          yield* devices.register({
            userId: device.userId,
            registration: { ...registration, widgetAccessToken: nextToken },
          });
          expect((yield* widgets.refresh({ token: nextToken })).aggregate?.activeCount).toBe(1);
          yield* widgets.revoke({ token: nextToken });
          yield* devices.register({
            userId: device.userId,
            registration: { ...registration, widgetAccessToken: nextToken },
          });
          expect((yield* Effect.flip(widgets.refresh({ token: nextToken })))._tag).toBe(
            "WidgetRefreshUnauthorized",
          );
        }).pipe(
          Effect.provide(
            Layer.merge(
              fixture(undefined, db).layer,
              Devices.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db))),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "revokes only the presented capability and rejects subsequent reads and queued pushes",
    () => {
      const test = fixture();
      return Effect.gen(function* () {
        const widgets = yield* AgentWidgetRefresh.AgentWidgetRefresh;
        test.allowRevocations(false);
        expect((yield* Effect.flip(widgets.revoke({ token: "b".repeat(64) })))._tag).toBe(
          "WidgetRefreshRateLimited",
        );
        expect(test.updates).toEqual([]);
        expect((yield* widgets.refresh({ token })).aggregate?.activeCount).toBe(1);
        test.allowRevocations(true);
        yield* widgets.revoke({ token: "b".repeat(64) });
        expect((yield* widgets.refresh({ token })).aggregate?.activeCount).toBe(1);
        test.allowRevocations(false);
        yield* widgets.revoke({ token });
        const cleanupWrites = test.updates.length;
        yield* widgets.revoke({ token });
        expect(test.updates).toHaveLength(cleanupWrites);
        expect((yield* Effect.flip(widgets.refresh({ token })))._tag).toBe(
          "WidgetRefreshUnauthorized",
        );
        yield* widgets.process(job);
        expect(test.pushes).toEqual([]);
        expect(test.updates.at(-1)).toEqual({ widgetAccessTokenHash: null, widgetPushToken: null });
        expect(test.queries).toContainEqual([tokenHash]);
      }).pipe(Effect.provide(test.layer));
    },
  );
  it.effect("retries device cleanup after persisting a revocation tombstone", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const widgets = yield* AgentWidgetRefresh.AgentWidgetRefresh;
      test.failNextCleanup();
      expect((yield* Effect.flip(widgets.revoke({ token })))._tag).toBe(
        "WidgetRefreshPersistenceError",
      );
      yield* widgets.notify({ userId: device.userId });
      yield* widgets.process(job);
      expect(test.queued).toEqual([]);
      expect(test.pushes).toEqual([]);
      test.allowRevocations(false);
      yield* widgets.revoke({ token });
      yield* widgets.notify({ userId: device.userId });
      yield* widgets.process(job);
      expect(test.queued).toEqual([]);
      expect(test.pushes).toEqual([]);
      expect(test.updates.at(-1)).toEqual({ widgetAccessTokenHash: null, widgetPushToken: null });
    }).pipe(Effect.provide(test.layer));
  });
  it.effect(
    "reads the latest owner state without app credentials and sees completion on the next read",
    () => {
      const test = fixture();
      return Effect.gen(function* () {
        const widgets = yield* AgentWidgetRefresh.AgentWidgetRefresh;
        const snapshot = yield* widgets.refresh({ token });
        expect(snapshot.environmentIds).toEqual([state.environmentId]);
        expect(snapshot.aggregate).toMatchObject({
          activeCount: 1,
          activities: [{ phase: "running" }],
        });
        test.complete();
        expect((yield* widgets.refresh({ token })).aggregate).toMatchObject({
          activeCount: 0,
          activities: [{ phase: "completed" }],
        });
        expect(test.reads).toEqual(["user-a", "user-a"]);
        expect(test.queries[0]).toEqual([tokenHash, "ios"]);
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect("rejects wrong and revoked capabilities before reading agent state", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const widgets = yield* AgentWidgetRefresh.AgentWidgetRefresh;
      expect((yield* Effect.flip(widgets.refresh({ token: "b".repeat(64) })))._tag).toBe(
        "WidgetRefreshUnauthorized",
      );
      test.revoke();
      expect((yield* Effect.flip(widgets.refresh({ token })))._tag).toBe(
        "WidgetRefreshUnauthorized",
      );
      expect(test.reads).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("rejects a stale claim before clearing another owner's token", () => {
    const test = fixture();
    test.expireBeforeClaim();
    return Effect.gen(function* () {
      const widgets = yield* AgentWidgetRefresh.AgentWidgetRefresh;
      expect((yield* Effect.flip(widgets.refresh({ token, pushToken: "abc456" })))._tag).toBe(
        "WidgetRefreshUnauthorized",
      );
      expect(test.updates).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("claims rotated WidgetKit tokens and queues change requests without stale data", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const widgets = yield* AgentWidgetRefresh.AgentWidgetRefresh;
      yield* widgets.refresh({ token, pushToken: "abc456" });
      expect(test.updates).toEqual([{ widgetPushToken: null }, { widgetPushToken: "abc456" }]);
      yield* widgets.notify({ userId: device.userId });
      expect(test.queued).toEqual([
        {
          kind: "widget_refresh",
          userId: device.userId,
          deviceId: device.deviceId,
          token: "abc456",
          bundleId: device.bundleId,
          apsEnvironment: "sandbox",
          aggregate: null,
        },
      ]);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect(
    "sends a quiet WidgetKit reload with install routing and skips revoked queued targets",
    () => {
      const test = fixture();
      return Effect.gen(function* () {
        const widgets = yield* AgentWidgetRefresh.AgentWidgetRefresh;
        yield* widgets.process(job);
        expect(test.pushes).toHaveLength(1);
        expect(test.pushes[0]).toMatchObject({
          credentials: { bundleId: device.bundleId, environment: "sandbox" },
          request: {
            pushType: "widgets",
            priority: "5",
            payload: { aps: { "content-changed": true } },
          },
        });
        test.revoke();
        yield* widgets.process(job);
        expect(test.pushes).toHaveLength(1);
      }).pipe(Effect.provide(test.layer));
    },
  );
  it.effect("invalidates a widget token permanently rejected for its topic", () => {
    const test = fixture({
      ok: false,
      status: 400,
      apnsId: "apns-id",
      reason: "DeviceTokenNotForTopic",
    });
    return Effect.gen(function* () {
      const widgets = yield* AgentWidgetRefresh.AgentWidgetRefresh;
      yield* widgets.process(job);
      expect(test.updates).toContainEqual({ widgetPushToken: null });
    }).pipe(Effect.provide(test.layer));
  });
});
