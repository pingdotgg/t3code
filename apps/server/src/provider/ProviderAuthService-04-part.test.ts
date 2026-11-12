import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderSetupError,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ThreadShell,
  type ProviderAuthState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderAuthService from "./ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

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
  auth?: ProviderAuthService.ProviderAuthController;
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

const nowUtc = DateTime.makeUnsafe(now);

function makeThread(
  thread: string,
  input: { readonly providerInstanceId?: ProviderInstanceId; readonly active?: boolean } = {},
): OrchestrationV2ThreadShell {
  const shell: Pick<
    OrchestrationV2ThreadShell,
    "id" | "providerInstanceId" | "activeProviderThreadId"
  > = {
    id: ThreadId.make(thread),
    providerInstanceId: input.providerInstanceId ?? instanceId,
    activeProviderThreadId:
      input.active === false ? null : ProviderThreadId.make(`${thread}:native`),
  };
  return shell as unknown as OrchestrationV2ThreadShell;
}

function makeSession(
  session: string,
  status: OrchestrationV2ProviderSession["status"] = "ready",
  providerInstanceId = instanceId,
): OrchestrationV2ProviderSession {
  return {
    id: ProviderSessionId.make(session),
    driver: driverKind,
    providerInstanceId,
    status,
    cwd: "/workspace",
    model: null,
    capabilities: AcpProviderCapabilitiesV2,
    createdAt: nowUtc,
    updatedAt: nowUtc,
    lastError: null,
  };
}

function sessionThreads(list: ReadonlyArray<OrchestrationV2ProviderSession>) {
  return {
    threads: list.map((session) => makeThread(session.id)),
    sessions: new Map(list.map((session) => [ThreadId.make(session.id), [session]])),
  };
}

const makeHarness = Effect.fn("ProviderAuthService.test.makeHarness")(function* (
  input: {
    enabled?: boolean;
    threads?: ReadonlyArray<OrchestrationV2ThreadShell>;
    sessions?: ReadonlyMap<ThreadId, ReadonlyArray<OrchestrationV2ProviderSession>>;
    shellError?: boolean;
    stopError?: boolean;
    logoutError?: ProviderSetupError;
    sharedCredentials?: boolean;
    sharedBusy?: boolean;
    sharedBusyEffect?: Effect.Effect<boolean>;
    responds?: boolean;
    beforeLogout?: Effect.Effect<void>;
    beforeStop?: Effect.Effect<void>;
    beforeListSessions?: Effect.Effect<void>;
    onLookup?: Effect.Effect<void>;
    onListThreads?: (instances: ProviderInstance[]) => void;
  } = {},
) {
  const actions: string[] = [];
  const registryChanges = yield* PubSub.unbounded<void>();
  const threads = input.threads ?? [];
  const sessions = new Map(
    [...(input.sessions?.entries() ?? [])].map(([threadId, list]) => [threadId, [...list]]),
  );
  const released: string[] = [];
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

  const auth: ProviderAuthService.ProviderAuthController = {
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
  const service = yield* ProviderAuthService.makeProviderAuthService.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.gen(function* () {
              const found = instances.find((instance) => instance.instanceId === id);
              yield* input.onLookup ?? Effect.void;
              return found;
            }),
          listInstances: Effect.succeed(instances),
          subscribeChanges: PubSub.subscribe(registryChanges),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () =>
            Effect.gen(function* () {
              assert.isTrue(gateClosed);
              actions.push("list-threads");
              input.onListThreads?.(instances);
              yield* input.beforeListSessions ?? Effect.void;
              return yield* input.shellError
                ? Effect.fail(
                    new ProjectionStore.ProjectionStoreReadError({
                      threadId: ThreadId.make("shell"),
                      cause: new Error("private database diagnostics"),
                    }),
                  )
                : Effect.succeed(threads.map((thread) => thread.id));
            }),
          getThreadRecords: (threadId) =>
            Effect.sync(() => {
              actions.push(`sessions:${threadId}`);
              return {
                providerSessions: sessions.get(threadId) ?? [],
              } as never;
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          release: ({ providerSessionId, reason }) =>
            Effect.gen(function* () {
              assert.isTrue(gateClosed);
              actions.push(`stop:${providerSessionId}`);
              yield* input.beforeStop ?? Effect.void;
              if (input.stopError) {
                return yield* new ProviderSessionManager.ProviderSessionReleaseError({
                  providerSessionId,
                  reason,
                  cause: new Error("private process diagnostics"),
                });
              }
              released.push(providerSessionId);
              for (const [threadId, list] of sessions) {
                const remaining = list.filter((session) => session.id !== providerSessionId);
                if (remaining.length === 0) sessions.delete(threadId);
                else sessions.set(threadId, remaining);
              }
            }),
        }),
      ),
    ),
  );
  return {
    service,
    actions,
    released,
    sessions,
    auth,
    addInstance: (instance: ProviderInstance) => instances.push(instance),
    replaceInstance: (replacement: ProviderInstance) => {
      const index = instances.findIndex(
        (instance) => instance.instanceId === replacement.instanceId,
      );
      assert.isAtLeast(index, 0);
      instances[index] = replacement;
    },
    replaceAuth: (next: ProviderAuthService.ProviderAuthController) => {
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
    const auth: ProviderAuthService.ProviderAuthController = {
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
    const service = yield* ProviderAuthService.makeProviderAuthService.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
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
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
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
        ...sessionThreads([
          makeSession("target-draining"),
          makeSession("peer-replacement", "ready", otherInstanceId),
          makeSession("peer-persisted", "running", otherInstanceId),
        ]),
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

