import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  makeApnsDeliveryJobPayload,
  signApnsDeliveryJob,
  type SignedApnsDeliveryJob,
} from "./apnsDeliveryJobs.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import * as ApnsClient from "./ApnsClient.ts";

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("not-a-private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-signing-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make("cloud-private-key"),
  cloudMintPublicKey: "cloud-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});

const apnsSigningKeyPair = NodeCrypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const signingConfig = RelayConfiguration.RelayConfiguration.of({
  ...config,
  apns: {
    ...config.apns,
    privateKey: Redacted.make(apnsSigningKeyPair.privateKey),
  },
});

const state: RelayAgentActivityState = {
  environmentId: "env" as RelayAgentActivityState["environmentId"],
  threadId: "thread" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/",
};

const aggregate: RelayAgentActivityAggregateState = {
  title: "T3 Code",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: state.updatedAt,
  activities: [
    {
      environmentId: state.environmentId,
      threadId: state.threadId,
      projectTitle: state.projectTitle,
      threadTitle: state.threadTitle,
      modelTitle: state.modelTitle,
      phase: state.phase,
      status: "Working",
      updatedAt: state.updatedAt,
      deepLink: state.deepLink,
    },
  ],
};

const enabledPreferences = JSON.stringify({
  liveActivitiesEnabled: true,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
});

const disabledPreferences = JSON.stringify({
  liveActivitiesEnabled: false,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
});

const notificationsDisabledPreferences = JSON.stringify({
  liveActivitiesEnabled: false,
  notificationsEnabled: false,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
});

const target: LiveActivities.TargetRow = {
  user_id: "dev:julius",
  device_id: "device-1",
  platform: "ios",
  ios_major_version: 18,
  app_version: "1.0.0",
  push_token: null,
  push_to_start_token: "start-token",
  preferences_json: enabledPreferences,
  activity_push_token: "activity-token",
  remote_start_queued_at: null,
  remote_started_at: "1970-01-01T00:00:00.000Z",
  ended_at: null,
  last_aggregate_json: null,
  last_live_activity_delivery_at: null,
};

function makeLayer(input: {
  readonly attempts: Array<DeliveryAttempts.DeliveryAttemptInput>;
  readonly sourceJobClaims?: ReadonlyMap<string, DeliveryAttempts.DeliverySourceJobClaimResult>;
  readonly queuedJobs?: Array<SignedApnsDeliveryJob>;
  readonly queuedStarts?: Array<
    Parameters<LiveActivities.LiveActivitiesShape["markStartQueued"]>[0]
  >;
  readonly clearedStarts?: Array<
    Parameters<LiveActivities.LiveActivitiesShape["clearStartQueued"]>[0]
  >;
  readonly markedDeliveries?: Array<
    Parameters<LiveActivities.LiveActivitiesShape["markDelivery"]>[0]
  >;
  readonly invalidatedTokens?: Array<
    Parameters<LiveActivities.LiveActivitiesShape["invalidateDeliveryToken"]>[0]
  >;
  readonly currentTargets?: ReadonlyArray<LiveActivities.TargetRow>;
  readonly config?: RelayConfiguration.RelayConfiguration["Service"];
  readonly execute?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
}) {
  return ApnsDeliveries.layer.pipe(
    Layer.provide(ApnsClient.layer),
    Layer.provide(ApnsDeliveryQueue.layer.pipe(Layer.provide(NodeCryptoLayer.layer))),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
          send: (body) =>
            Effect.sync(() => {
              input.queuedJobs?.push(body);
            }),
        }),
        Layer.succeed(DeliveryAttempts.DeliveryAttempts, {
          record: (attempt) =>
            Effect.sync(() => {
              input.attempts.push(attempt);
            }),
          claimSourceJob: (attempt) =>
            Effect.sync(() => {
              const claim = input.sourceJobClaims?.get(attempt.sourceJobId);
              if (claim) {
                return claim;
              }
              input.attempts.push(attempt);
              return "claimed";
            }),
          completeSourceJob: (completion) =>
            Effect.sync(() => {
              const attempt = input.attempts.find(
                (row) => row.sourceJobId === completion.sourceJobId,
              );
              if (attempt) {
                Object.assign(attempt, completion);
              }
            }),
        }),
        Layer.succeed(LiveActivities.LiveActivities, {
          register: () => Effect.void,
          listTargets: () => Effect.succeed(input.currentTargets ?? [target]),
          markStartQueued: (queued) =>
            Effect.sync(() => {
              input.queuedStarts?.push(queued);
            }),
          clearStartQueued: (cleared) =>
            Effect.sync(() => {
              input.clearedStarts?.push(cleared);
            }),
          markDelivery: (delivery) =>
            Effect.sync(() => {
              input.markedDeliveries?.push(delivery);
            }),
          invalidateDeliveryToken: (invalidated) =>
            Effect.sync(() => {
              input.invalidatedTokens?.push(invalidated);
            }),
        }),
        RelayConfiguration.layer(input.config ?? config),
        input.execute
          ? Layer.succeed(HttpClient.HttpClient, HttpClient.make(input.execute))
          : FetchHttpClient.layer,
      ),
    ),
  );
}

