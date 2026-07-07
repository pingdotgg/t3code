import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
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

import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as Devices from "./Devices.ts";
import {
  makeFcmDeliveryJobPayload,
  signFcmDeliveryJob,
  type SignedFcmDeliveryJob,
} from "./fcmDeliveryJobs.ts";
import * as FcmDeliveryQueue from "./FcmDeliveryQueue.ts";
import * as FcmClient from "./FcmClient.ts";
import * as FcmDeliveries from "./FcmDeliveries.ts";
import * as LiveActivities from "./LiveActivities.ts";
import type { AndroidMobileTarget } from "./mobileTargets.ts";
import { testRelayConfiguration } from "../testRelayConfiguration.ts";
import * as RelayConfiguration from "../Config.ts";

const config = testRelayConfiguration({
  fcm: null,
  fcmDeliveryEnabled: false,
  fcmDeliveryJobSigningSecret: Redacted.make("fcm-job-secret"),
});

const fcmSigningKeyPair = NodeCrypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const enabledFcmConfig = RelayConfiguration.RelayConfiguration.of({
  ...config,
  fcmDeliveryEnabled: true,
  fcm: {
    projectId: "fcm-project",
    clientEmail: "firebase-adminsdk@test.iam.gserviceaccount.com",
    privateKey: Redacted.make(fcmSigningKeyPair.privateKey),
  },
});

const preferences = JSON.stringify({
  liveActivitiesEnabled: false,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
});

const androidTarget: AndroidMobileTarget = {
  user_id: "dev:julius",
  device_id: "android-device-1",
  platform: "android",
  push_token: "fcm-device-token",
  preferences_json: preferences,
};

const aggregate: RelayAgentActivityAggregateState = {
  title: "T3 Code",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: "1970-01-01T00:00:00.000Z",
  activities: [
    {
      environmentId:
        "env" as RelayAgentActivityAggregateState["activities"][number]["environmentId"],
      threadId: "thread" as RelayAgentActivityAggregateState["activities"][number]["threadId"],
      projectTitle: "Project",
      threadTitle: "Thread",
      modelTitle: "gpt-5.4",
      phase: "waiting_for_input",
      status: "Input",
      updatedAt: "1970-01-01T00:00:00.000Z",
      deepLink: "/",
    },
  ],
};

