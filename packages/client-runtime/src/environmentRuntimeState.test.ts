import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it } from "vitest";

import { createEnvironmentRuntimeManager } from "./environmentRuntimeState";

let atomRegistry = AtomRegistry.make();

function resetAtomRegistry() {
  atomRegistry.dispose();
  atomRegistry = AtomRegistry.make();
}

const TARGET = { environmentId: "env-local" } as const;

describe("createEnvironmentRuntimeManager", () => {
  afterEach(() => {
    resetAtomRegistry();
  });

  it("stores state per environment", () => {
    const manager = createEnvironmentRuntimeManager({
      getRegistry: () => atomRegistry,
    });

    manager.setState(TARGET, {
      connectionState: "ready",
      connectionError: null,
      serverConfig: null,
    });

    expect(manager.getSnapshot(TARGET)).toEqual({
      connectionState: "ready",
      connectionError: null,
      serverConfig: null,
    });
  });

  it("patches the current state", () => {
    const manager = createEnvironmentRuntimeManager({
      getRegistry: () => atomRegistry,
    });

    manager.patch(TARGET, (current) => ({
      ...current,
      connectionState: "disconnected",
      connectionError: "Socket closed.",
    }));

    expect(manager.getSnapshot(TARGET)).toEqual({
      connectionState: "disconnected",
      connectionError: "Socket closed.",
      serverConfig: null,
    });
  });

  it("invalidates a single environment", () => {
    const manager = createEnvironmentRuntimeManager({
      getRegistry: () => atomRegistry,
    });

    manager.setState(TARGET, {
      connectionState: "ready",
      connectionError: null,
      serverConfig: null,
    });
    manager.invalidate(TARGET);

    expect(manager.getSnapshot(TARGET)).toEqual({
      connectionState: "idle",
      connectionError: null,
      serverConfig: null,
    });
  });
});
