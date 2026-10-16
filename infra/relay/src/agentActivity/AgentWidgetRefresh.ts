import * as NodeCrypto from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  RelayAgentActivitySnapshotResponse,
  RelayDeliveryResult,
} from "@t3tools/contracts/relay";
import { EnvironmentId } from "@t3tools/contracts";
import * as RelayDb from "../db.ts";
import * as RelayConfiguration from "../Config.ts";
import { relayMobileDevices, relayEnvironmentLinks } from "../persistence/schema.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as ApnsClient from "./ApnsClient.ts";
import { makeAggregateState } from "./agentActivityAggregate.ts";
import type { ApnsDeliveryJobPayload } from "./apnsDeliveryJobs.ts";

export class WidgetRefreshUnauthorized extends Schema.TaggedError<WidgetRefreshUnauthorized>()(
  "WidgetRefreshUnauthorized",
  {},
) {}

export class WidgetRefreshPersistenceError extends Schema.TaggedError<WidgetRefreshPersistenceError>()(
  "WidgetRefreshPersistenceError",
  { stage: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Failed to persist widget refresh during ${this.stage}.`;
  }
}

type WidgetRefreshError =
  | WidgetRefreshPersistenceError
  | WidgetRefreshUnauthorized
  | AgentActivityRows.AgentActivityRowListPersistenceError;

export class AgentWidgetRefresh extends Context.Service<
  AgentWidgetRefresh,
  {
    readonly refresh: (input: {
      readonly token: string;
      readonly pushToken?: string;
    }) => Effect.Effect<RelayAgentActivitySnapshotResponse, WidgetRefreshError>;
    readonly revoke: (input: {
      readonly token: string;
    }) => Effect.Effect<void, WidgetRefreshPersistenceError | WidgetRefreshUnauthorized>;
    readonly notify: (input: {
      readonly userId: string;
    }) => Effect.Effect<
      ReadonlyArray<RelayDeliveryResult>,
      WidgetRefreshPersistenceError | ApnsDeliveryQueue.ApnsDeliveryQueueError
    >;
    readonly process: (
      job: ApnsDeliveryJobPayload,
    ) => Effect.Effect<RelayDeliveryResult, WidgetRefreshPersistenceError | ApnsClient.ApnsError>;
  }
>()("t3code-relay/agentActivity/AgentWidgetRefresh") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const rows = yield* AgentActivityRows.AgentActivityRows;
  const queue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
  const apns = yield* ApnsClient.ApnsClient;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const persistenceError = (stage: string) =>
    Effect.mapError((cause) => new WidgetRefreshPersistenceError({ stage, cause }));

  return AgentWidgetRefresh.of({
    revoke: Effect.fn("relay.agent_widget.revoke")(function* ({ token }) {
      if (!/^[a-f0-9]{64}$/.test(token)) return yield* new WidgetRefreshUnauthorized();
      const tokenHash = NodeCrypto.createHash("sha256").update(token).digest("hex");
      yield* db
        .update(relayMobileDevices)
        .set({ widgetAccessTokenHash: null, widgetPushToken: null })
        .where(eq(relayMobileDevices.widgetAccessTokenHash, tokenHash))
        .pipe(persistenceError("revoke"));
    }),
    refresh: Effect.fn("relay.agent_widget.refresh")(function* ({ token, pushToken }) {
      if (!/^[a-f0-9]{64}$/.test(token)) return yield* new WidgetRefreshUnauthorized();
      const tokenHash = NodeCrypto.createHash("sha256").update(token).digest("hex");
      const [device] = yield* db
        .select()
        .from(relayMobileDevices)
        .where(
          and(
            eq(relayMobileDevices.widgetAccessTokenHash, tokenHash),
            eq(relayMobileDevices.platform, "ios"),
          ),
        )
        .limit(1)
        .pipe(persistenceError("authorize"));
      if (!device) return yield* new WidgetRefreshUnauthorized();
      if (
        pushToken !== undefined &&
        pushToken !== device.widgetPushToken &&
        (pushToken === "" || /^[a-f0-9]{1,512}$/.test(pushToken))
      ) {
        // WidgetKit tokens are exclusive to an install, including account changes.
        yield* db
          .update(relayMobileDevices)
          .set({ widgetPushToken: null })
          .where(eq(relayMobileDevices.widgetPushToken, pushToken))
          .pipe(persistenceError("claim-push-token"));
        yield* db
          .update(relayMobileDevices)
          .set({ widgetPushToken: pushToken || null })
          .where(
            and(
              eq(relayMobileDevices.userId, device.userId),
              eq(relayMobileDevices.deviceId, device.deviceId),
              eq(relayMobileDevices.widgetAccessTokenHash, tokenHash),
            ),
          )
          .pipe(persistenceError("register-push-token"));
      }
      const coveredEnvironments = yield* db
        .select({ environmentId: relayEnvironmentLinks.environmentId })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.userId, device.userId),
            isNull(relayEnvironmentLinks.revokedAt),
            eq(relayEnvironmentLinks.liveActivitiesEnabled, true),
          ),
        )
        .pipe(persistenceError("list-environments"));
      const activeStates = yield* rows.listForUser({ userId: device.userId });
      const now = yield* DateTime.now;
      return {
        environmentIds: coveredEnvironments.map((row) => EnvironmentId.make(row.environmentId)),
        aggregate: makeAggregateState({
          activeStates,
          terminalState: null,
          nowMs: now.epochMilliseconds,
        }),
      };
    }),
    notify: Effect.fn("relay.agent_widget.notify")(function* ({ userId }) {
      const targets = yield* db
        .select()
        .from(relayMobileDevices)
        .where(
          and(
            eq(relayMobileDevices.userId, userId),
            isNotNull(relayMobileDevices.widgetAccessTokenHash),
            isNotNull(relayMobileDevices.widgetPushToken),
          ),
        )
        .pipe(persistenceError("list-push-targets"));
      return yield* Effect.forEach(
        targets,
        (target) =>
          queue.enqueueLiveActivity({
            kind: "widget_refresh",
            userId,
            deviceId: target.deviceId,
            token: target.widgetPushToken ?? "",
            bundleId: target.bundleId,
            apsEnvironment: target.apsEnvironment,
            aggregate: null,
          }),
        { concurrency: 4 },
      );
    }),
    process: Effect.fn("relay.agent_widget.process")(function* (job) {
      const [device] = yield* db
        .select()
        .from(relayMobileDevices)
        .where(
          and(
            eq(relayMobileDevices.userId, job.target.userId),
            eq(relayMobileDevices.deviceId, job.target.deviceId),
            eq(relayMobileDevices.widgetPushToken, job.target.token),
          ),
        )
        .limit(1)
        .pipe(persistenceError("read-push-target"));
      // Signed-out, revoked, or rotated targets never receive an old queued push.
      const skipped = {
        deviceId: job.target.deviceId,
        kind: "widget_refresh" as const,
        ok: true,
        apnsStatus: null,
        apnsReason: null,
        apnsId: null,
      };
      if (!device || !device.widgetAccessTokenHash || !config.apns) return skipped;
      const now = yield* DateTime.now;
      const result = yield* apns.sendPushNotificationRequest({
        credentials: {
          ...config.apns,
          bundleId: device.bundleId ?? config.apns.bundleId,
          environment: device.apsEnvironment ?? config.apns.environment,
        },
        request: {
          token: job.target.token,
          priority: "5",
          pushType: "widgets",
          payload: { aps: { "content-changed": true } },
        },
        issuedAtUnixSeconds: Math.floor(now.epochMilliseconds / 1000),
      });
      if (
        result.status === 410 ||
        result.reason === "BadDeviceToken" ||
        result.reason === "Unregistered"
      ) {
        yield* db
          .update(relayMobileDevices)
          .set({ widgetPushToken: null })
          .where(
            and(
              eq(relayMobileDevices.userId, device.userId),
              eq(relayMobileDevices.deviceId, device.deviceId),
              eq(relayMobileDevices.widgetPushToken, job.target.token),
            ),
          )
          .pipe(persistenceError("invalidate-push-token"));
      } else if (!result.ok) {
        return yield* new ApnsClient.ApnsHttpRequestError({
          requestKind: "push-notification",
          event: null,
          environment: device.apsEnvironment ?? config.apns.environment,
          bundleId: device.bundleId ?? config.apns.bundleId,
          tokenSuffix: job.target.token.slice(-8),
          stage: "send",
          status: result.status,
          cause: result.reason,
        });
      }
      return {
        ...skipped,
        ok: result.ok,
        apnsStatus: result.status,
        apnsReason: result.reason ?? null,
        apnsId: result.apnsId,
      };
    }),
  });
});

export const layer = Layer.effect(AgentWidgetRefresh, make);
