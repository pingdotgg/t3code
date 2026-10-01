import { describe, expect, it, vi } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { hotSwappableAtomRuntime } from "./hot-swappable-atom-runtime";

class RuntimeValue extends Context.Service<RuntimeValue, { readonly value: string }>()(
  "t3/mobile/test/RuntimeValue",
) {}

function runtimeLayer(value: string, events: string[]) {
  return Layer.effect(
    RuntimeValue,
    Effect.acquireRelease(
      Effect.sync(() => {
        events.push(`acquire:${value}`);
        return RuntimeValue.of({ value });
      }),
      () =>
        Effect.sync(() => {
          events.push(`release:${value}`);
        }),
    ),
  );
}

function runtimeLayerWithRelease(
  value: string,
  events: string[],
  release: Effect.Effect<void> = Effect.sync(() => {
    events.push(`release:${value}`);
  }),
) {
  return Layer.effect(
    RuntimeValue,
    Effect.acquireRelease(
      Effect.sync(() => {
        events.push(`acquire:${value}`);
        return RuntimeValue.of({ value });
      }),
      () => release,
    ),
  );
}

describe("hotSwappableAtomRuntime", () => {
  it("rebuilds a mounted runtime in place without disturbing unrelated subscribers", () => {
    vi.stubGlobal("__DEV__", true);
    const registry = AtomRegistry.make();
    const accept = () => {};
    const events: string[] = [];
    const id = `test-${crypto.randomUUID()}`;
    const runtime = hotSwappableAtomRuntime({
      id,
      hotModule: { accept },
      registry,
      layer: runtimeLayer("first", events),
    });
    const valueAtom = runtime.atom(RuntimeValue.pipe(Effect.map((service) => service.value)));
    const values: string[] = [];
    const unsubscribeRuntime = registry.subscribe(
      valueAtom,
      (result) => {
        if (AsyncResult.isSuccess(result)) values.push(result.value);
      },
      { immediate: true },
    );
    const unrelatedAtom = Atom.make(0);
    const unrelatedValues: number[] = [];
    const unsubscribeUnrelated = registry.subscribe(unrelatedAtom, (value) => {
      unrelatedValues.push(value);
    });
    registry.set(unrelatedAtom, 7);
    const unwatchedDraftAtom = Atom.make("saved");
    registry.set(unwatchedDraftAtom, "edited");
    const nodesBefore = registry.getNodes().size;

    const replacement = hotSwappableAtomRuntime({
      id,
      hotModule: { accept },
      registry,
      layer: runtimeLayer("second", events),
    });
    hotSwappableAtomRuntime({
      id,
      hotModule: { accept },
      registry,
      layer: runtimeLayer("third", events),
    });
    registry.set(unrelatedAtom, 8);

    expect(replacement).toBe(runtime);
    expect(events).toEqual([
      "acquire:first",
      "release:first",
      "acquire:second",
      "release:second",
      "acquire:third",
    ]);
    expect(values).toEqual(["first", "second", "third"]);
    expect(registry.get(unwatchedDraftAtom)).toBe("edited");
    expect(unrelatedValues).toEqual([7, 8]);
    expect(registry.getNodes().size).toBe(nodesBefore);
    unsubscribeRuntime();
    unsubscribeUnrelated();
    registry.dispose();
    expect(events).toEqual([
      "acquire:first",
      "release:first",
      "acquire:second",
      "release:second",
      "acquire:third",
      "release:third",
    ]);
  });

  it("does not retain or accept a runtime outside development", () => {
    vi.stubGlobal("__DEV__", false);
    const registry = AtomRegistry.make();
    const accept = vi.fn();
    const layer = runtimeLayer("production", []);

    const first = hotSwappableAtomRuntime({
      id: "production",
      hotModule: { accept },
      registry,
      layer,
    });
    const second = hotSwappableAtomRuntime({
      id: "production",
      hotModule: { accept },
      registry,
      layer,
    });

    expect(second).not.toBe(first);
    expect(accept).not.toHaveBeenCalled();
    registry.dispose();
  });

  it("starts an asynchronous old-layer release while exposing the fresh context", async () => {
    vi.stubGlobal("__DEV__", true);
    const registry = AtomRegistry.make();
    const events: string[] = [];
    const id = `test-${crypto.randomUUID()}`;
    let finishRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    let markReleaseComplete!: () => void;
    const releaseComplete = new Promise<void>((resolve) => {
      markReleaseComplete = resolve;
    });
    const firstRelease = Effect.promise(async () => {
      events.push("release:start:first");
      await releaseGate;
      events.push("release:end:first");
      markReleaseComplete();
    });
    const runtime = hotSwappableAtomRuntime({
      id,
      hotModule: { accept() {} },
      registry,
      layer: runtimeLayerWithRelease("first", events, firstRelease),
    });
    const valueAtom = runtime.atom(RuntimeValue.pipe(Effect.map((service) => service.value)));
    const values: string[] = [];
    const unsubscribe = registry.subscribe(valueAtom, (result) => {
      if (AsyncResult.isSuccess(result)) values.push(result.value);
    });
    registry.get(valueAtom);

    hotSwappableAtomRuntime({
      id,
      hotModule: { accept() {} },
      registry,
      layer: runtimeLayer("second", events),
    });

    expect(events).toEqual(["acquire:first", "release:start:first", "acquire:second"]);
    expect(values).toEqual(["first", "second"]);

    finishRelease();
    await releaseComplete;
    expect(events).toEqual([
      "acquire:first",
      "release:start:first",
      "acquire:second",
      "release:end:first",
    ]);

    unsubscribe();
    registry.dispose();
  });
});
