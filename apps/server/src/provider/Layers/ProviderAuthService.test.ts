import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  ThreadId,
  type ProviderAuthState,
  type ProviderSession,
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
  ProviderSessionDirectoryPersistenceError,
  ProviderValidationError,
  type ProviderServiceError,
} from "../Errors.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import type { ProviderAuthController } from "../Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBindingWithMetadata,
} from "../Services/ProviderSessionDirectory.ts";
import { makeProviderAuthService } from "./ProviderAuthService.ts";

const instanceId = ProviderInstanceId.make("antigravity-personal");
const otherInstanceId = ProviderInstanceId.make("antigravity-work");
const unsupportedInstanceId = ProviderInstanceId.make("codex");
const driverKind = ProviderDriverKind.make("antigravity");
const owner = "paired-client-owner";
const otherOwner = "paired-client-other";
const flowId = "test-sign-in-flow";
const callbackUrl = "http://127.0.0.1:48123/?state=test-state&code=test-code";
const now = "2026-09-02T00:00:00.000Z";
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
    get adapter(): never {
      throw new Error("Auth routing must not start an adapter session.");
    },
    get textGeneration(): never {
      throw new Error("Auth routing must not generate text.");
    },
  };
}

function makeBinding(
  thread: string,
  status: NonNullable<ProviderRuntimeBindingWithMetadata["status"]>,
  providerInstanceId = instanceId,
): ProviderRuntimeBindingWithMetadata {
  return {
    threadId: ThreadId.make(thread),
    provider: driverKind,
    providerInstanceId,
    status,
    lastSeenAt: now,
  };
}

function makeSession(thread: string, providerInstanceId = instanceId): ProviderSession {
  return {
    threadId: ThreadId.make(thread),
    provider: driverKind,
    providerInstanceId,
    status: "ready",
    runtimeMode: "approval-required",
    createdAt: now,
    updatedAt: now,
  };
}

