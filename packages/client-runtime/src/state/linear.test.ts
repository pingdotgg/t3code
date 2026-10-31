import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { keepPrevious } from "./linear.ts";

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
