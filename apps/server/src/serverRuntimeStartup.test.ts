import { assert, it } from "@effect/vitest";
import { DEFAULT_MODEL, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

it("uses the canonical Codex model for auto-bootstrap", () => {
  assert.deepEqual(ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("runs projection repair, recovery, worker startup, and bootstrap in order", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (label: string) => Ref.update(calls, (current) => [...current, label]);

    const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      verify: record("verify").pipe(Effect.as({ valid: false })),
      rebuild: record("rebuild").pipe(Effect.as({ valid: true })),
      recover: record("recover").pipe(Effect.as({ closedRequests: 2 })),
      startEffectWorker: record("worker"),
      autoBootstrap: record("bootstrap").pipe(Effect.as({ projectId: "project-1" })),
    });

    assert.deepEqual(yield* Ref.get(calls), [
      "verify",
      "rebuild",
      "recover",
      "worker",
      "bootstrap",
    ]);
    assert.deepEqual(result, {
      recovery: { closedRequests: 2 },
      bootstrap: { projectId: "project-1" },
    });
  }),
);

it.effect("does not rebuild valid projections", () =>
  Effect.gen(function* () {
    const rebuilt = yield* Ref.make(false);
    yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      verify: Effect.succeed({ valid: true }),
      rebuild: Ref.set(rebuilt, true).pipe(Effect.as({ valid: true })),
      recover: Effect.void,
      startEffectWorker: Effect.void,
      autoBootstrap: Effect.void,
    });
    assert.isFalse(yield* Ref.get(rebuilt));
  }),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
    }),
  ),
);
