import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSetupError,
  type ProviderAuthInteraction,
  type ProviderAuthResponse,
  type ProviderAuthState,
} from "@t3tools/contracts";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderAuthFlow from "./ProviderAuthFlow.ts";

const instanceId = ProviderInstanceId.make("auth-flow-test");
const method = { id: "browser", name: "Browser", description: null, type: "agent" as const };

it.effect("distinguishes pending method discovery from an agent with no sign-in methods", () =>
  Effect.gen(function* () {
    const discovered = yield* Deferred.make<ReadonlyArray<typeof method>>();
    const controller = yield* ProviderAuthFlow.makeProviderAuthFlow({
      instanceId,
      credentialBinding: { owner: "provider", key: "shared-agent" },
      methods: Deferred.await(discovered),
      authenticate: () => Effect.void,
      logout: Effect.void,
    });
    const pending = yield* controller
      .subscribe("owner")
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
    assert.isUndefined(pending.methods);
    yield* Deferred.succeed(discovered, []);
    const ready = yield* controller.subscribe("owner").pipe(
      Stream.filter((state) => state.methods !== undefined),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    assert.deepEqual(ready.methods, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const makeHarness = Effect.gen(function* () {
  const approved = yield* Deferred.make<void>();
  const verified = yield* Deferred.make<void>();
  const started = yield* Deferred.make<void>();
  let attempts = 0;
  const controller = yield* ProviderAuthFlow.makeProviderAuthFlow({
    instanceId,
    credentialBinding: { owner: "provider", key: "shared-agent" },
    methods: Effect.succeed([method]),
    authenticate: (_, context) =>
      Effect.gen(function* () {
        attempts++;
        yield* context.setInteraction(
          {
            type: "browser",
            id: "consent",
            url: "https://example.com/login",
            requiresConsent: true,
          },
          (response) =>
            response.type === "browser" && response.action === "accept"
              ? Deferred.succeed(approved, undefined).pipe(Effect.asVoid)
              : Effect.void,
        );
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(approved);
        yield* context.verifying;
        yield* Deferred.await(verified);
      }),
    logout: Effect.void,
  });
  const phase = (phase: ProviderAuthState["phase"], owner = "owner") =>
    controller.subscribe(owner).pipe(
      Stream.filter((state) => state.phase === phase),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  return { controller, phase, started, verified, attempts: () => attempts };
});

it.effect("requires owner consent and provider verification before success", () =>
  Effect.gen(function* () {
    const { controller, phase, started, verified, attempts } = yield* makeHarness;
    const state = yield* controller.start("owner");
    yield* Deferred.await(started);
    const response = {
      instanceId,
      flowId: state.flowId!,
      interactionId: "consent",
      response: { type: "browser" as const, action: "accept" as const },
    };
    const other = yield* phase("waiting", "other");
    assert.isNull(other.interaction);
    assert.isNull(other.flowId);
    assert.isTrue(
      (yield* controller.respond!("other", response).pipe(Effect.result))._tag === "Failure",
    );
    assert.isTrue(
      (yield* controller.respond!("owner", { ...response, interactionId: "stale" }).pipe(
        Effect.result,
      ))._tag === "Failure",
    );
    yield* controller.start("owner");
    assert.strictEqual(attempts(), 1);
    yield* controller.respond!("owner", response);
    yield* phase("verifying");
    yield* Deferred.succeed(verified, undefined);
    assert.strictEqual((yield* phase("succeeded")).phase, "succeeded");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cancellation rejects late consent and permits another login", () =>
  Effect.gen(function* () {
    const { controller, started, phase } = yield* makeHarness;
    const state = yield* controller.start("owner");
    yield* Deferred.await(started);
    yield* controller.cancel("owner", state.flowId!);
    assert.strictEqual((yield* phase("cancelled")).phase, "cancelled");
    assert.isTrue(
      (yield* controller.respond!("owner", {
        instanceId,
        flowId: state.flowId!,
        interactionId: "consent",
        response: { type: "browser", action: "accept" },
      }).pipe(Effect.result))._tag === "Failure",
    );
    const next = yield* controller.start("other");
    assert.notStrictEqual(next.flowId, state.flowId);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("expires pending login and rejects its response", () =>
  Effect.gen(function* () {
    const { controller, started, phase } = yield* makeHarness;
    const state = yield* controller.start("owner");
    yield* Deferred.await(started);
    yield* TestClock.adjust(300_001);
    assert.include((yield* phase("failed")).message ?? "", "expired");
    assert.isTrue(
      (yield* controller.respond!("owner", {
        instanceId,
        flowId: state.flowId!,
        interactionId: "consent",
        response: { type: "browser", action: "accept" },
      }).pipe(Effect.result))._tag === "Failure",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("closes admitted provider processes and blocks new ones while login is pending", () =>
  Effect.gen(function* () {
    const { controller, started } = yield* makeHarness;
    let closed = false;
    yield* controller.withAccess!(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
        }),
      ),
    );
    yield* controller.start("owner");
    yield* Deferred.await(started);
    assert.isTrue(closed);
    assert.isTrue(
      (yield* controller.withAccess!(Effect.void).pipe(Effect.result))._tag === "Failure",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("shared credential invalidation closes admitted processes before permitting reuse", () =>
  Effect.gen(function* () {
    const { controller } = yield* makeHarness;
    let closed = false;
    yield* controller.withAccess!(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
        }),
      ),
    );
    yield* controller.invalidate!;
    assert.isTrue(closed);
    assert.strictEqual(yield* controller.withAccess!(Effect.succeed("new process")), "new process");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  {
    interaction: { type: "terminal", id: "terminal", output: "Log in" },
    response: { type: "terminal", data: "input", size: { cols: 80, rows: 24 } },
  },
  {
    interaction: {
      type: "credentials",
      id: "credentials",
      fields: [{ name: "token", label: "Token", secret: true }],
    },
    response: { type: "credentials", values: { token: "private-token" } },
  },
] satisfies ReadonlyArray<{
  interaction: ProviderAuthInteraction;
  response: ProviderAuthResponse;
}>)(
  "keeps $interaction.type responses private and waits for adapter verification",
  ({ interaction, response }) =>
    Effect.gen(function* () {
      const received = yield* Deferred.make<ProviderAuthResponse>();
      const controller = yield* ProviderAuthFlow.makeProviderAuthFlow({
        instanceId,
        credentialBinding: { owner: "t3", key: "binding" },
        methods: Effect.succeed([method]),
        authenticate: (_, context) =>
          Effect.gen(function* () {
            yield* context.setInteraction(interaction, (response) =>
              Deferred.succeed(received, response).pipe(Effect.asVoid),
            );
            yield* Deferred.await(received);
            yield* context.verifying;
            return yield* Effect.never;
          }),
        logout: Effect.void,
      });
      const state = yield* controller.start("owner");
      const pending = yield* controller.subscribe("owner").pipe(
        Stream.filter((state) => state.phase === "waiting"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      assert.deepStrictEqual(pending.interaction, interaction);
      const hidden = yield* controller
        .subscribe("other")
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      assert.isNull(hidden.interaction);
      yield* controller.respond!("owner", {
        instanceId,
        flowId: state.flowId!,
        interactionId: interaction.id,
        response,
      });
      assert.deepStrictEqual(yield* Deferred.await(received), response);
      const verifying = yield* controller.subscribe("owner").pipe(
        Stream.filter((state) => state.phase === "verifying"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      assert.isNull(verifying.interaction);
      assert.notInclude(verifying.message ?? "", "private-token");
      yield* controller.cancel("owner", state.flowId!);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("shows a device code only to its owner without treating it as authenticated", () =>
  Effect.gen(function* () {
    const controller = yield* ProviderAuthFlow.makeProviderAuthFlow({
      instanceId,
      credentialBinding: { owner: "provider", key: "device" },
      methods: Effect.succeed([method]),
      authenticate: (_, context) =>
        context
          .setInteraction({
            type: "deviceCode",
            id: "code",
            url: "https://example.com/device",
            userCode: "ABCD-EFGH",
          })
          .pipe(Effect.andThen(Effect.never)),
      logout: Effect.void,
    });
    const start = yield* controller.start("owner");
    const waiting = yield* controller.subscribe("owner").pipe(
      Stream.filter((state) => state.phase === "waiting"),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    assert.strictEqual(waiting.interaction?.type, "deviceCode");
    assert.strictEqual(waiting.authorizationUrl, "https://example.com/device");
    const other = yield* controller
      .subscribe("other")
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
    assert.isNull(other.interaction);
    assert.isNull(other.authorizationUrl);
    yield* controller.cancel("owner", start.flowId!);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  {
    failure: Effect.fail(
      new ProviderSetupError({
        instanceId,
        operation: "authenticate",
        detail: "This account cannot sign in. Choose another account.",
      }),
    ),
    message: "This account cannot sign in. Choose another account.",
  },
  {
    failure: Effect.die(new Error("private-token in native diagnostics")),
    message: "Sign-in failed. Start again.",
  },
])("publishes only safe authentication failure text %#", ({ failure, message }) =>
  Effect.gen(function* () {
    const controller = yield* ProviderAuthFlow.makeProviderAuthFlow({
      instanceId,
      credentialBinding: { owner: "t3", key: "failure" },
      methods: Effect.succeed([method]),
      authenticate: () => failure,
      logout: Effect.void,
    });
    yield* controller.start("owner");
    const failed = yield* controller.subscribe("owner").pipe(
      Stream.filter((state) => state.phase === "failed"),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    assert.strictEqual(failed.message, message);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const makeBlockingResponseHarness = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const cleanupStarted = yield* Deferred.make<void>();
  const cleanupReleased = yield* Deferred.make<void>();
  const cleanupFinished = yield* Deferred.make<void>();
  const authenticationFinished = yield* Deferred.make<void>();
  let responses = 0;
  const controller = yield* ProviderAuthFlow.makeProviderAuthFlow({
    instanceId,
    credentialBinding: { owner: "t3", key: "blocked-response" },
    methods: Effect.succeed([method]),
    authenticate: (_, context) =>
      Effect.gen(function* () {
        yield* context.setInteraction(
          {
            type: "browser",
            id: "blocked",
            url: "https://example.com/login",
            requiresConsent: true,
          },
          () =>
            Effect.gen(function* () {
              responses++;
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }).pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* Deferred.succeed(cleanupStarted, undefined);
                  yield* Deferred.await(cleanupReleased);
                  yield* Deferred.succeed(cleanupFinished, undefined);
                }),
              ),
            ),
        );
        yield* Deferred.await(authenticationFinished);
      }),
    logout: Effect.void,
  });
  const start = yield* controller.start("owner");
  yield* controller.subscribe("owner").pipe(
    Stream.filter((state) => state.phase === "waiting"),
    Stream.runHead,
  );
  const input = {
    instanceId,
    flowId: start.flowId!,
    interactionId: "blocked",
    response: { type: "browser" as const, action: "accept" as const },
  };
  const response = yield* controller.respond!("owner", input).pipe(Effect.exit, Effect.forkChild);
  yield* Deferred.await(entered);
  return {
    controller,
    input,
    response,
    cleanupStarted,
    cleanupReleased,
    cleanupFinished,
    authenticationFinished,
    responses: () => responses,
  };
});

it.effect.each(["cancel", "logout"] as const)(
  "%s interrupts and awaits a blocked adapter response before admitting another sign-in",
  (action) =>
    Effect.gen(function* () {
      const harness = yield* makeBlockingResponseHarness;
      const duplicate = yield* Effect.flip(harness.controller.respond!("owner", harness.input));
      assert.include(duplicate.detail, "already in progress");
      assert.equal(harness.responses(), 1);
      const stopping = yield* (
        action === "cancel"
          ? harness.controller.cancel("owner", harness.input.flowId)
          : harness.controller.logout(Effect.void)
      ).pipe(Effect.forkChild);
      yield* Deferred.await(harness.cleanupStarted);
      assert.isTrue(yield* harness.controller.isChangingCredentials!);
      assert.isUndefined(stopping.pollUnsafe());
      const premature = yield* Effect.flip(harness.controller.start("other"));
      assert.include(premature.detail, "in progress");
      yield* Deferred.succeed(harness.cleanupReleased, undefined);
      yield* Fiber.join(stopping);
      assert.isTrue(yield* Deferred.isDone(harness.cleanupFinished));
      assert.isTrue(Exit.isFailure(yield* Fiber.join(harness.response)));
      assert.isFalse(yield* harness.controller.isChangingCredentials!);
      assert.notEqual((yield* harness.controller.start("other")).flowId, harness.input.flowId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("timeout interrupts and drains a blocked response before publishing failure", () =>
  Effect.gen(function* () {
    const harness = yield* makeBlockingResponseHarness;
    yield* TestClock.adjust(300_001);
    yield* Deferred.await(harness.cleanupStarted);
    assert.isTrue(yield* harness.controller.isChangingCredentials!);
    const duringCleanup = yield* harness.controller
      .subscribe("owner")
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
    assert.notEqual(duringCleanup.phase, "failed");
    yield* Deferred.succeed(harness.cleanupReleased, undefined);
    const failed = yield* harness.controller.subscribe("owner").pipe(
      Stream.filter((state) => state.phase === "failed"),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    assert.include(failed.message ?? "", "expired");
    assert.isTrue(yield* Deferred.isDone(harness.cleanupFinished));
    assert.isTrue(Exit.isFailure(yield* Fiber.join(harness.response)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "successful authentication drains a still-running response before admitting provider access",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeBlockingResponseHarness;
      yield* Deferred.succeed(harness.authenticationFinished, undefined);
      yield* Deferred.await(harness.cleanupStarted);
      const denied = yield* Effect.flip(harness.controller.withAccess!(Effect.void));
      assert.include(denied.detail, "changing");
      yield* Deferred.succeed(harness.cleanupReleased, undefined);
      const succeeded = yield* harness.controller.subscribe("owner").pipe(
        Stream.filter((state) => state.phase === "succeeded"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      assert.equal(succeeded.phase, "succeeded");
      assert.isTrue(yield* Deferred.isDone(harness.cleanupFinished));
      assert.isTrue(Exit.isFailure(yield* Fiber.join(harness.response)));
      yield* harness.controller.withAccess!(Effect.void);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("closing the controller scope interrupts and drains its adapter response", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const harness = yield* makeBlockingResponseHarness.pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
    yield* Deferred.await(harness.cleanupStarted);
    assert.isUndefined(closing.pollUnsafe());
    yield* Deferred.succeed(harness.cleanupReleased, undefined);
    yield* Fiber.join(closing);
    assert.isTrue(yield* Deferred.isDone(harness.cleanupFinished));
    assert.isTrue(Exit.isFailure(yield* Fiber.join(harness.response)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a failed method refresh keeps the last discovered methods", () =>
  Effect.gen(function* () {
    let fail = false;
    const controller = yield* ProviderAuthFlow.makeProviderAuthFlow({
      instanceId,
      credentialBinding: { owner: "provider", key: "shared-agent" },
      methods: Effect.suspend(() =>
        fail
          ? Effect.fail(
              new ProviderSetupError({ instanceId, operation: "status", detail: "interrupted" }),
            )
          : Effect.succeed([method]),
      ),
      authenticate: () => Effect.void,
      logout: Effect.void,
    });
    yield* controller.refreshMethods!;
    fail = true;
    yield* controller.refreshMethods!;
    const state = yield* controller
      .subscribe("owner")
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
    assert.deepEqual(state.methods, [method]);
    assert.strictEqual(state.message, "interrupted");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rebuilding a controller leaves sessions it admitted to their owners", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const { controller } = yield* makeHarness.pipe(Effect.provideService(Scope.Scope, scope));
    let closed = false;
    yield* controller.withAccess!(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
        }),
      ),
    );
    yield* Scope.close(scope, Exit.void);
    assert.isFalse(closed);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