describe("ApnsDeliveries", () => {
  it.effect("queues a restart using the push-to-start token", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const queuedStarts: Array<
      Parameters<LiveActivities.LiveActivitiesShape["markStartQueued"]>[0]
    > = [];
    const markedDeliveries: Array<
      Parameters<LiveActivities.LiveActivitiesShape["markDelivery"]>[0]
    > = [];

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {
          ...target,
          ended_at: "1970-01-01T00:00:05.000Z",
        },
        aggregate,
        nowMs: 10_000,
      });

      expect(result?.kind).toBe("live_activity_start");
      expect(result?.ok).toBe(true);
      expect(queuedJobs).toMatchObject([
        {
          payload: {
            kind: "live_activity_start",
            target: {
              token: "start-token",
            },
          },
        },
      ]);
      expect(attempts).toEqual([]);
      expect(queuedStarts).toMatchObject([
        {
          userId: target.user_id,
          deviceId: target.device_id,
        },
      ]);
      expect(markedDeliveries).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs, queuedStarts, markedDeliveries })));
  });

  it.effect("queues an end using the activity token", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target,
        aggregate: null,
        nowMs: 5_000,
      });

      expect(result?.kind).toBe("live_activity_end");
      expect(result?.ok).toBe(true);
      expect(queuedJobs).toMatchObject([
        {
          payload: {
            kind: "live_activity_end",
            target: {
              token: "activity-token",
            },
          },
        },
      ]);
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
  });

  it.effect("does not queue a remote start when Live Activities are disabled", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {
          ...target,
          activity_push_token: null,
          remote_started_at: null,
          ended_at: null,
          preferences_json: disabledPreferences,
        },
        aggregate,
        nowMs: 5_000,
      });

      expect(result).toBeNull();
      expect(queuedJobs).toEqual([]);
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
  });

  it.effect("does not queue a duplicate remote start while a start is already queued", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {
          ...target,
          activity_push_token: null,
          remote_start_queued_at: "1970-01-01T00:00:03.000Z",
          remote_started_at: null,
          ended_at: null,
        },
        aggregate,
        nowMs: 5_000,
      });

      expect(result).toBeNull();
      expect(queuedJobs).toEqual([]);
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
  });

  it.effect("queues bounded Live Activity aggregate payloads", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const longTitle = "x".repeat(300);
    const inputAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      title: longTitle,
      subtitle: longTitle,
      activities: [0, 1, 2, 3].map((index) =>
        Object.assign({}, aggregate.activities[0]!, {
          projectTitle: longTitle,
          threadTitle: longTitle,
          modelTitle: longTitle,
          status: longTitle,
          threadId: `thread-${index}` as RelayAgentActivityState["threadId"],
          deepLink: "https://example.test/not-an-app-link",
        }),
      ),
    };

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.sendForTarget({
        target: {
          ...target,
          activity_push_token: null,
          remote_started_at: null,
          ended_at: "1970-01-01T00:00:05.000Z",
        },
        aggregate: inputAggregate,
        nowMs: 10_000,
      });

      const payloadAggregate = queuedJobs[0]?.payload.aggregate;
      expect(payloadAggregate?.title.length).toBeLessThanOrEqual(120);
      expect(payloadAggregate?.subtitle.length).toBeLessThanOrEqual(120);
      expect(payloadAggregate?.activities).toHaveLength(3);
      expect(payloadAggregate?.activities[0]?.projectTitle.length).toBeLessThanOrEqual(120);
      expect(payloadAggregate?.activities[0]?.status.length).toBeLessThanOrEqual(40);
      expect(payloadAggregate?.activities[0]?.deepLink).toBe("/");
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
  });

  it.effect("queues an end for an active Live Activity when Live Activities are disabled", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {
          ...target,
          preferences_json: disabledPreferences,
        },
        aggregate,
        nowMs: 5_000,
      });

      expect(result?.kind).toBe("live_activity_end");
      expect(queuedJobs).toMatchObject([
        {
          payload: {
            kind: "live_activity_end",
            target: {
              token: "activity-token",
            },
          },
        },
      ]);
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
  });

  it.effect(
    "queues an alert while ending an active Live Activity when only Live Activities are disabled",
    () => {
      const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
      const queuedJobs: Array<SignedApnsDeliveryJob> = [];
      const inputAggregate: RelayAgentActivityAggregateState = {
        ...aggregate,
        activities: [
          {
            ...aggregate.activities[0]!,
            phase: "waiting_for_input",
            status: "Input",
          },
        ],
      };

      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        const result = yield* deliveries.sendForTarget({
          target: {
            ...target,
            push_token: "apns-device-token",
            preferences_json: disabledPreferences,
          },
          aggregate: inputAggregate,
          nowMs: 5_000,
        });

        expect(result?.kind).toBe("live_activity_end");
        expect(queuedJobs).toMatchObject([
          {
            payload: {
              kind: "live_activity_end",
              target: {
                token: "activity-token",
              },
            },
          },
          {
            payload: {
              kind: "push_notification",
              target: {
                token: "apns-device-token",
              },
              notification: {
                title: "Thread",
                body: "Input: Project",
                environmentId: "env",
                threadId: "thread",
                deepLink: "/",
              },
            },
          },
        ]);
        expect(attempts).toEqual([]);
      }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
    },
  );

  it.effect("does not queue alert pushes when notification permission is disabled", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const inputAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      activities: [
        {
          ...aggregate.activities[0]!,
          phase: "waiting_for_input",
          status: "Input",
        },
      ],
    };

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {
          ...target,
          push_token: "apns-device-token",
          preferences_json: notificationsDisabledPreferences,
        },
        aggregate: inputAggregate,
        nowMs: 5_000,
      });

      expect(result?.kind).toBe("live_activity_end");
      expect(queuedJobs).toMatchObject([
        {
          payload: {
            kind: "live_activity_end",
            target: {
              token: "activity-token",
            },
          },
        },
      ]);
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
  });

  it.effect(
    "queues a push notification for approval and input states when no Live Activity delivery is available",
    () => {
      const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
      const queuedJobs: Array<SignedApnsDeliveryJob> = [];
      const inputAggregate: RelayAgentActivityAggregateState = {
        ...aggregate,
        activities: [
          {
            ...aggregate.activities[0]!,
            phase: "waiting_for_input",
            status: "Input",
          },
        ],
      };

      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        const result = yield* deliveries.sendForTarget({
          target: {
            ...target,
            push_token: "apns-device-token",
            push_to_start_token: null,
            activity_push_token: null,
            remote_started_at: null,
          },
          aggregate: inputAggregate,
          nowMs: 5_000,
        });

        expect(result?.kind).toBe("push_notification");
        expect(result?.ok).toBe(true);
        expect(queuedJobs).toMatchObject([
          {
            payload: {
              kind: "push_notification",
              target: {
                token: "apns-device-token",
              },
              notification: {
                title: "Thread",
                body: "Input: Project",
                environmentId: "env",
                threadId: "thread",
                deepLink: "/",
              },
            },
          },
        ]);
        expect(attempts).toEqual([]);
      }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
    },
  );

  it.effect("queues bounded alert notification payloads", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const longTitle = "x".repeat(300);
    const inputAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      activities: [
        {
          ...aggregate.activities[0]!,
          projectTitle: longTitle,
          threadTitle: longTitle,
          phase: "waiting_for_input",
          status: "Input",
          deepLink: "https://example.test/not-an-app-link",
        },
      ],
    };

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.sendForTarget({
        target: {
          ...target,
          push_token: "apns-device-token",
          push_to_start_token: null,
          activity_push_token: null,
          remote_started_at: null,
        },
        aggregate: inputAggregate,
        nowMs: 5_000,
      });

      const notification = queuedJobs[0]?.payload.notification;
      expect(notification?.title.length).toBeLessThanOrEqual(120);
      expect(notification?.body.length).toBeLessThanOrEqual(120);
      expect(notification?.deepLink).toBe("/");
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ attempts, queuedJobs })));
  });

  it.effect("processes signed jobs through APNs and records attempts", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_update",
      userId: target.user_id,
      deviceId: target.device_id,
      token: target.activity_push_token ?? "activity-token",
      aggregate,
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-1",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result.kind).toBe("live_activity_update");
      expect(result.ok).toBe(false);
      expect(attempts).toMatchObject([
        {
          kind: "live_activity_update",
          sourceJobId: "job-1",
          token: "activity-token",
        },
      ]);
    }).pipe(Effect.provide(makeLayer({ attempts })));
  });

  it.effect("processes signed push notification jobs through APNs and records attempts", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const payload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "apns-device-token",
      aggregate: null,
      notification: {
        title: "Thread",
        body: "Input: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-push-1",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 })));

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result.kind).toBe("push_notification");
      expect(result.ok).toBe(true);
      expect(result.apnsStatus).toBe(200);
      expect(attempts).toMatchObject([
        {
          kind: "push_notification",
          sourceJobId: "job-push-1",
          token: "apns-device-token",
          environmentId: "env",
          threadId: "thread",
          deviceId: target.device_id,
          apnsStatus: 200,
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          currentTargets: [
            {
              ...target,
              push_token: "apns-device-token",
            },
          ],
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("skips duplicate signed queue jobs before calling APNs", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    let executeCount = 0;
    const payload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "apns-device-token",
      aggregate: null,
      notification: {
        title: "Thread",
        body: "Input: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-push-duplicate",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        executeCount += 1;
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result).toMatchObject({
        kind: "push_notification",
        ok: true,
        apnsStatus: null,
        apnsReason: "Duplicate APNs delivery job skipped.",
      });
      expect(executeCount).toBe(0);
      expect(attempts).toEqual([]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          sourceJobClaims: new Map([["job-push-duplicate", "completed"]]),
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("skips stale signed Live Activity jobs when the registered token changed", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    let executeCount = 0;
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_update",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "stale-activity-token",
      aggregate,
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-update-stale-token",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        executeCount += 1;
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result).toMatchObject({
        kind: "live_activity_update",
        ok: true,
        apnsStatus: null,
        apnsReason: "Stale APNs delivery job skipped.",
      });
      expect(executeCount).toBe(0);
      expect(attempts).toMatchObject([
        {
          kind: "live_activity_update",
          sourceJobId: "job-update-stale-token",
          token: "stale-activity-token",
          apnsReason: "Stale APNs delivery job skipped.",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("skips stale signed push notification jobs when the device token changed", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    let executeCount = 0;
    const payload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "stale-device-token",
      aggregate: null,
      notification: {
        title: "Thread",
        body: "Input: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-push-stale-token",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        executeCount += 1;
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result).toMatchObject({
        kind: "push_notification",
        ok: true,
        apnsStatus: null,
        apnsReason: "Stale APNs delivery job skipped.",
      });
      expect(executeCount).toBe(0);
      expect(attempts).toMatchObject([
        {
          kind: "push_notification",
          sourceJobId: "job-push-stale-token",
          token: "stale-device-token",
          apnsReason: "Stale APNs delivery job skipped.",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          currentTargets: [
            {
              ...target,
              push_token: "current-device-token",
            },
          ],
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("retries signed queue jobs that are already claimed but not completed", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    let executeCount = 0;
    const payload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "apns-device-token",
      aggregate: null,
      notification: {
        title: "Thread",
        body: "Input: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-push-in-flight",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        executeCount += 1;
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* Effect.exit(deliveries.processSignedJob(signed));

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("ApnsDeliveryJobClaimInFlight");
      }
      expect(executeCount).toBe(0);
      expect(attempts).toEqual([]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          sourceJobClaims: new Map([["job-push-in-flight", "in_flight"]]),
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("invalidates dead device push tokens after permanent APNs alert failures", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const invalidatedTokens: Array<
      Parameters<LiveActivities.LiveActivitiesShape["invalidateDeliveryToken"]>[0]
    > = [];
    const payload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: target.user_id,
      deviceId: target.device_id,
      token: "apns-device-token",
      aggregate: null,
      notification: {
        title: "Thread",
        body: "Failed: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-push-bad-token",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ reason: "BadDeviceToken" }, { status: 400 }),
        ),
      );

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result.kind).toBe("push_notification");
      expect(result.ok).toBe(false);
      expect(result.apnsStatus).toBe(400);
      expect(result.apnsReason).toBe("BadDeviceToken");
      expect(invalidatedTokens).toMatchObject([
        {
          userId: target.user_id,
          deviceId: target.device_id,
          kind: "push_notification",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          invalidatedTokens,
          currentTargets: [
            {
              ...target,
              push_token: "apns-device-token",
            },
          ],
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("clears queued start state when a start job fails in APNs", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const clearedStarts: Array<
      Parameters<LiveActivities.LiveActivitiesShape["clearStartQueued"]>[0]
    > = [];
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_start",
      userId: target.user_id,
      deviceId: target.device_id,
      token: target.push_to_start_token ?? "start-token",
      aggregate,
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-start-1",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result.kind).toBe("live_activity_start");
      expect(result.ok).toBe(false);
      expect(clearedStarts).toEqual([
        {
          userId: target.user_id,
          deviceId: target.device_id,
        },
      ]);
    }).pipe(Effect.provide(makeLayer({ attempts, clearedStarts })));
  });

  it.effect("invalidates dead push-to-start tokens after permanent APNs start failures", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const invalidatedTokens: Array<
      Parameters<LiveActivities.LiveActivitiesShape["invalidateDeliveryToken"]>[0]
    > = [];
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_start",
      userId: target.user_id,
      deviceId: target.device_id,
      token: target.push_to_start_token ?? "start-token",
      aggregate,
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-start-bad-token",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ reason: "BadDeviceToken" }, { status: 400 }),
        ),
      );

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result.kind).toBe("live_activity_start");
      expect(result.ok).toBe(false);
      expect(result.apnsStatus).toBe(400);
      expect(result.apnsReason).toBe("BadDeviceToken");
      expect(invalidatedTokens).toMatchObject([
        {
          userId: target.user_id,
          deviceId: target.device_id,
          kind: "live_activity_start",
        },
      ]);
    }).pipe(
      Effect.provide(makeLayer({ attempts, invalidatedTokens, config: signingConfig, execute })),
    );
  });

  it.effect("invalidates dead Live Activity tokens after APNs unregisters them", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const invalidatedTokens: Array<
      Parameters<LiveActivities.LiveActivitiesShape["invalidateDeliveryToken"]>[0]
    > = [];
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_update",
      userId: target.user_id,
      deviceId: target.device_id,
      token: target.activity_push_token ?? "activity-token",
      aggregate,
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-update-unregistered",
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ reason: "Unregistered" }, { status: 410 }),
        ),
      );

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result.kind).toBe("live_activity_update");
      expect(result.ok).toBe(false);
      expect(result.apnsStatus).toBe(410);
      expect(result.apnsReason).toBe("Unregistered");
      expect(invalidatedTokens).toMatchObject([
        {
          userId: target.user_id,
          deviceId: target.device_id,
          kind: "live_activity_update",
        },
      ]);
    }).pipe(
      Effect.provide(makeLayer({ attempts, invalidatedTokens, config: signingConfig, execute })),
    );
  });
});
