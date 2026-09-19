import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderSetupError,
  type ProviderAuthState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  ProviderSessionCloseError,
  ProviderSessionManagerV2,
} from "../../orchestration-v2/ProviderSessionManager.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import type { ProviderAuthController } from "../Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { makeProviderAuthService } from "./ProviderAuthService.ts";

const instanceId = ProviderInstanceId.make("antigravity-personal");
const unsupportedInstanceId = ProviderInstanceId.make("codex");
const driverKind = ProviderDriverKind.make("antigravity");
const owner = "paired-client-owner";
const otherOwner = "paired-client-other";
const flowId = "test-sign-in-flow";
const callbackUrl = "http://127.0.0.1:48123/?state=test-state&code=test-code";
const idleAuthState: ProviderAuthState = {
  instanceId,
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
};
const waitingAuthState: ProviderAuthState = {
  ...idleAuthState,
  phase: "waiting",
  flowId,
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test-state",
  expiresAt: "2026-09-02T00:05:00.000Z",
};

function makeInstance(input: {
  instanceId: ProviderInstanceId;
  enabled: boolean;
  auth?: ProviderAuthController;
}): ProviderInstance {
  return {
    ...input,
    driverKind,
    displayName: undefined,
    continuationIdentity: { driverKind, continuationKey: input.instanceId },
    get snapshot(): never {
      throw new Error("Auth routing must not refresh the provider snapshot.");
    },
    get orchestrationAdapter(): never {
      throw new Error("Auth routing must not start an adapter session.");
    },
    get textGeneration(): never {
      throw new Error("Auth routing must not generate text.");
    },
  };
}

const makeHarness = Effect.fn("ProviderAuthService.test.makeHarness")(function* (
  input: {
    enabled?: boolean;
    stopFailures?: number;
    logoutError?: ProviderSetupError;
  } = {},
) {
  const actions: string[] = [];
  const registryChanges = yield* PubSub.unbounded<void>();
  const closedInstances: string[] = [];
  let closeAttempts = 0;
  const idle = idleAuthState;
  let state = idle;
  let flowOwner: string | undefined;
  let gateClosed = false;

  const checkOwner = Effect.fn("ProviderAuthService.test.checkOwner")(function* (
    ownerSessionId: string,
    requestedFlowId: string,
    operation: string,
  ) {
    if (ownerSessionId !== flowOwner || requestedFlowId !== state.flowId) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: "This sign-in belongs to another client or has expired.",
      });
    }
  });

  const auth: ProviderAuthController = {
    start: Effect.fn(function* (ownerSessionId, stopSessions) {
      gateClosed = true;
      actions.push("close-gate");
      yield* stopSessions ?? Effect.void;
      flowOwner = ownerSessionId;
      state = waitingAuthState;
      actions.push("start-sign-in");
      return state;
    }),
    complete: Effect.fn(function* (ownerSessionId, request) {
      yield* checkOwner(ownerSessionId, request.flowId, "complete");
      if (request.callbackUrl !== callbackUrl) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "complete",
          detail: "The redirect URL does not match this sign-in.",
        });
      }
      state = { ...idle, flowId, phase: "succeeded" };
      return state;
    }),
    cancel: Effect.fn(function* (ownerSessionId, requestedFlowId) {
      yield* checkOwner(ownerSessionId, requestedFlowId, "cancel");
      state = { ...idle, flowId, phase: "cancelled" };
      return state;
    }),
    logout: Effect.fn(function* (stopSessions) {
      gateClosed = true;
      actions.push("close-gate");
      yield* stopSessions;
      if (input.logoutError) return yield* input.logoutError;
      actions.push("native-logout");
      state = idle;
      flowOwner = undefined;
      return state;
    }),
    subscribe: (ownerSessionId) =>
      Stream.fromEffect(Effect.sync(() => (ownerSessionId === flowOwner ? state : idle))),
    isLogoutPrompt: (text, hasAttachments) => !hasAttachments && text.trim() === "/logout",
  };
  const instances = [
    makeInstance({ instanceId, enabled: input.enabled ?? true, auth }),
    makeInstance({ instanceId: unsupportedInstanceId, enabled: true }),
  ];
  const service = yield* makeProviderAuthService.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.succeed(instances.find((instance) => instance.instanceId === id)),
          subscribeChanges: PubSub.subscribe(registryChanges),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          closeInstance: (id) =>
            Effect.suspend(() => {
              assert.isTrue(gateClosed);
              actions.push(`close-instance:${id}`);
              closeAttempts += 1;
              if (closeAttempts <= (input.stopFailures ?? 0)) {
                return Effect.fail(
                  new ProviderSessionCloseError({
                    providerSessionId: ProviderSessionId.make(
                      `provider-session:provider-instance:${id}`,
                    ),
                    cause: new Error("private process diagnostics"),
                  }),
                );
              }
              closedInstances.push(id);
              return Effect.void;
            }),
        }),
      ),
    ),
  );
  return { service, actions, closedInstances };
});

