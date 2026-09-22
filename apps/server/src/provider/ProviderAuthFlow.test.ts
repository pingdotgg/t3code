import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeProviderAuthFlow } from "./ProviderAuthFlow.ts";

const instanceId = ProviderInstanceId.make("auth-flow-test");
const method = { id: "browser", name: "Browser", description: null, type: "agent" as const };

it.effect("distinguishes pending method discovery from an agent with no sign-in methods", () =>
  Effect.gen(function* () {
    const discovered = yield* Deferred.make<ReadonlyArray<typeof method>>();
    const controller = yield* makeProviderAuthFlow({
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
  const controller = yield* makeProviderAuthFlow({
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
    assert.strictEqual((yield* phase("failed")).phase, "failed");
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
