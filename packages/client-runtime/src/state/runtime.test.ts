import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  environmentRpcKey,
  createAtomCommandScheduler,
  createRuntimeCommand,
  executeAtomCommand,
  executeAtomQuery,
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "./runtime.ts";

describe("settleAsyncResult", () => {
  it("preserves successful values and typed failures", async () => {
    const success = await settleAsyncResult(() => Promise.resolve(Exit.succeed("done")));
    expect(AsyncResult.isSuccess(success)).toBe(true);
    if (AsyncResult.isSuccess(success)) {
      expect(success.value).toBe("done");
    }

    const expectedFailure = new Error("request failed");
    const failure = await settleAsyncResult(() => Promise.resolve(Exit.fail(expectedFailure)));
    expect(AsyncResult.isFailure(failure)).toBe(true);
    if (AsyncResult.isFailure(failure)) {
      expect(Cause.hasDies(failure.cause)).toBe(false);
      expect(Cause.squash(failure.cause)).toBe(expectedFailure);
    }
  });

  it("encodes thrown and rejected promises as defects", async () => {
    const thrownDefect = new Error("thrown defect");
    const thrown = await settleAsyncResult<void, never>(() => {
      throw thrownDefect;
    });
    expect(AsyncResult.isFailure(thrown)).toBe(true);
    if (AsyncResult.isFailure(thrown)) {
      expect(Cause.hasDies(thrown.cause)).toBe(true);
      expect(Cause.squash(thrown.cause)).toBe(thrownDefect);
    }

    const rejectedDefect = new Error("rejected defect");
    const rejected = await settleAsyncResult<void, never>(() => Promise.reject(rejectedDefect));
    expect(AsyncResult.isFailure(rejected)).toBe(true);
    if (AsyncResult.isFailure(rejected)) {
      expect(Cause.hasDies(rejected.cause)).toBe(true);
      expect(Cause.squash(rejected.cause)).toBe(rejectedDefect);
    }
  });
});

describe("atom command result helpers", () => {
  it("maps successful command values", () => {
    const result = mapAtomCommandResult(AsyncResult.success(2), (value) => value * 3);

    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.value).toBe(6);
    }
  });

  it("preserves failures while mapping", () => {
    const result = mapAtomCommandResult(
      AsyncResult.failure<number, string>(Cause.fail("nope")),
      (value) => value * 3,
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(Cause.squash(result.cause)).toBe("nope");
    }
  });

  it("distinguishes interruption from other failures", () => {
    const interrupted = AsyncResult.failure(Cause.interrupt(1));
    const failed = AsyncResult.failure(Cause.fail("nope"));

    expect(isAtomCommandInterrupted(interrupted)).toBe(true);
    expect(isAtomCommandInterrupted(failed)).toBe(false);
    expect(squashAtomCommandFailure(failed)).toBe("nope");
  });

  it("settles raw promise boundaries as successes or defects", async () => {
    const success = await settlePromise(() => Promise.resolve("done"));
    expect(success._tag).toBe("Success");

    const defect = new Error("raw promise rejected");
    const failure = await settlePromise(() => Promise.reject(defect));
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect(Cause.hasDies(failure.cause)).toBe(true);
      expect(Cause.squash(failure.cause)).toBe(defect);
    }
  });

  it("reports expected failures and defects through separate policies", async () => {
    const warnings: string[] = [];
    const errors: string[] = [];
    const reporter = {
      warn: (message: string) => {
        warnings.push(message);
      },
      error: (message: string) => {
        errors.push(message);
      },
    };

    await executeAtomCommand(() => Promise.resolve(Exit.fail("nope")), { label: "save" }, reporter);
    await executeAtomCommand(
      () => Promise.resolve(Exit.fail("ignored")),
      { label: "quiet save", reportFailure: false },
      reporter,
    );
    await executeAtomCommand(
      () => Promise.reject(new Error("defect")),
      { label: "quiet save", reportFailure: false },
      reporter,
    );
    await executeAtomCommand(
      () => Promise.resolve(Exit.interrupt(1)),
      { label: "interrupted" },
      reporter,
    );

    expect(warnings).toEqual(["[atom-command] save failed"]);
    expect(errors).toEqual(["[atom-command] quiet save defected"]);
  });
});

describe("environmentRpcKey", () => {
  it("isolates subscription state by environment and cwd", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const originalTarget = {
      environmentId,
      input: { cwd: "/repo/original" },
    };
    const nextTarget = {
      environmentId,
      input: { cwd: "/repo/next" },
    };

    expect(environmentRpcKey(originalTarget)).not.toBe(environmentRpcKey(nextTarget));
    expect(environmentRpcKey(originalTarget)).toBe(environmentRpcKey({ ...originalTarget }));
    expect(
      environmentRpcKey({
        environmentId: EnvironmentId.make("environment-2"),
        input: originalTarget.input,
      }),
    ).not.toBe(environmentRpcKey(originalTarget));
    expect(environmentRpcKey({ ...originalTarget, cacheKey: "clean" })).not.toBe(
      environmentRpcKey({ ...originalTarget, cacheKey: "dirty" }),
    );
  });
});

