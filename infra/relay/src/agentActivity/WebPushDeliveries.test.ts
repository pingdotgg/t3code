import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import { makeWebPushNotification, WebPushDeliveries, layer } from "./WebPushDeliveries.ts";
import * as WebPushSubscriptions from "./WebPushSubscriptions.ts";

const runningState: RelayAgentActivityState = {
  environmentId: "environment" as RelayAgentActivityState["environmentId"],
  threadId: "thread" as RelayAgentActivityState["threadId"],
  projectTitle: "T3 Code",
  threadTitle: "Add Web Push",
  modelTitle: "gpt-5.6",
  phase: "running",
  headline: "Working",
  updatedAt: "2026-08-12T09:00:00.000Z",
  deepLink: "/threads/environment/thread",
};

const target: WebPushSubscriptions.WebPushTarget = {
  userId: "user",
  subscriptionId: "subscription",
  endpoint: "https://push.example.test/subscription",
  expirationTime: null,
  p256dh: "p256dh",
  auth: "auth",
  preferences: {
    notifyOnApproval: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
    soundEnabled: true,
  },
};

describe("makeWebPushNotification", () => {
  it("builds the same completion copy, destination, and sound preference as desktop", () => {
    const notification = makeWebPushNotification({
      previousState: runningState,
      nextState: {
        ...runningState,
        phase: "completed",
        detail: "## Done\n\nAdded **standards-based** Web Push.",
        updatedAt: "2026-08-12T09:01:00.000Z",
      },
      target,
    });

    expect(notification).toEqual({
      version: 1,
      title: "Completed - T3 Code",
      body: "Done Added standards-based Web Push.",
      path: "/environment/thread",
      tag: "t3-agent-environment-thread",
      updatedAt: "2026-08-12T09:01:00.000Z",
      silent: false,
    });
  });

  it("does not replay terminal state observed without an active transition", () => {
    expect(
      makeWebPushNotification({
        previousState: null,
        nextState: { ...runningState, phase: "completed" },
        target,
      }),
    ).toBeNull();
  });

  it("respects event and sound preferences", () => {
    expect(
      makeWebPushNotification({
        previousState: runningState,
        nextState: { ...runningState, phase: "failed" },
        target: {
          ...target,
          preferences: { ...target.preferences, notifyOnFailure: false },
        },
      }),
    ).toBeNull();

    expect(
      makeWebPushNotification({
        previousState: runningState,
        nextState: { ...runningState, phase: "waiting_for_approval" },
        target: {
          ...target,
          preferences: { ...target.preferences, soundEnabled: false },
        },
      }),
    ).toMatchObject({
      title: "Approval Required - T3 Code",
      silent: true,
    });
  });
});

describe("WebPushDeliveries", () => {
  it.effect("sends an encrypted Web Push request and removes an expired subscription", () => {
    const vapid = NodeCrypto.createECDH("prime256v1");
    vapid.generateKeys();
    const subscriber = NodeCrypto.createECDH("prime256v1");
    subscriber.generateKeys();
    const vapidPublicKey = vapid.getPublicKey();
    const vapidPrivateKey = vapid.getPrivateKey().toString("base64url");
    const pushTarget = {
      ...target,
      p256dh: subscriber.getPublicKey().toString("base64url"),
      auth: NodeCrypto.randomBytes(16).toString("base64url"),
    };
    const requests: Array<Request> = [];
    const invalidated: Array<{ readonly userId: string; readonly subscriptionId: string }> = [];
    const subscriptions = WebPushSubscriptions.WebPushSubscriptions.of({
      register: () => Effect.void,
      unregister: () => Effect.void,
      listForUser: () => Effect.succeed([pushTarget]),
      invalidate: (input) =>
        Effect.sync(() => {
          invalidated.push(input);
        }),
    });
    const config = RelayConfiguration.RelayConfiguration.of({
      relayIssuer: "https://relay.example.test",
      webPush: {
        subject: "https://relay.example.test",
        publicKey: vapidPublicKey.toString("base64url"),
        privateKey: Redacted.make(vapidPrivateKey),
      },
      apns: {
        environment: "sandbox",
        teamId: "team",
        keyId: "key",
        bundleId: "codes.t3.mobile",
        privateKey: Redacted.make("private-key"),
      },
      clerkSecretKey: Redacted.make("clerk-secret"),
      clerkPublishableKey: "pk_test_test",
      clerkJwtAudience: "t3-code-relay",
      apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
      cloudMintPrivateKey: Redacted.make("cloud-private-key"),
      cloudMintPublicKey: "cloud-public-key",
      managedEndpointBaseDomain: undefined,
      managedEndpointNamespace: undefined,
    });
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response("", { status: 410 });
    };

    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = fakeFetch as typeof fetch;
        return originalFetch;
      }),
      () =>
        Effect.gen(function* () {
          const deliveries = yield* WebPushDeliveries;
          yield* deliveries.sendForUser({
            userId: target.userId,
            previousState: runningState,
            nextState: { ...runningState, phase: "completed" },
          });

          expect(requests).toHaveLength(1);
          expect(requests[0]?.method).toBe("POST");
          expect(requests[0]?.url).toBe(target.endpoint);
          expect(requests[0]?.headers.get("authorization")).toMatch(/^vapid /u);
          expect(requests[0]?.headers.get("content-encoding")).toBe("aes128gcm");
          expect(invalidated).toEqual([
            { userId: target.userId, subscriptionId: target.subscriptionId },
          ]);
        }),
      (originalFetch) =>
        Effect.sync(() => {
          globalThis.fetch = originalFetch;
        }),
    ).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(WebPushSubscriptions.WebPushSubscriptions, subscriptions),
              Layer.succeed(RelayConfiguration.RelayConfiguration, config),
            ),
          ),
        ),
      ),
    );
  });
});
