import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createVcsStatusRevalidationAtomFamily } from "./vcsStatusRevalidation.ts";

const environmentId = EnvironmentId.make("environment-1");

function setup(options: { readonly connected: boolean }) {
  const connectedAtom = Atom.make(options.connected);
  const run = vi.fn(async () => AsyncResult.success(null));
  const family = createVcsStatusRevalidationAtomFamily({
    refreshStatus: { label: "refresh-status", run },
    connected: () => connectedAtom,
  });
  const registry = AtomRegistry.make();
  return { registry, family, connectedAtom, run };
}

describe("createVcsStatusRevalidationAtomFamily", () => {
  it("refreshes once per connection, shared by every subscriber, and again on reconnect", () => {
    const { registry, family, connectedAtom, run } = setup({ connected: true });
    const target = { environmentId, cwd: "/repo" };
    const first = registry.mount(family(target));
    const second = registry.mount(family({ environmentId, cwd: "/repo" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.anything(), { environmentId, input: { cwd: "/repo" } });

    registry.set(connectedAtom, false);
    expect(run).toHaveBeenCalledTimes(1);
    registry.set(connectedAtom, true);
    expect(run).toHaveBeenCalledTimes(2);

    registry.mount(family({ environmentId, cwd: "/other" }))();
    expect(run).toHaveBeenCalledTimes(3);
    first();
    second();
  });

  it("waits for the connection before the first refresh", () => {
    const { registry, family, connectedAtom, run } = setup({ connected: false });
    const unmount = registry.mount(family({ environmentId, cwd: "/repo" }));
    expect(run).not.toHaveBeenCalled();
    registry.set(connectedAtom, true);
    expect(run).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("does nothing for an idle target", () => {
    const { registry, family, run } = setup({ connected: true });
    registry.mount(family(null))();
    expect(run).not.toHaveBeenCalled();
  });
});