function makeLayer(input: {
  readonly attempts?: Array<DeliveryAttempts.DeliveryAttemptInput>;
  readonly queuedJobs?: Array<SignedFcmDeliveryJob>;
  readonly invalidatedTokens?: Array<
    Parameters<LiveActivities.LiveActivities["Service"]["invalidateDeliveryToken"]>[0]
  >;
  readonly currentAndroidTargets?: ReadonlyArray<AndroidMobileTarget>;
  readonly sourceJobClaims?: ReadonlyMap<string, DeliveryAttempts.DeliverySourceJobClaimResult>;
  readonly config?: RelayConfiguration.RelayConfiguration["Service"];
  readonly execute?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
}) {
  return FcmDeliveries.layer.pipe(
    Layer.provide(FcmClient.layer),
    Layer.provide(FcmDeliveryQueue.layer.pipe(Layer.provide(NodeCryptoLayer.layer))),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(FcmDeliveryQueue.FcmDeliveryQueueSender, {
          send: (body) =>
            Effect.sync(() => {
              input.queuedJobs?.push(body);
            }),
        }),
        Layer.succeed(DeliveryAttempts.DeliveryAttempts, {
          record: (attempt) =>
            Effect.sync(() => {
              input.attempts?.push(attempt);
            }),
          claimSourceJob: (attempt) =>
            Effect.sync(() => {
              const claim = input.sourceJobClaims?.get(attempt.sourceJobId);
              if (claim) {
                return claim;
              }
              input.attempts?.push(attempt);
              return "claimed";
            }),
          completeSourceJob: (completion) =>
            Effect.sync(() => {
              const attempt = input.attempts?.find(
                (row) => row.sourceJobId === completion.sourceJobId,
              );
              if (attempt) {
                Object.assign(attempt, completion);
              }
            }),
        }),
        Layer.succeed(Devices.Devices, {
          register: () => Effect.void,
          unregister: () => Effect.void,
          listForUser: () => Effect.succeed([]),
          listAndroidPushTargets: () =>
            Effect.succeed(input.currentAndroidTargets ?? [androidTarget]),
        }),
        Layer.succeed(LiveActivities.LiveActivities, {
          register: () => Effect.void,
          listTargets: () => Effect.succeed([]),
          markStartQueued: () => Effect.void,
          clearStartQueued: () => Effect.void,
          markDelivery: () => Effect.void,
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
    Layer.provide(NodeCryptoLayer.layer),
  );
}

describe("FcmDeliveries", () => {
  it.effect("returns null when FCM delivery is disabled", () =>
    Effect.gen(function* () {
      const deliveries = yield* FcmDeliveries.FcmDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: androidTarget,
        aggregate,
      });

      expect(result).toBeNull();
    }).pipe(Effect.provide(makeLayer({}))),
  );

  it.effect("queues a push notification when FCM delivery is enabled", () => {
    const queuedJobs: Array<SignedFcmDeliveryJob> = [];

    return Effect.gen(function* () {
      const deliveries = yield* FcmDeliveries.FcmDeliveries;
      const result = yield* deliveries.sendForTarget({
        target: androidTarget,
        aggregate,
      });

      expect(result?.kind).toBe("push_notification");
      expect(result?.ok).toBe(true);
      expect(queuedJobs).toMatchObject([
        {
          payload: {
            kind: "push_notification",
            target: {
              token: "fcm-device-token",
            },
            notification: {
              title: "Thread",
              body: "Input: Project",
              environmentId: "env",
              threadId: "thread",
              deepLink: "/",
            },
            channelId: "agent_input",
          },
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          queuedJobs,
          config: enabledFcmConfig,
        }),
      ),
    );
  });

  it.effect("processes signed push notification jobs through FCM and records attempts", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const payload = makeFcmDeliveryJobPayload({
      userId: androidTarget.user_id,
      deviceId: androidTarget.device_id,
      token: "fcm-device-token",
      notification: {
        title: "Thread",
        body: "Input: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
      },
      channelId: "agent_input",
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-fcm-1",
    });
    const signed = signFcmDeliveryJob({
      secret: enabledFcmConfig.fcmDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) => {
      const url = request.url;
      if (url.includes("oauth2.googleapis.com/token")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ access_token: "fcm-access-token" }, { status: 200 }),
          ),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ name: "projects/fcm-project/messages/msg-1" }, { status: 200 }),
        ),
      );
    };

    return Effect.gen(function* () {
      const deliveries = yield* FcmDeliveries.FcmDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result.kind).toBe("push_notification");
      expect(result.ok).toBe(true);
      expect(result.apnsStatus).toBe(200);
      expect(result.apnsId).toBe("projects/fcm-project/messages/msg-1");
      expect(attempts).toMatchObject([
        {
          kind: "push_notification",
          sourceJobId: "job-fcm-1",
          token: "fcm-device-token",
          environmentId: "env",
          threadId: "thread",
          deviceId: androidTarget.device_id,
          apnsStatus: 200,
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          config: enabledFcmConfig,
          execute,
        }),
      ),
    );
  });

  it.effect("invalidates dead device push tokens after permanent FCM failures", () => {
    const attempts: Array<DeliveryAttempts.DeliveryAttemptInput> = [];
    const invalidatedTokens: Array<
      Parameters<LiveActivities.LiveActivities["Service"]["invalidateDeliveryToken"]>[0]
    > = [];
    const payload = makeFcmDeliveryJobPayload({
      userId: androidTarget.user_id,
      deviceId: androidTarget.device_id,
      token: "fcm-device-token",
      notification: {
        title: "Thread",
        body: "Failed: Project",
        environmentId: "env",
        threadId: "thread",
        deepLink: "/",
      },
      channelId: "agent_failed",
      createdAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:10:00.000Z",
      jobId: "job-fcm-bad-token",
    });
    const signed = signFcmDeliveryJob({
      secret: enabledFcmConfig.fcmDeliveryJobSigningSecret,
      payload,
    });
    const execute = (request: HttpClientRequest.HttpClientRequest) => {
      const url = request.url;
      if (url.includes("oauth2.googleapis.com/token")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ access_token: "fcm-access-token" }, { status: 200 }),
          ),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ error: { status: "UNREGISTERED" } }, { status: 404 }),
        ),
      );
    };

    return Effect.gen(function* () {
      const deliveries = yield* FcmDeliveries.FcmDeliveries;
      const result = yield* deliveries.processSignedJob(signed);

      expect(result.kind).toBe("push_notification");
      expect(result.ok).toBe(false);
      expect(result.apnsStatus).toBe(404);
      expect(result.apnsReason).toBe("UNREGISTERED");
      expect(invalidatedTokens).toMatchObject([
        {
          userId: androidTarget.user_id,
          deviceId: androidTarget.device_id,
          kind: "push_notification",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          attempts,
          invalidatedTokens,
          config: enabledFcmConfig,
          execute,
        }),
      ),
    );
  });
});