const makeHarness = Effect.fn("ProviderAuthService.test.makeHarness")(function* (
  input: {
    enabled?: boolean;
    bindings?: ReadonlyArray<ProviderRuntimeBindingWithMetadata>;
    sessions?: ReadonlyArray<ProviderSession>;
    directoryError?: ProviderSessionDirectoryPersistenceError;
    stopError?: ProviderServiceError;
    logoutError?: ProviderSetupError;
    sharedCredentials?: boolean;
    sharedBusy?: boolean;
    sharedBusyEffect?: Effect.Effect<boolean>;
    responds?: boolean;
    beforeLogout?: Effect.Effect<void>;
    beforeStop?: Effect.Effect<void>;
    beforeListSessions?: Effect.Effect<void>;
    onLookup?: Effect.Effect<void>;
  } = {},
) {
  const actions: string[] = [];
  const registryChanges = yield* PubSub.unbounded<void>();
  const sessions = new Map(input.sessions?.map((session) => [session.threadId, session]));
  const bindings = new Map(input.bindings?.map((binding) => [binding.threadId, binding]));
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
    ...(input.sharedCredentials
      ? { credentialBinding: { owner: "provider" as const, key: "shared" } }
      : {}),
    ...(input.responds
      ? {
          respond: Effect.fn(function* (ownerSessionId, request) {
            yield* checkOwner(ownerSessionId, request.flowId, "respond");
            actions.push(`respond:${request.response.type}`);
            return state;
          }),
        }
      : {}),
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
      yield* input.beforeLogout ?? Effect.void;
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
    ...(input.sharedCredentials
      ? [
          makeInstance({
            instanceId: otherInstanceId,
            enabled: true,
            auth: {
              ...auth,
              isChangingCredentials:
                input.sharedBusyEffect ?? Effect.succeed(input.sharedBusy ?? false),
              invalidate: Effect.sync(() => {
                actions.push("invalidate-shared");
              }),
            },
          }),
        ]
      : []),
  ];
  const service = yield* makeProviderAuthService.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.gen(function* () {
              const found = instances.find((instance) => instance.instanceId === id);
              yield* input.onLookup ?? Effect.void;
              return found;
            }),
          listInstances: Effect.succeed(instances),
          subscribeChanges: PubSub.subscribe(registryChanges),
        }),
        Layer.mock(ProviderSessionDirectory)({
          listBindings: () =>
            Effect.suspend(() => {
              assert.isTrue(gateClosed);
              actions.push("list-bindings");
              return input.directoryError
                ? Effect.fail(input.directoryError)
                : Effect.succeed([...bindings.values()]);
            }),
        }),
        Layer.mock(ProviderService)({
          listSessions: () =>
            Effect.gen(function* () {
              assert.isTrue(gateClosed);
              actions.push("list-sessions");
              yield* input.beforeListSessions ?? Effect.void;
              return [...sessions.values()];
            }),
          stopSession: ({ threadId }) =>
            Effect.gen(function* () {
              assert.isTrue(gateClosed);
              actions.push(`stop:${threadId}`);
              yield* input.beforeStop ?? Effect.void;
              if (input.stopError) return yield* input.stopError;
              sessions.delete(threadId);
              const binding = bindings.get(threadId);
              if (binding) bindings.set(threadId, { ...binding, status: "stopped" });
            }),
        }),
      ),
    ),
  );
  return {
    service,
    actions,
    sessions,
    bindings,
    auth,
    addInstance: (instance: ProviderInstance) => instances.push(instance),
    replaceInstance: (replacement: ProviderInstance) => {
      const index = instances.findIndex(
        (instance) => instance.instanceId === replacement.instanceId,
      );
      assert.isAtLeast(index, 0);
      instances[index] = replacement;
    },
    replaceAuth: (next: ProviderAuthController) => {
      instances[0] = makeInstance({ instanceId, enabled: input.enabled ?? true, auth: next });
    },
  };
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
          Layer.mock(ProviderService)({}),
          Layer.mock(ProviderSessionDirectory)({}),
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
  it.effect(
    "stops sessions sharing credentials and invalidates their processes before logout",
    () =>
      Effect.gen(function* () {
        const { service, actions, sessions } = yield* makeHarness({
          sharedCredentials: true,
          sessions: [
            makeSession("target"),
            makeSession("shared", otherInstanceId),
            makeSession("unrelated", unsupportedInstanceId),
          ],
        });
        yield* service.logout({ instanceId });
        assert.deepStrictEqual([...sessions.keys()], [ThreadId.make("unrelated")]);
        assert.isBelow(actions.indexOf("stop:shared"), actions.indexOf("invalidate-shared"));
        assert.isBelow(actions.indexOf("invalidate-shared"), actions.indexOf("native-logout"));
      }),
  );
  it.effect("rejects overlapping changes to a shared sign-in", () =>
    Effect.gen(function* () {
      const { service, actions } = yield* makeHarness({
        sharedCredentials: true,
        sharedBusy: true,
      });
      for (const task of [service.start({ instanceId }, owner), service.logout({ instanceId })]) {
        const error = yield* task.pipe(Effect.flip);
        assert.include(error.detail, "shared sign-in");
      }
      assert.deepStrictEqual(actions, []);
    }),
  );
  it.effect("routes typed interactions to the flow owner and rejects unsupported controllers", () =>
    Effect.gen(function* () {
      const { service, actions } = yield* makeHarness({ responds: true });
      yield* service.start({ instanceId }, owner);
      const request = {
        instanceId,
        flowId,
        interactionId: "consent",
        response: { type: "browser" as const, action: "accept" as const },
      };
      const rejected = yield* service.respond(request, otherOwner).pipe(Effect.flip);
      assert.strictEqual(rejected.operation, "respond");
      yield* service.respond(request, owner);
      assert.strictEqual(actions.at(-1), "respond:browser");
      const unsupported = yield* makeHarness();
      const error = yield* unsupported.service.respond(request, owner).pipe(Effect.flip);
      assert.include(error.detail, "does not accept");
    }),
  );
  it.effect("stops routed sessions before sign-in, including for a disabled instance", () =>
    Effect.gen(function* () {
      const { service, actions, sessions } = yield* makeHarness({
        enabled: false,
        sessions: [makeSession("active")],
      });
      const state = yield* service.start({ instanceId }, owner);

      assert.strictEqual(state.instanceId, instanceId);
      assert.strictEqual(state.phase, "waiting");
      assert.strictEqual(sessions.size, 0);
      assert.deepStrictEqual(actions, [
        "close-gate",
        "list-bindings",
        "list-sessions",
        "stop:active",
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

  it.effect("stops active and persisted sessions once before native logout", () =>
    Effect.gen(function* () {
      const { service, actions, sessions, bindings } = yield* makeHarness({
        bindings: [
          makeBinding("shared", "running"),
          makeBinding("starting", "starting"),
          makeBinding("persisted", "running"),
          makeBinding("already-stopped", "stopped"),
          makeBinding("other-instance", "running", otherInstanceId),
        ],
        sessions: [
          makeSession("shared"),
          makeSession("runtime-only"),
          makeSession("other-instance", otherInstanceId),
        ],
      });
      const state = yield* service.logout({ instanceId });

      assert.strictEqual(state.phase, "idle");
      assert.deepStrictEqual(actions, [
        "close-gate",
        "list-bindings",
        "list-sessions",
        "stop:shared",
        "stop:starting",
        "stop:persisted",
        "stop:runtime-only",
        "native-logout",
      ]);
      assert.deepStrictEqual([...sessions.keys()], [ThreadId.make("other-instance")]);
      assert.strictEqual(bindings.get(ThreadId.make("starting"))?.status, "stopped");
      assert.strictEqual(bindings.get(ThreadId.make("persisted"))?.status, "stopped");
      assert.strictEqual(bindings.get(ThreadId.make("other-instance"))?.status, "running");
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
        handled ? ["close-gate", "list-bindings", "list-sessions", "native-logout"] : [],
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

  it.effect("does not log out when the session directory cannot be read", () =>
    Effect.gen(function* () {
      const { service, actions } = yield* makeHarness({
        directoryError: new ProviderSessionDirectoryPersistenceError({
          operation: "listBindings",
          detail: "private database diagnostics",
        }),
      });
      const error = yield* Effect.flip(service.logout({ instanceId }));

      assert.instanceOf(error, ProviderSetupError);
      assert.strictEqual(error.instanceId, instanceId);
      assert.strictEqual(error.operation, "stopSessions");
      assert.notInclude(error.detail, "private database diagnostics");
      assert.deepStrictEqual(actions, ["close-gate", "list-bindings"]);
    }),
  );

  it.effect("does not log out or consume the command when stopping a session fails", () =>
    Effect.gen(function* () {
      const { service, actions, sessions } = yield* makeHarness({
        sessions: [makeSession("active")],
        stopError: new ProviderValidationError({
          operation: "stopSession",
          issue: "private process diagnostics",
        }),
      });
      const error = yield* Effect.flip(
        service.tryHandlePromptCommand({ instanceId, text: "/logout", hasAttachments: false }),
      );

      assert.instanceOf(error, ProviderSetupError);
      assert.strictEqual(error.operation, "stopSessions");
      assert.notInclude(error.detail, "private process diagnostics");
      assert.strictEqual(sessions.size, 1);
      assert.deepStrictEqual(actions, [
        "close-gate",
        "list-bindings",
        "list-sessions",
        "stop:active",
      ]);
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

it.effect("queued logout prompts resolve the current controller after provider replacement", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const lookup = yield* Deferred.make<void>();
    let observeLookup = false;
    const harness = yield* makeHarness({
      beforeLogout: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
      onLookup: Effect.suspend(() =>
        observeLookup ? Deferred.succeed(lookup, undefined).pipe(Effect.asVoid) : Effect.void,
      ),
    });
    const first = yield* harness.service.logout({ instanceId }).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    observeLookup = true;
    const queued = yield* harness.service
      .tryHandlePromptCommand({ instanceId, text: "/logout", hasAttachments: false })
      .pipe(Effect.forkChild);
    yield* Deferred.await(lookup);
    let replacementLoggedOut = false;
    harness.replaceAuth({
      ...harness.auth,
      logout: (stopSessions) =>
        stopSessions.pipe(
          Effect.andThen(
            Effect.sync(() => {
              replacementLoggedOut = true;
              return idleAuthState;
            }),
          ),
        ),
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    assert.isTrue(yield* Fiber.join(queued));
    assert.isTrue(replacementLoggedOut);
    assert.strictEqual(harness.actions.filter((action) => action === "native-logout").length, 1);
  }).pipe(Effect.scoped),
);

it.effect.each(["start", "logout", "prompt"] as const)(
  "%s uses the same credential controller for shared exclusion and mutation during replacement",
  (action) =>
    Effect.gen(function* () {
      const checked = yield* Deferred.make<void>();
      const continueCheck = yield* Deferred.make<void>();
      const replacementPeerId = ProviderInstanceId.make("replacement-shared-peer");
      const harness = yield* makeHarness({
        sharedCredentials: true,
        sharedBusyEffect: Deferred.succeed(checked, undefined).pipe(
          Effect.andThen(Deferred.await(continueCheck)),
          Effect.as(false),
        ),
        sessions: [
          makeSession("old-shared", otherInstanceId),
          makeSession("replacement-shared", replacementPeerId),
        ],
      });
      harness.addInstance(
        makeInstance({
          instanceId: replacementPeerId,
          enabled: true,
          auth: {
            ...harness.auth,
            credentialBinding: { owner: "provider", key: "replacement-binding" },
            isChangingCredentials: Effect.succeed(true),
            invalidate: Effect.die(
              "The unrelated replacement credential binding must stay intact.",
            ),
          },
        }),
      );
      const operation =
        action === "start"
          ? harness.service.start({ instanceId }, owner)
          : action === "logout"
            ? harness.service.logout({ instanceId })
            : harness.service.tryHandlePromptCommand({
                instanceId,
                text: "/logout",
                hasAttachments: false,
              });
      const running = yield* operation.pipe(Effect.forkChild);
      yield* Deferred.await(checked);
      let replacementMutations = 0;
      harness.replaceAuth({
        ...harness.auth,
        credentialBinding: { owner: "provider", key: "replacement-binding" },
        start: () =>
          Effect.sync(() => {
            replacementMutations++;
            return waitingAuthState;
          }),
        logout: () =>
          Effect.sync(() => {
            replacementMutations++;
            return idleAuthState;
          }),
      });
      yield* Deferred.succeed(continueCheck, undefined);
      yield* Fiber.join(running);
      assert.equal(replacementMutations, 0);
      assert.include(harness.actions, action === "start" ? "start-sign-in" : "native-logout");
      assert.isFalse(harness.sessions.has(ThreadId.make("old-shared")));
      assert.isTrue(harness.sessions.has(ThreadId.make("replacement-shared")));
      const blocked = yield* Effect.flip(harness.service.logout({ instanceId }));
      assert.include(blocked.detail, "shared sign-in");
      assert.equal(replacementMutations, 0);
    }).pipe(Effect.scoped),
);

it.effect.each([
  { owner: "provider" as const, key: "different-binding" },
  { owner: "t3" as const, key: "shared" },
])(
  "does not invalidate a peer that switches credential binding during session draining %#",
  (binding) =>
    Effect.gen(function* () {
      const draining = yield* Deferred.make<void>();
      const continueDrain = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        sharedCredentials: true,
        sessions: [makeSession("shared-draining", otherInstanceId)],
        beforeStop: Deferred.succeed(draining, undefined).pipe(
          Effect.andThen(Deferred.await(continueDrain)),
        ),
      });
      const logout = yield* harness.service.logout({ instanceId }).pipe(Effect.forkChild);
      yield* Deferred.await(draining);
      let replacementInvalidated = false;
      harness.replaceInstance(
        makeInstance({
          instanceId: otherInstanceId,
          enabled: true,
          auth: {
            ...harness.auth,
            credentialBinding: binding,
            invalidate: Effect.sync(() => {
              replacementInvalidated = true;
            }),
          },
        }),
      );
      yield* Deferred.succeed(continueDrain, undefined);
      yield* Fiber.join(logout);
      assert.isFalse(replacementInvalidated);
      assert.isFalse(harness.sessions.has(ThreadId.make("shared-draining")));
      assert.include(harness.actions, "native-logout");
    }).pipe(Effect.scoped),
);

it.effect.each(["selection", "drain"] as const)(
  "preserves replacement peer sessions when credentials change during session %s",
  (phase) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const block = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(proceed)),
      );
      const harness = yield* makeHarness({
        sharedCredentials: true,
        sessions: [
          makeSession("target-draining"),
          makeSession("peer-replacement", otherInstanceId),
        ],
        bindings: [
          makeBinding("target-draining", "running"),
          makeBinding("peer-persisted", "running", otherInstanceId),
        ],
        ...(phase === "selection" ? { beforeListSessions: block } : { beforeStop: block }),
      });
      const logout = yield* harness.service.logout({ instanceId }).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      harness.replaceInstance(
        makeInstance({
          instanceId: otherInstanceId,
          enabled: true,
          auth: {
            ...harness.auth,
            credentialBinding: { owner: "provider", key: "replacement-credentials" },
            invalidate: Effect.die("The replacement peer's credentials must not be invalidated."),
          },
        }),
      );
      yield* Deferred.succeed(proceed, undefined);
      yield* Fiber.join(logout);
      assert.isTrue(harness.sessions.has(ThreadId.make("peer-replacement")));
      assert.notInclude(harness.actions, "stop:peer-replacement");
      assert.notInclude(harness.actions, "stop:peer-persisted");
      assert.isFalse(harness.sessions.has(ThreadId.make("target-draining")));
      assert.include(harness.actions, "native-logout");
    }).pipe(Effect.scoped),
);
