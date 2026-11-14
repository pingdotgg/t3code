import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { waitForQuerySettled } from "./waitForQuerySettled";

const settle = (value: number | null) =>
  value !== null && value >= 2 ? `settled:${value}` : undefined;

describe("waitForQuerySettled", () => {
  it("resolves with the first settled value", async () => {
    const registry = AtomRegistry.make();
    const atom = Atom.make(AsyncResult.success<number, string>(1));
    const result = waitForQuerySettled({
      registry,
      atom,
      settle,
      signal: new AbortController().signal,
    });
    registry.set(atom, AsyncResult.success(2));
    registry.set(atom, AsyncResult.success(3));
    expect(await result).toBe("settled:2");
  });

  it("resolves at once when the current value already settles", async () => {
    const registry = AtomRegistry.make();
    const atom = Atom.make(AsyncResult.success<number, string>(5));
    expect(
      await waitForQuerySettled({ registry, atom, settle, signal: new AbortController().signal }),
    ).toBe("settled:5");
  });

  it("resolves undefined when aborted", async () => {
    const registry = AtomRegistry.make();
    const atom = Atom.make(AsyncResult.success<number, string>(1));
    const controller = new AbortController();
    const result = waitForQuerySettled({ registry, atom, settle, signal: controller.signal });
    controller.abort();
    registry.set(atom, AsyncResult.success(2));
    expect(await result).toBeUndefined();
  });

  it("resolves undefined when the query fails, even before any success", async () => {
    const registry = AtomRegistry.make();
    const atom = Atom.make<AsyncResult.AsyncResult<number, string>>(AsyncResult.initial());
    const result = waitForQuerySettled({
      registry,
      atom,
      settle,
      signal: new AbortController().signal,
    });
    registry.set(atom, AsyncResult.failure(Cause.fail("stream closed")));
    registry.set(atom, AsyncResult.success(2));
    expect(await result).toBeUndefined();
  });
});
