import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSetupError, type ProviderAuthState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import {
  makeAntigravityAuth,
  type AntigravityAuth,
  type AntigravityAuthRuntime,
} from "./AntigravityAuth.ts";
import type { AcpSessionRuntimeStartResult } from "./acp/AcpSessionRuntime.ts";

const instanceId = ProviderInstanceId.make("antigravity-auth-test");
const owner = "t3-auth-session-owner";
const otherOwner = "t3-auth-session-other";
const authorizationUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=test-state";
const callbackUrl = "http://127.0.0.1:51234/?state=test-state&code=test-code";

const initialized = {
  protocolVersion: 1,
  authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
  agentCapabilities: { auth: { logout: {} } },
} satisfies AcpSchema.InitializeResponse;
const started: AcpSessionRuntimeStartResult = {
  sessionId: "native-session",
  initializeResult: initialized,
  sessionSetupResult: {
    sessionId: "native-session",
    models: {
      currentModelId: "gemini-test",
      availableModels: [{ modelId: "gemini-test", name: "Gemini test" }],
    },
  },
  modelConfigId: "model",
};

const phase = (auth: AntigravityAuth, value: ProviderAuthState["phase"], sessionId = owner) =>
  auth.controller.subscribe(sessionId).pipe(
    Stream.filter((state) => state.phase === value),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const makeHarness = Effect.fn("makeAuthTestHarness")(function* (
  options: {
    readonly interactive?: boolean;
    readonly authorizationUrls?: ReadonlyArray<string>;
    readonly supportsLogout?: boolean;
    readonly beforeInitialize?: Effect.Effect<void>;
    readonly forwardCallback?: Effect.Effect<void, ProviderSetupError>;
  } = {},
) {
  const authenticated = yield* Deferred.make<void, AcpErrors.AcpError>();
  const discovered = yield* Deferred.make<void, AcpErrors.AcpError>();
  const closed = yield* Deferred.make<void>();
  const events: string[] = [];
  let receiveAuthorizationUrl:
    | ((url: string) => Effect.Effect<void, AcpErrors.AcpError>)
    | undefined;
  let forwarded = 0;
  let catalog = ["previous-account-model"];
  const auth = yield* makeAntigravityAuth({
    instanceId,
    makeRuntime: (input) =>
      Effect.gen(function* () {
        receiveAuthorizationUrl = input.onAuthorizationUrl;
        events.push("process-open");
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            events.push("process-close");
            yield* Deferred.succeed(closed, undefined);
          }),
        );
        return {
          initialize: () =>
            Effect.gen(function* () {
              events.push("initialize");
              yield* options.beforeInitialize ?? Effect.void;
              return options.supportsLogout === false
                ? { ...initialized, agentCapabilities: {} }
                : initialized;
            }),
          start: () =>
            Effect.gen(function* () {
              events.push("authenticate");
              if (options.interactive !== false && input.onAuthorizationUrl) {
                for (const url of options.authorizationUrls ?? [authorizationUrl]) {
                  yield* input.onAuthorizationUrl(url);
                }
              }
              yield* Deferred.await(authenticated);
              events.push("session-new");
              yield* Deferred.await(discovered);
              return started;
            }),
          request: (method) =>
            Effect.sync(() => {
              events.push(method);
              return {};
            }),
        } satisfies AntigravityAuthRuntime;
      }),
    onAuthenticated: () =>
      Effect.sync(() => {
        catalog = ["gemini-test"];
        events.push("catalog-published");
      }),
    onSignedOut: Effect.sync(() => {
      catalog = [];
      events.push("catalog-cleared");
    }),
    forwardCallback: () =>
      options.forwardCallback ??
      Effect.sync(() => {
        forwarded += 1;
      }),
  });
  return {
    auth,
    authenticated,
    discovered,
    closed,
    events,
    catalog: () => catalog,
    forwarded: () => forwarded,
    receiveAuthorizationUrl: (url: string) =>
      Effect.suspend(() =>
        receiveAuthorizationUrl
          ? receiveAuthorizationUrl(url)
          : Effect.die("Authorization URL receiver is not ready."),
      ),
  };
});