const makeStreamingController = Effect.fn("ProviderAuthService.test.makeStreamingController")(
  function* (flowOwner: string) {
    const state = yield* SubscriptionRef.make(idleAuthState);
    const close = yield* Deferred.make<void>();
    const closedSubscriptions = yield* Queue.unbounded<string>();
    const unused = () => Effect.die("Unexpected auth operation in a subscription test.");
    const auth: ProviderAuthController = {
      start: unused,
      complete: unused,
      cancel: unused,
      logout: unused,
      subscribe: (ownerSessionId) =>
        SubscriptionRef.changes(state).pipe(
          Stream.map((current) => (ownerSessionId === flowOwner ? current : idleAuthState)),
          Stream.interruptWhen(Deferred.await(close)),
          Stream.ensuring(Queue.offer(closedSubscriptions, ownerSessionId)),
        ),
    };
    return {
      auth,
      state,
      closedSubscriptions,
      close: Deferred.succeed(close, undefined),
    };
  },
);

const makeSubscriptionHarness = Effect.fn("ProviderAuthService.test.makeSubscriptionHarness")(
  function* (initial: ProviderInstance, replaceDuringFirstLookup?: ProviderInstance) {
    const changes = yield* PubSub.unbounded<void>();
    let current: ProviderInstance | undefined = initial;
    let pendingReplacement = replaceDuringFirstLookup;
    let subscribed = false;
    const service = yield* makeProviderAuthService.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderInstanceRegistry)({
            subscribeChanges: Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(changes);
              subscribed = true;
              return subscription;
            }),
            getInstance: () =>
              Effect.gen(function* () {
                const instance = current;
                if (pendingReplacement) {
                  assert.isTrue(subscribed, "Registry changes must be subscribed before lookup.");
                  current = pendingReplacement;
                  pendingReplacement = undefined;
                  yield* PubSub.publish(changes, undefined);
                }
                return instance;
              }),
          }),
          Layer.mock(ProviderSessionManagerV2)({}),
        ),
      ),
    );
    return {
      service,
      replace: Effect.fn(function* (replacement: ProviderInstance | undefined) {
        current = replacement;
        yield* PubSub.publish(changes, undefined);
      }),
    };
  },
);

const observeAuth = Effect.fn("ProviderAuthService.test.observeAuth")(function* (
  stream: Stream.Stream<ProviderAuthState, ProviderSetupError>,
) {
  const states = yield* Queue.unbounded<ProviderAuthState>();
  const fiber = yield* stream.pipe(
    Stream.runForEach((state) => Queue.offer(states, state)),
    Effect.forkScoped,
  );
  return { states, fiber };
});