describe("Atom.fn mutation semantics", () => {
  it.effect("interrupts the previous invocation when the same mutation atom is written again", () =>
    Effect.gen(function* () {
      const firstLatch = Latch.makeUnsafe();
      const secondLatch = Latch.makeUnsafe();
      const interrupted: string[] = [];
      const mutation = Atom.fn((id: "first" | "second") =>
        (id === "first" ? firstLatch : secondLatch).await.pipe(
          Effect.as(id),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted.push(id);
            }),
          ),
        ),
      );
      const registry = AtomRegistry.make();
      const unmount = registry.mount(mutation);

      registry.set(mutation, "first");
      registry.set(mutation, "second");
      yield* Effect.yieldNow;

      expect(interrupted).toEqual(["first"]);

      secondLatch.openUnsafe();
      expect(
        yield* AtomRegistry.getResult(registry, mutation, {
          suspendOnWaiting: true,
        }),
      ).toBe("second");

      unmount();
      registry.dispose();
    }),
  );

  it.effect("keeps stream mutations waiting until the final emitted value", () =>
    Effect.gen(function* () {
      const completionLatch = Latch.makeUnsafe();
      const mutation = Atom.fn(() =>
        Stream.make("progress").pipe(
          Stream.concat(Stream.fromEffect(completionLatch.await.pipe(Effect.as("done")))),
        ),
      );
      const registry = AtomRegistry.make();
      const unmount = registry.mount(mutation);

      registry.set(mutation, undefined);

      const progress = registry.get(mutation);
      expect(AsyncResult.isSuccess(progress)).toBe(true);
      if (AsyncResult.isSuccess(progress)) {
        expect(progress.value).toBe("progress");
        expect(progress.waiting).toBe(true);
      }

      completionLatch.openUnsafe();
      expect(
        yield* AtomRegistry.getResult(registry, mutation, {
          suspendOnWaiting: true,
        }),
      ).toBe("done");

      unmount();
      registry.dispose();
    }),
  );

  it.effect(
    "allows concurrent effects to finish but does not correlate results to individual writes",
    () =>
      Effect.gen(function* () {
        const firstLatch = Latch.makeUnsafe();
        const secondLatch = Latch.makeUnsafe();
        const mutation = Atom.fn<never, "first" | "second", "first" | "second">(
          (id: "first" | "second") =>
            (id === "first" ? firstLatch : secondLatch).await.pipe(Effect.as(id)),
          { concurrent: true },
        );
        const registry = AtomRegistry.make();
        const unmount = registry.mount(mutation);

        registry.set(mutation, "first");
        const firstResult = yield* AtomRegistry.getResult(registry, mutation, {
          suspendOnWaiting: true,
        }).pipe(Effect.forkChild({ startImmediately: true }));
        registry.set(mutation, "second");
        const secondResult = yield* AtomRegistry.getResult(registry, mutation, {
          suspendOnWaiting: true,
        }).pipe(Effect.forkChild({ startImmediately: true }));

        secondLatch.openUnsafe();
        yield* Effect.yieldNow;

        const stillWaiting = registry.get(mutation);
        expect(stillWaiting.waiting).toBe(true);

        firstLatch.openUnsafe();

        expect(yield* Fiber.join(firstResult)).toBe("first");
        expect(yield* Fiber.join(secondResult)).toBe("first");

        unmount();
        registry.dispose();
      }),
  );
});

describe("executeAtomQuery", () => {
  it("keeps concurrent query results correlated to their atoms", async () => {
    const firstLatch = Latch.makeUnsafe();
    const secondLatch = Latch.makeUnsafe();
    const firstAtom = Atom.make(firstLatch.await.pipe(Effect.as("first")));
    const secondAtom = Atom.make(secondLatch.await.pipe(Effect.as("second")));
    const registry = AtomRegistry.make();

    const firstResult = executeAtomQuery(registry, firstAtom);
    const secondResult = executeAtomQuery(registry, secondAtom);

    secondLatch.openUnsafe();
    firstLatch.openUnsafe();

    const [first, second] = await Promise.all([firstResult, secondResult]);
    expect(first._tag).toBe("Success");
    expect(second._tag).toBe("Success");
    if (first._tag === "Success" && second._tag === "Success") {
      expect(first.value).toBe("first");
      expect(second.value).toBe("second");
    }

    registry.dispose();
  });
});