it.layer(NodeServices.layer)("AntigravityAuth", (it) => {
  it.effect("accepts the same authorization URL from stderr and stdout", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        authorizationUrls: [authorizationUrl, authorizationUrl],
      });
      yield* harness.auth.controller.start(owner);
      const waiting = yield* phase(harness.auth, "waiting");
      assert.equal(waiting.authorizationUrl, authorizationUrl);

      yield* Deferred.succeed(harness.authenticated, undefined);
      yield* Deferred.succeed(harness.discovered, undefined);
      yield* phase(harness.auth, "succeeded");
    }),
  );

  it.effect("accepts a delayed duplicate after callback completion starts", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const state = yield* harness.auth.controller.start(owner);
      yield* phase(harness.auth, "waiting");
      yield* harness.auth.controller.complete(owner, {
        flowId: state.flowId!,
        callbackUrl,
      });

      yield* harness.receiveAuthorizationUrl(authorizationUrl);

      yield* Deferred.succeed(harness.authenticated, undefined);
      yield* Deferred.succeed(harness.discovered, undefined);
      yield* phase(harness.auth, "succeeded");
    }),
  );

  it.effect("rejects a different second authorization URL", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        authorizationUrls: [authorizationUrl, `${authorizationUrl}&scope=another-request`],
      });
      yield* harness.auth.controller.start(owner);

      const failed = yield* phase(harness.auth, "failed");
      assert.isNull(failed.authorizationUrl);
      assert.deepEqual(harness.catalog(), ["previous-account-model"]);
    }),
  );

  it.effect("keeps a remote flow private and waits for native auth and catalog discovery", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const state = yield* harness.auth.controller.start(owner);
      assert.isNotNull(state.flowId);
      const waiting = yield* phase(harness.auth, "waiting");
      assert.equal(waiting.authorizationUrl, authorizationUrl);

      const other = yield* phase(harness.auth, "waiting", otherOwner);
      assert.isNull(other.authorizationUrl);
      assert.isNull(other.flowId);
      const stolen = yield* harness.auth.controller
        .complete(otherOwner, { flowId: state.flowId!, callbackUrl })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(stolen));
      assert.equal(harness.forwarded(), 0);

      const verifying = yield* harness.auth.controller.complete(owner, {
        flowId: state.flowId!,
        callbackUrl,
      });
      assert.equal(verifying.phase, "verifying");
      assert.equal(harness.forwarded(), 1);
      assert.deepEqual(harness.catalog(), ["previous-account-model"]);

      yield* Deferred.succeed(harness.authenticated, undefined);
      yield* Deferred.succeed(harness.discovered, undefined);
      const succeeded = yield* phase(harness.auth, "succeeded");
      assert.deepEqual(harness.catalog(), ["gemini-test"]);
      assert.isNull(succeeded.authorizationUrl);
      assert.isNull(succeeded.expiresAt);
      assert.equal(harness.events.at(-1), "process-close");
    }),
  );

  it.effect(
    "distinguishes a post-authentication session failure without exposing its payload",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.auth.controller.start(owner);
        yield* phase(harness.auth, "waiting");
        yield* Deferred.succeed(harness.authenticated, undefined);
        yield* Deferred.fail(
          harness.discovered,
          new AcpErrors.AcpRequestError({
            code: -32603,
            errorMessage: `Internal error ${callbackUrl}`,
            method: "session/new",
          }),
        );
        const failed = yield* phase(harness.auth, "failed");
        assert.equal(
          failed.message,
          "Antigravity authenticated, but could not initialize a session or load models.",
        );
        assert.isNull(failed.authorizationUrl);
        assert.deepEqual(harness.catalog(), ["previous-account-model"]);
        yield* Deferred.await(harness.closed);
      }),
  );

  it.effect("does not call callback HTTP success a successful Google sign-in", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const state = yield* harness.auth.controller.start(owner);
      yield* phase(harness.auth, "waiting");
      yield* harness.auth.controller.complete(owner, { flowId: state.flowId!, callbackUrl });
      yield* Deferred.fail(
        harness.authenticated,
        AcpErrors.AcpRequestError.internalError(`access_denied ${callbackUrl}`),
      );
      const failed = yield* phase(harness.auth, "failed");
      assert.include(failed.message ?? "", "not approved");
      assert.notInclude(failed.message ?? "", "test-code");
      assert.isNull(failed.authorizationUrl);
      assert.deepEqual(harness.catalog(), ["previous-account-model"]);
      yield* Deferred.await(harness.closed);
    }),
  );

  it.effect("accepts direct local or cached completion without a callback RPC", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ interactive: false });
      yield* harness.auth.controller.start(owner);
      yield* Deferred.succeed(harness.authenticated, undefined);
      yield* Deferred.succeed(harness.discovered, undefined);
      yield* phase(harness.auth, "succeeded");
      assert.equal(harness.forwarded(), 0);
      assert.deepEqual(harness.catalog(), ["gemini-test"]);
    }),
  );

  it.effect("rejects mismatched callbacks without sending any HTTP request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const state = yield* harness.auth.controller.start(owner);
      yield* phase(harness.auth, "waiting");
      for (const invalidUrl of [
        callbackUrl.replace("51234", "51235"),
        callbackUrl.replace("test-state", "wrong-state"),
        callbackUrl.replace("/?", "/other?"),
        `${callbackUrl}&state=test-state`,
      ]) {
        const result = yield* harness.auth.controller
          .complete(owner, { flowId: state.flowId!, callbackUrl: invalidUrl })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(result));
      }
      assert.equal(harness.forwarded(), 0);
      assert.equal((yield* phase(harness.auth, "waiting")).authorizationUrl, authorizationUrl);
      yield* harness.auth.controller.cancel(owner, state.flowId!);
    }),
  );

  it.effect("fails the flow when delivery fails after the requesting client disconnects", () =>
    Effect.gen(function* () {
      const deliveryGate = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        forwardCallback: Deferred.await(deliveryGate).pipe(
          Effect.andThen(
            Effect.fail(
              new ProviderSetupError({
                instanceId,
                operation: "complete",
                detail: "loopback refused",
              }),
            ),
          ),
        ),
      });
      const state = yield* harness.auth.controller.start(owner);
      yield* phase(harness.auth, "waiting");
      // The client sends the callback, then its socket drops before Google answers.
      const request = yield* harness.auth.controller
        .complete(owner, { flowId: state.flowId!, callbackUrl })
        .pipe(Effect.forkScoped);
      yield* phase(harness.auth, "verifying");
      yield* Fiber.interrupt(request);
      yield* Deferred.succeed(deliveryGate, undefined);
      const failed = yield* phase(harness.auth, "failed");
      assert.include(failed.message ?? "", "Could not deliver");
      assert.isTrue(harness.events.includes("process-close"));
    }),
  );

  it.effect("cancel closes the owned process without forwarding a denial", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const state = yield* harness.auth.controller.start(owner);
      yield* phase(harness.auth, "waiting");
      const wrongOwner = yield* harness.auth.controller
        .cancel(otherOwner, state.flowId!)
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(wrongOwner));
      const cancelled = yield* harness.auth.controller.cancel(owner, state.flowId!);
      assert.equal(cancelled.phase, "cancelled");
      assert.isNull(cancelled.authorizationUrl);
      assert.equal(harness.forwarded(), 0);
      yield* Deferred.await(harness.closed);
      assert.deepEqual(harness.catalog(), ["previous-account-model"]);
    }),
  );

  it.effect("expires the flow at the official deadline and removes its URL", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const state = yield* harness.auth.controller.start(owner);
      yield* phase(harness.auth, "waiting");
      yield* TestClock.adjust("300 seconds");
      const failed = yield* phase(harness.auth, "failed");
      assert.include(failed.message ?? "", "expired");
      assert.isNull(failed.authorizationUrl);
      yield* Deferred.await(harness.closed);
      const late = yield* harness.auth.controller
        .complete(owner, { flowId: state.flowId!, callbackUrl })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(late));
      assert.equal(harness.forwarded(), 0);
    }),
  );

  it.effect("survives subscriber disconnect and does not replace a competing client's flow", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const first = yield* harness.auth.controller.start(owner);
      yield* phase(harness.auth, "waiting");
      const second = yield* harness.auth.controller.start(owner);
      assert.equal(first.flowId, second.flowId);
      const competing = yield* harness.auth.controller.start(otherOwner).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(competing));
      const resumed = yield* phase(harness.auth, "waiting");
      assert.equal(resumed.flowId, first.flowId);
      assert.deepEqual(harness.events, ["process-open", "authenticate"]);
      yield* harness.auth.controller.cancel(owner, first.flowId!);
    }),
  );

  it.effect("sign-out closes admission and every process before fresh native logout", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const processScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(processScope, Exit.void));
      const stop = Effect.gen(function* () {
        harness.events.push("chat-close");
        yield* Scope.close(processScope, Exit.void);
      });
      yield* harness.auth.withProcess(stop, Effect.void).pipe(Scope.provide(processScope));
      const stopSessions = Effect.gen(function* () {
        harness.events.push("sessions-stop");
        const denied = yield* harness.auth
          .withProcess(
            Effect.void,
            Effect.sync(() => harness.events.push("late-process")),
          )
          .pipe(Effect.scoped, Effect.exit);
        assert.isTrue(Exit.isFailure(denied));
      });
      const result = yield* harness.auth.controller.logout(stopSessions);
      assert.equal(result.phase, "idle");
      assert.deepEqual(harness.events, [
        "sessions-stop",
        "chat-close",
        "process-open",
        "initialize",
        "logout",
        "catalog-cleared",
        "process-close",
      ]);
      assert.deepEqual(harness.catalog(), []);
      yield* harness.auth.withProcess(Effect.void, Effect.void).pipe(Effect.scoped);
    }),
  );

  it.effect("signs out after a slow packaged runtime starts", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const initialized = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        beforeInitialize: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(initialized)),
        ),
      });
      const logout = yield* harness.auth.controller.logout(Effect.void).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("47 seconds");
      yield* Deferred.succeed(initialized, undefined);
      assert.equal((yield* Fiber.join(logout)).phase, "idle");
      assert.include(harness.events, "logout");
      assert.deepEqual(harness.catalog(), []);
      yield* Deferred.await(harness.closed);
    }),
  );

  it.effect("closes a stalled sign-out process without clearing its account catalog", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        beforeInitialize: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const logout = yield* harness.auth.controller
        .logout(Effect.void)
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("90 seconds");
      assert.isTrue(Exit.isFailure(yield* Fiber.join(logout)));
      yield* Deferred.await(harness.closed);
      assert.notInclude(harness.events, "logout");
      assert.deepEqual(harness.catalog(), ["previous-account-model"]);
      yield* harness.auth.withProcess(Effect.void, Effect.void).pipe(Effect.scoped);
    }),
  );

  it.effect(
    "sign-out interrupts startup without interrupting its caller after startup returns",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const entering = yield* Deferred.make<void>();
        const continueStartup = yield* Deferred.make<void>();
        const processScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(processScope, Exit.void));
        const task = Effect.gen(function* () {
          yield* Deferred.succeed(entering, undefined);
          yield* Deferred.await(continueStartup);
          harness.events.push("late-spawn");
        });
        const startup = yield* harness.auth
          .withProcess(Scope.close(processScope, Exit.void), task)
          .pipe(Scope.provide(processScope), Effect.forkScoped);
        yield* Deferred.await(entering);
        yield* harness.auth.controller.logout(Effect.void);
        yield* Deferred.succeed(continueStartup, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(startup)));
        assert.notInclude(harness.events, "late-spawn");
        assert.include(harness.events, "logout");
      }),
  );

  it.effect("failed session stopping still closes owned processes and skips native logout", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const processScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(processScope, Exit.void));
      const stop = Effect.gen(function* () {
        harness.events.push("chat-close");
        yield* Scope.close(processScope, Exit.void);
      });
      yield* harness.auth.withProcess(stop, Effect.void).pipe(Scope.provide(processScope));
      const result = yield* harness.auth.controller
        .logout(
          Effect.fail(
            new ProviderSetupError({
              instanceId,
              operation: "stopSessions",
              detail: "Stop failed.",
            }),
          ),
        )
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      assert.deepEqual(harness.events, ["chat-close"]);
      assert.deepEqual(harness.catalog(), ["previous-account-model"]);
    }),
  );

  it.effect("finishes sign-out when the requesting client disconnects", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const stopping = yield* Deferred.make<void>();
      const continueStop = yield* Deferred.make<void>();
      const request = yield* harness.auth.controller
        .logout(
          Effect.gen(function* () {
            yield* Deferred.succeed(stopping, undefined);
            yield* Deferred.await(continueStop);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(stopping);
      yield* Fiber.interrupt(request);
      yield* Deferred.succeed(continueStop, undefined);
      const result = yield* harness.auth.controller.subscribe(owner).pipe(
        Stream.filter((state) => state.message === "Signed out of Google."),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      assert.equal(result.phase, "idle");
      assert.deepEqual(harness.catalog(), []);
      assert.include(harness.events, "logout");
    }),
  );

  it.effect("does not call logout unless the official process advertises it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ supportsLogout: false });
      const result = yield* harness.auth.controller.logout(Effect.void).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      assert.deepEqual(harness.events, ["process-open", "initialize", "process-close"]);
      assert.deepEqual(harness.catalog(), ["previous-account-model"]);
    }),
  );
});
