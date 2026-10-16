import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { relayEnvironmentLinks } from "../persistence/schema.ts";
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

function fixture() {
  let present = true;
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
          (!params.includes(device.deviceId) || params.includes(device.widgetPushToken))));
    const result = Effect.succeed(authorized ? [device] : []);
    return Object.assign(result, { limit: () => result });
  };
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where:
          table === relayEnvironmentLinks
            ? () => Effect.succeed([{ environmentId: "env-a" }])
            : select,
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: SQL) =>
          Effect.sync(() => {
            updates.push(values);
            const params = dialect.sqlToQuery(condition).params;
            queries.push(params);
            if (params.includes(tokenHash) && values.widgetAccessTokenHash === null)
              present = false;
          }),
      }),
    }),
  } as unknown as RelayDb.RelayDb["Service"];
  const layer = AgentWidgetRefresh.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RelayDb.RelayDb, db),
        Layer.succeed(AgentActivityRows.AgentActivityRows, {
          upsert: () => Effect.void,
          remove: () => Effect.void,
          pruneTerminal: () => Effect.void,
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
              return { ok: true, status: 200, apnsId: "apns-id" };
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
    complete: () => {
      activity = { ...activity, phase: "completed", headline: "Done" };
    },
  };
}

describe("AgentWidgetRefresh", () => {
  it.effect(
    "revokes only the presented capability and rejects subsequent reads and queued pushes",
    () => {
      const test = fixture();
      return Effect.gen(function* () {
        const widgets = yield* AgentWidgetRefresh.AgentWidgetRefresh;
        yield* widgets.revoke({ token: "b".repeat(64) });
        expect((yield* widgets.refresh({ token })).aggregate?.activeCount).toBe(1);
        yield* widgets.revoke({ token });
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
  it.effect(
    "reads the latest owner state without app credentials and sees completion on the next read",
    () => {
      const test = fixture();
      return Effect.gen(function* () {
        const widgets = yield* AgentWidgetRefresh.AgentWidgetRefresh;
        expect((yield* widgets.refresh({ token })).aggregate).toMatchObject({
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
          token: device.widgetPushToken,
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
});
