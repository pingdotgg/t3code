import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { connectionAtomRuntime } from "./runtime";

function visit(path: string): Disposable {
  const previous = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(window.history.state, "", path);
  return {
    [Symbol.dispose]: () => window.history.replaceState(window.history.state, "", previous),
  };
}

describe("connectionAtomRuntime", () => {
  it("connects to no environment on the guest page", async () => {
    using _page = visit("/guest?share=share-1");
    using socket = vi.spyOn(window, "WebSocket");
    const registry = AtomRegistry.make();
    using _mounted = { [Symbol.dispose]: registry.mount(connectionAtomRuntime) };
    await vi.waitFor(() => {
      const result = registry.get(connectionAtomRuntime);
      expect(AsyncResult.isFailure(result) && String(Cause.squash(result.cause))).toContain(
        "The guest page has no environment connection.",
      );
    });
    expect(socket).not.toHaveBeenCalled();
  });
});
