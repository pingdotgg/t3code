import type { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { acquireBackgroundConnectionRoot } from "./background-root";

const mocks = vi.hoisted(() => ({ threadShellsAtom: {} }));

vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellsAtom: mocks.threadShellsAtom },
}));

function makeRegistry() {
  const release = vi.fn();
  const mount = vi.fn(() => release);
  return {
    registry: { mount } as unknown as AtomRegistry.AtomRegistry,
    mount,
    release,
  };
}

describe("background connection root", () => {
  it("shares one shell lease across owners", () => {
    const { registry, mount, release } = makeRegistry();
    const releaseFirst = acquireBackgroundConnectionRoot(registry);
    const releaseSecond = acquireBackgroundConnectionRoot(registry);

    expect(mount).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledWith(mocks.threadShellsAtom);

    releaseFirst();
    expect(release).not.toHaveBeenCalled();
    releaseSecond();
    expect(release).toHaveBeenCalledOnce();
  });

  it("ignores duplicate releases", () => {
    const { registry, release } = makeRegistry();
    const releaseRoot = acquireBackgroundConnectionRoot(registry);

    releaseRoot();
    releaseRoot();

    expect(release).toHaveBeenCalledOnce();
  });
});
