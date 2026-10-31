import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { keepPrevious, linearRefreshSignal } from "./linear.ts";

it("refreshing the keep-previous wrapper re-runs the underlying query", () => {
  let runs = 0;
  const source = Atom.make(Effect.sync(() => ++runs));
  const wrapped = keepPrevious((_: string) => source)("status");
  const registry = AtomRegistry.make();
  const unmount = registry.mount(wrapped);

  expect(AsyncResult.getOrElse(registry.get(wrapped), () => -1)).toBe(1);
  registry.refresh(wrapped);
  expect(AsyncResult.getOrElse(registry.get(wrapped), () => -1)).toBe(2);
  unmount();
});

it("the refresh signal changes on a server push as well as on a poll tick", () => {
  const refreshes = Atom.make<AsyncResult.AsyncResult<number, never>>(AsyncResult.initial());
  const pollTick = Atom.make(0);
  const signal = linearRefreshSignal(refreshes, pollTick);
  const registry = AtomRegistry.make();
  const unmount = registry.mount(signal);

  const initial = registry.get(signal);
  registry.set(refreshes, AsyncResult.success(1));
  const afterPush = registry.get(signal);
  expect(afterPush).not.toBe(initial);
  registry.set(pollTick, 1);
  expect(registry.get(signal)).not.toBe(afterPush);
  unmount();
});