describe("runtime command runner", () => {
  it("encodes custom command rejections as defects", async () => {
    const defect = new Error("custom command rejected");
    const registry = AtomRegistry.make();
    const result = await runAtomCommand(
      registry,
      {
        label: "test.rejected-command",
        run: () => Promise.reject(defect),
      },
      undefined,
      { reportDefect: false },
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(Cause.hasDies(result.cause)).toBe(true);
      expect(Cause.squash(result.cause)).toBe(defect);
    }
    registry.dispose();
  });

  it("settles generated command scheduler defects from direct callers", async () => {
    const defect = new Error("invalid command key");
    const runtime = Atom.runtime(Layer.empty);
    const command = createRuntimeCommand(runtime, {
      label: "test.invalid-key",
      concurrency: {
        mode: "serial",
        key: () => {
          throw defect;
        },
      },
      execute: () => Effect.void,
    });
    const registry = AtomRegistry.make();

    const result = await command.run(registry, undefined);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(Cause.hasDies(result.cause)).toBe(true);
      expect(Cause.squash(result.cause)).toBe(defect);
    }
    registry.dispose();
  });

  it("correlates parallel invocation results", async () => {
    const firstLatch = Latch.makeUnsafe();
    const secondLatch = Latch.makeUnsafe();
    const runtime = Atom.runtime(Layer.empty);
    const command = createRuntimeCommand(runtime, {
      label: "test.parallel",
      execute: (id: "first" | "second") =>
        (id === "first" ? firstLatch : secondLatch).await.pipe(Effect.as(id)),
    });
    const registry = AtomRegistry.make();

    const first = command.run(registry, "first");
    const second = command.run(registry, "second");
    secondLatch.openUnsafe();
    firstLatch.openUnsafe();

    expect(await first).toMatchObject({ _tag: "Success", value: "first", waiting: false });
    expect(await second).toMatchObject({ _tag: "Success", value: "second", waiting: false });
    registry.dispose();
  });

  it("serializes commands that share a scheduler and lane", async () => {
    const firstLatch = Latch.makeUnsafe();
    const events: string[] = [];
    const runtime = Atom.runtime(Layer.empty);
    const scheduler = createAtomCommandScheduler();
    const concurrency = { mode: "serial" as const, key: () => "shared" };
    const firstCommand = createRuntimeCommand(runtime, {
      label: "test.first",
      scheduler,
      concurrency,
      execute: () =>
        Effect.sync(() => events.push("first:start")).pipe(
          Effect.andThen(firstLatch.await),
          Effect.tap(() => Effect.sync(() => events.push("first:end"))),
        ),
    });
    const secondCommand = createRuntimeCommand(runtime, {
      label: "test.second",
      scheduler,
      concurrency,
      execute: () => Effect.sync(() => events.push("second:start")),
    });
    const registry = AtomRegistry.make();

    const first = firstCommand.run(registry, undefined);
    const second = secondCommand.run(registry, undefined);
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    firstLatch.openUnsafe();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    registry.dispose();
  });

  it("deduplicates single-flight commands by key", async () => {
    const latch = Latch.makeUnsafe();
    let executions = 0;
    const runtime = Atom.runtime(Layer.empty);
    const command = createRuntimeCommand(runtime, {
      label: "test.single-flight",
      concurrency: { mode: "singleFlight", key: (key: string) => key },
      execute: () =>
        Effect.sync(() => executions++).pipe(Effect.andThen(latch.await), Effect.as("done")),
    });
    const registry = AtomRegistry.make();

    const first = command.run(registry, "same");
    const second = command.run(registry, "same");
    latch.openUnsafe();

    expect(await first).toMatchObject({ _tag: "Success", value: "done", waiting: false });
    expect(await second).toMatchObject({ _tag: "Success", value: "done", waiting: false });
    expect(executions).toBe(1);
    registry.dispose();
  });

  it("coalesces pending latest-value commands without interrupting the active call", async () => {
    const firstLatch = Latch.makeUnsafe();
    const executed: number[] = [];
    const runtime = Atom.runtime(Layer.empty);
    const command = createRuntimeCommand(runtime, {
      label: "test.latest",
      concurrency: { mode: "latest", key: () => "shared" },
      execute: (value: number) =>
        Effect.sync(() => executed.push(value)).pipe(
          Effect.andThen(value === 1 ? firstLatch.await : Effect.void),
          Effect.as(value),
        ),
    });
    const registry = AtomRegistry.make();

    const first = command.run(registry, 1);
    await Promise.resolve();
    const second = command.run(registry, 2);
    const third = command.run(registry, 3);
    firstLatch.openUnsafe();

    expect(await first).toMatchObject({ _tag: "Success", value: 1, waiting: false });
    expect(await second).toMatchObject({ _tag: "Success", value: 3, waiting: false });
    expect(await third).toMatchObject({ _tag: "Success", value: 3, waiting: false });
    expect(executed).toEqual([1, 3]);
    registry.dispose();
  });
});