describe("ProviderAuthService", () => {
  it.effect("closes the instance before sign-in, including for a disabled instance", () =>
    Effect.gen(function* () {
      const { service, actions, closedInstances } = yield* makeHarness({
        enabled: false,
      });
      const state = yield* service.start({ instanceId }, owner);

      assert.strictEqual(state.instanceId, instanceId);
      assert.strictEqual(state.phase, "waiting");
      assert.deepStrictEqual(closedInstances, [instanceId]);
      assert.deepStrictEqual(actions, [
        "close-gate",
        `close-instance:${instanceId}`,
        "start-sign-in",
      ]);
    }),
  );

  it.effect("keeps sign-in state private and accepts the owner's redirect URL", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const waiting = yield* service.start({ instanceId }, owner);
      const ownerStates = yield* service
        .subscribe({ instanceId }, owner)
        .pipe(Stream.take(1), Stream.runCollect);
      const otherStates = yield* service
        .subscribe({ instanceId }, otherOwner)
        .pipe(Stream.take(1), Stream.runCollect);

      assert.deepStrictEqual(ownerStates, [waiting]);
      assert.strictEqual(otherStates[0]?.authorizationUrl, null);
      assert.strictEqual(otherStates[0]?.flowId, null);

      const otherError = yield* Effect.flip(
        service.complete({ instanceId, flowId, callbackUrl }, otherOwner),
      );
      assert.strictEqual(otherError.operation, "complete");
      const complete = yield* service.complete({ instanceId, flowId, callbackUrl }, owner);
      assert.strictEqual(complete.phase, "succeeded");
      assert.strictEqual(complete.authorizationUrl, null);
    }),
  );

  it.effect("lets only the flow owner cancel sign-in", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.start({ instanceId }, owner);
      const error = yield* Effect.flip(service.cancel({ instanceId, flowId }, otherOwner));
      assert.strictEqual(error.operation, "cancel");

      const cancelled = yield* service.cancel({ instanceId, flowId }, owner);
      assert.strictEqual(cancelled.phase, "cancelled");
      assert.strictEqual(cancelled.authorizationUrl, null);
    }),
  );

  it.effect.each([
    { change: "enable", initialEnabled: false, closeBeforeReplacement: true },
    { change: "config", initialEnabled: true, closeBeforeReplacement: false },
  ])(
    "keeps private auth subscriptions current after an instance $change change",
    ({ initialEnabled, closeBeforeReplacement }) =>
      Effect.gen(function* () {
        const first = yield* makeStreamingController(owner);
        const replacement = yield* makeStreamingController(otherOwner);
        yield* SubscriptionRef.set(first.state, waitingAuthState);
        const { service, replace } = yield* makeSubscriptionHarness(
          makeInstance({ instanceId, enabled: initialEnabled, auth: first.auth }),
        );
        const firstClient = yield* observeAuth(service.subscribe({ instanceId }, owner));
        const secondClient = yield* observeAuth(service.subscribe({ instanceId }, otherOwner));
        assert.deepStrictEqual(yield* Queue.take(firstClient.states), waitingAuthState);
        assert.deepStrictEqual(yield* Queue.take(secondClient.states), idleAuthState);

        if (closeBeforeReplacement) {
          yield* first.close;
          const closed = yield* Queue.takeN(first.closedSubscriptions, 2);
          assert.deepStrictEqual(new Set(closed), new Set([owner, otherOwner]));
        }
        yield* replace(makeInstance({ instanceId, enabled: true, auth: replacement.auth }));
        assert.deepStrictEqual(yield* Queue.take(firstClient.states), idleAuthState);
        assert.deepStrictEqual(yield* Queue.take(secondClient.states), idleAuthState);
        if (!closeBeforeReplacement) {
          const closed = yield* Queue.takeN(first.closedSubscriptions, 2);
          assert.deepStrictEqual(new Set(closed), new Set([owner, otherOwner]));
        }

        const staleState: ProviderAuthState = { ...idleAuthState, phase: "cancelled" };
        yield* SubscriptionRef.set(first.state, staleState);
        const newWaiting: ProviderAuthState = {
          ...waitingAuthState,
          flowId: "replacement-flow",
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=replacement-state",
        };
        yield* SubscriptionRef.set(replacement.state, newWaiting);
        assert.deepStrictEqual(yield* Queue.take(firstClient.states), idleAuthState);
        assert.deepStrictEqual(yield* Queue.take(secondClient.states), newWaiting);
      }),
  );

  it.effect("does not miss a replacement during the first instance lookup", () =>
    Effect.gen(function* () {
      const first = yield* makeStreamingController(owner);
      const replacement = yield* makeStreamingController(owner);
      yield* SubscriptionRef.set(replacement.state, waitingAuthState);
      const { service } = yield* makeSubscriptionHarness(
        makeInstance({ instanceId, enabled: false, auth: first.auth }),
        makeInstance({ instanceId, enabled: true, auth: replacement.auth }),
      );

      const states = yield* service.subscribe({ instanceId }, owner).pipe(
        Stream.filter((state) => state.phase === "waiting"),
        Stream.take(1),
        Stream.runCollect,
      );

      assert.deepStrictEqual(states, [waitingAuthState]);
    }),
  );

  it.effect("ends the subscription with a setup error when the instance is removed", () =>
    Effect.gen(function* () {
      const controller = yield* makeStreamingController(owner);
      const { service, replace } = yield* makeSubscriptionHarness(
        makeInstance({ instanceId, enabled: true, auth: controller.auth }),
      );
      const { states, fiber } = yield* observeAuth(service.subscribe({ instanceId }, owner));
      assert.deepStrictEqual(yield* Queue.take(states), idleAuthState);

      yield* replace(undefined);
      const error = yield* Effect.flip(Fiber.join(fiber));

      assert.instanceOf(error, ProviderSetupError);
      assert.strictEqual(error.instanceId, instanceId);
      assert.strictEqual(error.operation, "subscribe");
      assert.include(error.detail, "no longer available");
      assert.strictEqual(yield* Queue.take(controller.closedSubscriptions), owner);
    }),
  );

  it.effect.each([
    { id: ProviderInstanceId.make("missing"), detail: "no longer available" },
    { id: unsupportedInstanceId, detail: "does not support sign-in" },
  ])("rejects setup for unavailable or unsupported instance $id", ({ id, detail }) =>
    Effect.gen(function* () {
      const { service, actions } = yield* makeHarness();
      const operations: Effect.Effect<
        ProviderAuthState | ReadonlyArray<ProviderAuthState>,
        ProviderSetupError
      >[] = [
        service.start({ instanceId: id }, owner),
        service.complete({ instanceId: id, flowId, callbackUrl }, owner),
        service.cancel({ instanceId: id, flowId }, owner),
        service.logout({ instanceId: id }),
        Stream.runCollect(service.subscribe({ instanceId: id }, owner)),
      ];
      for (const operation of operations) {
        const error = yield* Effect.flip(operation);
        assert.instanceOf(error, ProviderSetupError);
        assert.strictEqual(error.instanceId, id);
        assert.include(error.detail, detail);
      }
      assert.deepStrictEqual(actions, []);
    }),
  );

  it.effect("closes the instance before native logout", () =>
    Effect.gen(function* () {
      const { service, actions, closedInstances } = yield* makeHarness();
      const state = yield* service.logout({ instanceId });

      assert.strictEqual(state.phase, "idle");
      assert.deepStrictEqual(actions, [
        "close-gate",
        `close-instance:${instanceId}`,
        "native-logout",
      ]);
      assert.deepStrictEqual(closedInstances, [instanceId]);
    }),
  );

  it.effect(
    "retries instance cleanup on a later logout instead of signing out over owned resources",
    () =>
      Effect.gen(function* () {
        const { service, actions, closedInstances } = yield* makeHarness({ stopFailures: 1 });
        const error = yield* Effect.flip(service.logout({ instanceId }));

        assert.instanceOf(error, ProviderSetupError);
        assert.strictEqual(error.operation, "stopSessions");
        assert.notInclude(error.detail, "private process diagnostics");
        assert.deepStrictEqual(closedInstances, []);

        const state = yield* service.logout({ instanceId });

        assert.strictEqual(state.phase, "idle");
        assert.deepStrictEqual(closedInstances, [instanceId]);
        assert.deepStrictEqual(actions, [
          "close-gate",
          `close-instance:${instanceId}`,
          "close-gate",
          `close-instance:${instanceId}`,
          "native-logout",
        ]);
      }),
  );

  it.effect(
    "retries instance cleanup on a later sign-in instead of signing in over owned resources",
    () =>
      Effect.gen(function* () {
        const { service, closedInstances } = yield* makeHarness({ stopFailures: 1 });
        const error = yield* Effect.flip(service.start({ instanceId }, owner));

        assert.instanceOf(error, ProviderSetupError);
        assert.strictEqual(error.operation, "stopSessions");
        assert.deepStrictEqual(closedInstances, []);

        const state = yield* service.start({ instanceId }, owner);

        assert.strictEqual(state.phase, "waiting");
        assert.deepStrictEqual(closedInstances, [instanceId]);
      }),
  );

  it.effect.each([
    { text: "/logout", hasAttachments: false, handled: true },
    { text: " \n/logout\t", hasAttachments: false, handled: true },
    { text: "/logout", hasAttachments: true, handled: false },
    { text: "/logout please", hasAttachments: false, handled: false },
    { text: "Explain /logout", hasAttachments: false, handled: false },
    { text: "/Logout", hasAttachments: false, handled: false },
  ])("handles only a standalone logout command %#", ({ text, hasAttachments, handled }) =>
    Effect.gen(function* () {
      const { service, actions } = yield* makeHarness();
      const result = yield* service.tryHandlePromptCommand({ instanceId, text, hasAttachments });

      assert.strictEqual(result, handled);
      assert.deepStrictEqual(
        actions,
        handled ? ["close-gate", `close-instance:${instanceId}`, "native-logout"] : [],
      );
    }),
  );

  it.effect("does not intercept commands for providers without an auth controller", () =>
    Effect.gen(function* () {
      const { service, actions } = yield* makeHarness();
      for (const id of [unsupportedInstanceId, ProviderInstanceId.make("missing")]) {
        assert.isFalse(
          yield* service.tryHandlePromptCommand({
            instanceId: id,
            text: "/logout",
            hasAttachments: false,
          }),
        );
      }
      assert.deepStrictEqual(actions, []);
    }),
  );

  it.effect("does not log out when the instance close fails", () =>
    Effect.gen(function* () {
      const { service, actions, closedInstances } = yield* makeHarness({
        stopFailures: Number.POSITIVE_INFINITY,
      });
      const error = yield* Effect.flip(service.logout({ instanceId }));

      assert.instanceOf(error, ProviderSetupError);
      assert.strictEqual(error.instanceId, instanceId);
      assert.strictEqual(error.operation, "stopSessions");
      assert.notInclude(error.detail, "private process diagnostics");
      assert.deepStrictEqual(closedInstances, []);
      assert.deepStrictEqual(actions, ["close-gate", `close-instance:${instanceId}`]);
    }),
  );

  it.effect("does not log out or consume the command when the instance close fails", () =>
    Effect.gen(function* () {
      const { service, actions, closedInstances } = yield* makeHarness({
        stopFailures: Number.POSITIVE_INFINITY,
      });
      const error = yield* Effect.flip(
        service.tryHandlePromptCommand({ instanceId, text: "/logout", hasAttachments: false }),
      );

      assert.instanceOf(error, ProviderSetupError);
      assert.strictEqual(error.operation, "stopSessions");
      assert.notInclude(error.detail, "private process diagnostics");
      assert.deepStrictEqual(closedInstances, []);
      assert.deepStrictEqual(actions, ["close-gate", `close-instance:${instanceId}`]);
    }),
  );

  it.effect("returns native logout failures to the command caller", () =>
    Effect.gen(function* () {
      const logoutError = new ProviderSetupError({
        instanceId,
        operation: "logout",
        detail: "Native sign-out failed. Try again.",
      });
      const { service } = yield* makeHarness({ logoutError });
      const error = yield* Effect.flip(
        service.tryHandlePromptCommand({ instanceId, text: "/logout", hasAttachments: false }),
      );

      assert.strictEqual(error, logoutError);
    }),
  );
});
