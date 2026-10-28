import * as AgentActivityAlerts from "./agentActivityAlerts.ts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  makeApnsDeliveryJobPayload,
  signApnsDeliveryJob,
  type SignedApnsDeliveryJob,
} from "./apnsDeliveryJobs.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import * as ApnsClient from "./ApnsClient.ts";
import * as ApnsProviderTokens from "./ApnsProviderTokens.ts";

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
    ...config.apns!,
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
  bundle_id: null,
  aps_environment: null,
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

function layerFor(input: {
  readonly attempts: Array<DeliveryAttempts.DeliveryAttemptInput>;
  readonly sourceJobClaims?: ReadonlyMap<string, DeliveryAttempts.DeliverySourceJobClaimResult>;
  readonly queuedJobs?: Array<SignedApnsDeliveryJob>;
  readonly markedDeliveries?: Array<
    Parameters<LiveActivities.LiveActivities["Service"]["markDelivery"]>[0]
  >;
  readonly invalidatedTokens?: Array<
    Parameters<LiveActivities.LiveActivities["Service"]["invalidateDeliveryToken"]>[0]
  >;
  readonly currentTargets?: ReadonlyArray<LiveActivities.TargetRow>;
  readonly config?: RelayConfiguration.RelayConfiguration["Service"];
  readonly activityStates?: ReadonlyArray<RelayAgentActivityState>;
  readonly currentActivityStates?: ReadonlyArray<RelayAgentActivityState>;
  readonly execute?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
}) {
  return ApnsDeliveries.layer.pipe(
    Layer.provide(ApnsClient.layer),
    Layer.provide(ApnsProviderTokens.layer),
    Layer.provide(ApnsDeliveryQueue.layer.pipe(Layer.provide(NodeCryptoLayer.layer))),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentActivityRows.AgentActivityRows, {
          upsert: () => Effect.void,
          remove: () => Effect.void,
          pruneTerminal: () => Effect.void,
          listForUser: () =>
            input.activityStates !== undefined
              ? Effect.succeed([...input.activityStates])
              : Effect.succeed([state]),
          getForUserThread: ({ environmentId, threadId }) =>
            Effect.succeed(
              (input.currentActivityStates ?? input.activityStates ?? [state]).find(
                (current) =>
                  current.environmentId === environmentId && current.threadId === threadId,
              ) ?? null,
            ),
        } satisfies AgentActivityRows.AgentActivityRows["Service"]),
        Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
          send: (body) =>
            Effect.sync(() => {
              input.queuedJobs?.push(body);
            }),
        }),
        Layer.succeed(DeliveryAttempts.DeliveryAttempts, {
          pruneExpired: Effect.succeed(0),
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
          listIdleArmedTargets: () => Effect.succeed([]),
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
  it.effect("queues bounded Live Activity aggregate payloads", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const longTitle = "x".repeat(300);
    const inputAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      title: longTitle,
      subtitle: longTitle,
      activities: [0, 1, 2, 3, 4, 5].map((index) =>
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
        target,
        aggregate: inputAggregate,
        nowMs: 10_000,
      });

      const payloadAggregate = queuedJobs[0]?.payload.aggregate;
      expect(payloadAggregate?.title.length).toBeLessThanOrEqual(120);
      expect(payloadAggregate?.subtitle.length).toBeLessThanOrEqual(120);
      expect(payloadAggregate?.activities).toHaveLength(5);
      expect(payloadAggregate?.activities[0]?.projectTitle.length).toBeLessThanOrEqual(120);
      expect(payloadAggregate?.activities[0]?.status.length).toBeLessThanOrEqual(40);
      expect(payloadAggregate?.activities[0]?.deepLink).toBe("/");
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(layerFor({ attempts, queuedJobs })));
  });

  it.effect.each([
    {
      label: "connecting becomes working",
      previousRows: [{ ...aggregate.activities[0]!, phase: "starting", status: "Connecting" }],
    },
    {
      label: "input resumes working",
      previousRows: [{ ...aggregate.activities[0]!, phase: "waiting_for_input", status: "Input" }],
    },
    {
      label: "a settled terminal row leaves",
      previousRows: [
        aggregate.activities[0]!,
        {
          ...aggregate.activities[0]!,
          threadId: ThreadId.make("finished"),
          phase: "completed",
          status: "Done",
        },
      ],
    },
    {
      label: "the same thread id moves to another environment",
      previousRows: [
        { ...aggregate.activities[0]!, environmentId: EnvironmentId.make("other-env") },
      ],
    },
  ] as const)("queues an update inside the throttle window when $label", ({ previousRows }) => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const previousAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      activities: previousRows,
    };

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {
          ...target,
          last_aggregate_json: JSON.stringify(previousAggregate),
          last_live_activity_delivery_at: "1970-01-01T00:00:04.000Z",
        },
        aggregate,
        nowMs: 5_000,
      });

      expect(result?.kind).toBe("live_activity_update");
      expect(queuedJobs).toMatchObject([{ payload: { kind: "live_activity_update", aggregate } }]);
      expect(queuedJobs[0]?.payload.alert ?? null).toBeNull();
      expect(attempts).toEqual([]);
    }).pipe(Effect.provide(layerFor({ attempts, queuedJobs })));
  });

  it.effect.each([
    { label: "inside", nowMs: 5_000, queued: false },
    { label: "after", nowMs: 19_000, queued: true },
  ])("throttles timestamp-only updates $label the window", ({ nowMs, queued }) => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const queuedJobs: Array<SignedApnsDeliveryJob> = [];
    const changedAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      updatedAt: "1970-01-01T00:00:04.000Z",
      activities: [{ ...aggregate.activities[0]!, updatedAt: "1970-01-01T00:00:04.000Z" }],
    };
    const previousAggregateJson = JSON.stringify(aggregate);

    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: {
          ...target,
          last_aggregate_json: previousAggregateJson,
          last_live_activity_delivery_at: "1970-01-01T00:00:04.000Z",
        },
        aggregate: changedAggregate,
        nowMs,
      });

      expect(result?.kind ?? null).toBe(queued ? "live_activity_update" : null);
      expect(queuedJobs).toHaveLength(queued ? 1 : 0);
    }).pipe(Effect.provide(layerFor({ attempts, queuedJobs })));
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
                phase: "waiting_for_input",
                updatedAt: state.updatedAt,
              },
            },
          },
        ]);
        expect(attempts).toEqual([]);
      }).pipe(Effect.provide(layerFor({ attempts, queuedJobs })));
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
    }).pipe(Effect.provide(layerFor({ attempts, queuedJobs })));
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
      }).pipe(Effect.provide(layerFor({ attempts, queuedJobs })));
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
    }).pipe(Effect.provide(layerFor({ attempts, queuedJobs })));
  });

  it.effect.each([
    { phase: "running", updatedAt: state.updatedAt, disabled: false, sends: false },
    { phase: "completed", updatedAt: state.updatedAt, disabled: false, sends: false },
    { phase: "completed", updatedAt: "1969-12-31T23:44:00.000Z", disabled: false, sends: true },
    { phase: "running", updatedAt: state.updatedAt, disabled: true, sends: true },
  ] as const)(
    "rechecks a queued contentless end: $phase at $updatedAt, disabled=$disabled",
    ({ phase, updatedAt, disabled, sends }) => {
      const requests: HttpClientRequest.HttpClientRequest[] = [];
      const signedEnd = signApnsDeliveryJob({
        secret: config.apnsDeliveryJobSigningSecret,
        payload: makeApnsDeliveryJobPayload({
          kind: "live_activity_end",
          userId: target.user_id,
          deviceId: target.device_id,
          token: "activity-token",
          aggregate: null,
          createdAt: state.updatedAt,
          expiresAt: "1970-01-01T00:10:00.000Z",
          jobId: "job-end-1",
        }),
      });
      return Effect.gen(function* () {
        const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
        const result = yield* deliveries.processSignedJob(signedEnd);
        expect(result.ok).toBe(true);
        expect(requests).toHaveLength(sends ? 1 : 0);
        if (sends) {
          const request = requests[0]!;
          expect(request.url).toBe("https://api.sandbox.push.apple.com/3/device/activity-token");
          expect(request.body._tag).toBe("Uint8Array");
          if (request.body._tag === "Uint8Array") {
            const { aps } = JSON.parse(new TextDecoder().decode(request.body.body));
            expect(aps.event).toBe("end");
            expect(aps.alert).toBeUndefined();
            expect(aps.sound).toBeUndefined();
          }
        }
      }).pipe(
        Effect.provide(
          layerFor({
            attempts: [],
            config: signingConfig,
            currentTargets: [
              { ...target, preferences_json: disabled ? disabledPreferences : enabledPreferences },
            ],
            activityStates: [{ ...state, phase, updatedAt }],
            execute: (request) =>
              Effect.sync(() => {
                requests.push(request);
                return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
              }),
          }),
        ),
      );
    },
  );

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
        layerFor({
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
        layerFor({
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
        layerFor({
          attempts,
          config: signingConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("skips a queued Done Live Activity update after the thread resumes working", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    let executeCount = 0;
    const completedAt = "1970-01-01T00:00:01.000Z";
    const completedAggregate: RelayAgentActivityAggregateState = {
      ...aggregate,
      activeCount: 0,
      updatedAt: completedAt,
      activities: [
        {
          ...aggregate.activities[0]!,
          phase: "completed",
          status: "Done",
          updatedAt: completedAt,
        },
      ],
    };
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_update",
      userId: target.user_id,
      deviceId: target.device_id,
      token: target.activity_push_token ?? "activity-token",
      aggregate: completedAggregate,
      alert: { title: "Thread", body: "Done: Project" },
      createdAt: completedAt,
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-update-superseded-by-running",
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
          sourceJobId: "job-update-superseded-by-running",
          apnsReason: "Stale agent activity state skipped.",
        },
      ]);
    }).pipe(
      Effect.provide(
        layerFor({
          attempts,
          activityStates: [
            {
              ...state,
              phase: "running",
              headline: "Running",
              updatedAt: "1970-01-01T00:00:02.000Z",
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
        layerFor({
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
      Parameters<LiveActivities.LiveActivities["Service"]["invalidateDeliveryToken"]>[0]
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
        layerFor({
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

  it.effect("invalidates dead Live Activity tokens after APNs unregisters them", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const invalidatedTokens: Array<
      Parameters<LiveActivities.LiveActivities["Service"]["invalidateDeliveryToken"]>[0]
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
      Effect.provide(layerFor({ attempts, invalidatedTokens, config: signingConfig, execute })),
    );
  });
});

describe("live activity alert decisions", () => {
  const preferences = {
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  };

  const attentionRow = {
    ...aggregate.activities[0]!,
    threadId: "thread-2" as RelayAgentActivityState["threadId"],
    threadTitle: "Blocked thread",
    phase: "waiting_for_approval" as const,
    status: "Approval",
  };

  it("alerts when a thread newly enters an attention phase", () => {
    const alert = AgentActivityAlerts.alertForAttentionTransition({
      previousAggregate: aggregate,
      nextAggregate: {
        ...aggregate,
        activeCount: 2,
        activities: [...aggregate.activities, attentionRow],
      },
      preferences,
    });
    expect(alert).toEqual({ title: "Blocked thread", body: "Approval: Project" });
  });

  it("stays silent without a delivered baseline so replays cannot buzz", () => {
    expect(
      AgentActivityAlerts.alertForAttentionTransition({
        previousAggregate: null,
        nextAggregate: { ...aggregate, activities: [attentionRow] },
        preferences,
      }),
    ).toBeNull();
  });

  it("alerts when a previously active thread finishes mid-flight", () => {
    const doneRow = {
      ...aggregate.activities[0]!,
      phase: "completed" as const,
      status: "Done",
    };
    const next = {
      ...aggregate,
      activeCount: 0,
      activities: [attentionRow, doneRow],
    };
    expect(
      AgentActivityAlerts.alertForNewlyTerminal({
        previousAggregate: aggregate,
        nextAggregate: next,
        preferences,
        nowMs: 0,
      }),
    ).toEqual({ title: "Thread", body: "Done: Project" });
    expect(
      AgentActivityAlerts.alertForNewlyTerminal({
        previousAggregate: aggregate,
        nextAggregate: next,
        preferences: { ...preferences, notifyOnCompletion: false },
        nowMs: 0,
      }),
    ).toBeNull();
    expect(
      AgentActivityAlerts.alertForNewlyTerminal({
        previousAggregate: null,
        nextAggregate: next,
        preferences,
        nowMs: 0,
      }),
    ).toBeNull();
    expect(
      AgentActivityAlerts.alertForNewlyTerminal({
        previousAggregate: next,
        nextAggregate: next,
        preferences,
        nowMs: 0,
      }),
    ).toBeNull();
    expect(
      AgentActivityAlerts.alertForNewlyTerminal({
        previousAggregate: { ...aggregate, activities: [attentionRow] },
        nextAggregate: next,
        preferences,
        nowMs: 0,
      }),
    ).toBeNull();
  });
});

describe("fast completion delivery", () => {
  it.effect("keeps a completion alert when work finishes before running delivery", () => {
    const queuedJobs: SignedApnsDeliveryJob[] = [];
    const old = {
      ...aggregate,
      activeCount: 0,
      activities: [
        {
          ...aggregate.activities[0]!,
          threadId: "old" as RelayAgentActivityState["threadId"],
          phase: "completed" as const,
        },
      ],
    };
    const device = { ...target, last_aggregate_json: JSON.stringify(old) };
    const done = {
      ...aggregate,
      activeCount: 0,
      activities: [{ ...aggregate.activities[0]!, phase: "completed" as const }],
    };
    return Effect.gen(function* () {
      const d = yield* ApnsDeliveries.ApnsDeliveries;
      yield* d.sendForTarget({ target: device, aggregate, nowMs: 0 });
      yield* d.sendForTarget({ target: device, aggregate: done, nowMs: 0 });
      expect(
        queuedJobs.some((x) => x.payload.alert !== null && x.payload.alert !== undefined),
      ).toBe(true);
    }).pipe(Effect.provide(layerFor({ attempts: [], queuedJobs, currentTargets: [device] })));
  });
  it.effect("replays a newly visible completion without alerting", () => {
    const queuedJobs: SignedApnsDeliveryJob[] = [];
    const done = {
      ...aggregate,
      activeCount: 0,
      activities: [{ ...aggregate.activities[0]!, phase: "completed" as const }],
    };
    const previous = {
      ...aggregate,
      activities: [
        { ...aggregate.activities[0]!, threadId: "other" as RelayAgentActivityState["threadId"] },
      ],
    };
    const device = { ...target, last_aggregate_json: JSON.stringify(previous) };
    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      yield* deliveries.sendForTarget({
        target: device,
        aggregate: done,
        nowMs: 0,
        replay: true,
      });
      expect(queuedJobs).toHaveLength(1);
      expect(queuedJobs[0]?.payload.alert).toBeUndefined();
    }).pipe(Effect.provide(layerFor({ attempts: [], queuedJobs })));
  });
});

describe("signed APNs registration metadata", () => {
  it.effect.each(
    (["live_activity_update", "push_notification"] as const).flatMap((kind) =>
      (["bundle", "environment", "legacy"] as const).map((changed) => ({ kind, changed })),
    ),
  )("routes $kind using current registration with $changed job metadata", ({ kind, changed }) => {
    const attempts: DeliveryAttempts.DeliveryAttemptInput[] = [];
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const payload = makeApnsDeliveryJobPayload({
      kind,
      userId: target.user_id,
      deviceId: target.device_id,
      token: "unchanged-token",
      ...(changed === "legacy"
        ? {}
        : { bundleId: "com.t3tools.t3code.dev", apsEnvironment: "sandbox" as const }),
      aggregate: kind === "live_activity_update" ? aggregate : null,
      ...(kind === "push_notification"
        ? {
            notification: {
              title: "Thread",
              body: "Input: Project",
              environmentId: "env",
              threadId: "thread",
              deepLink: "/",
            },
          }
        : {}),
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: `metadata-${kind}-${changed}`,
    });
    const signed = signApnsDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload,
    });
    return Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
      const result = yield* deliveries.processSignedJob(signed);
      expect(result.ok).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(
        `${changed === "environment" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com"}/3/device/unchanged-token`,
      );
      expect(requests[0]?.headers["apns-topic"]).toBe(
        `${changed === "bundle" ? "com.t3tools.t3code.preview" : "com.t3tools.t3code.dev"}${kind === "live_activity_update" ? ".push-type.liveactivity" : ""}`,
      );
    }).pipe(
      Effect.provide(
        layerFor({
          attempts,
          config: signingConfig,
          currentTargets: [
            {
              ...target,
              push_token: "unchanged-token",
              activity_push_token: "unchanged-token",
              bundle_id:
                changed === "bundle" ? "com.t3tools.t3code.preview" : "com.t3tools.t3code.dev",
              aps_environment: changed === "environment" ? "production" : "sandbox",
            },
          ],
          execute: (request) =>
            Effect.sync(() => {
              requests.push(request);
              return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
            }),
        }),
      ),
    );
  });
});
