import { AtomRegistry } from "effect/unstable/reactivity";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { describe, expect, it, vi } from "vite-plus/test";

import { createWorkspaceFileImageAtomFamily } from "./workspace-file-image-cache";

describe("workspaceFileImageAtom", () => {
  it("reuses a prefetched image across route remounts", async () => {
    const prefetch = vi.fn(async () => true);
    const imageAtom = createWorkspaceFileImageAtomFamily({ idleTtlMs: 1_000, prefetch });
    const registry = AtomRegistry.make({ timeoutResolution: 1 });
    const first = imageAtom("https://example.test/image.png");
    const firstUnmount = registry.mount(first);

    await vi.waitFor(() => {
      expect(AsyncResult.isSuccess(registry.get(first))).toBe(true);
    });
    firstUnmount();

    const remounted = imageAtom("https://example.test/image.png");
    const secondUnmount = registry.mount(remounted);

    expect(remounted).toBe(first);
    expect(AsyncResult.isSuccess(registry.get(remounted))).toBe(true);
    expect(prefetch).toHaveBeenCalledTimes(1);

    secondUnmount();
    registry.dispose();
  });

  it("prefetches different asset URLs independently", async () => {
    const prefetch = vi.fn(async () => true);
    const imageAtom = createWorkspaceFileImageAtomFamily({ prefetch });
    const registry = AtomRegistry.make();
    const first = imageAtom("https://example.test/first.png");
    const second = imageAtom("https://example.test/second.png");
    const firstUnmount = registry.mount(first);
    const secondUnmount = registry.mount(second);

    await vi.waitFor(() => {
      expect(AsyncResult.isSuccess(registry.get(first))).toBe(true);
      expect(AsyncResult.isSuccess(registry.get(second))).toBe(true);
    });
    expect(prefetch).toHaveBeenCalledTimes(2);

    firstUnmount();
    secondUnmount();
    registry.dispose();
  });

  it("exposes prefetch failures", async () => {
    const imageAtom = createWorkspaceFileImageAtomFamily({ prefetch: async () => false });
    const registry = AtomRegistry.make();
    const atom = imageAtom("https://example.test/missing.png");
    const unmount = registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.isFailure(registry.get(atom))).toBe(true);
    });

    unmount();
    registry.dispose();
  });
});
