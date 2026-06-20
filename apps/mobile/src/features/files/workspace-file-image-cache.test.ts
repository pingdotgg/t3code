import * as Cause from "effect/Cause";
import * as Hash from "effect/Hash";
import { AtomRegistry } from "effect/unstable/reactivity";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createWorkspaceFileImageAtomFamily,
  WorkspaceImagePrefetchFailedError,
  WorkspaceImagePrefetchUnavailableError,
} from "./workspace-file-image-cache";

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

  it("reports an unavailable image when prefetch completes without caching it", async () => {
    const uri = "https://example.test/api/assets/signed-secret-token/missing.png?signature=private";
    const imageAtom = createWorkspaceFileImageAtomFamily({ prefetch: async () => false });
    const registry = AtomRegistry.make();
    const atom = imageAtom(uri);
    expect(atom.label?.[0]).not.toContain("signed-secret-token");
    expect(atom.label?.[0]).not.toContain("signature=private");
    const unmount = registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.isFailure(registry.get(atom))).toBe(true);
    });
    const result = registry.get(atom);
    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      expect(error).toEqual(
        new WorkspaceImagePrefetchUnavailableError({
          uriHash: Hash.hash(uri),
          uriLength: uri.length,
          uriProtocol: "https:",
        }),
      );
      expect(error).not.toHaveProperty("uri");
      expect(String(error)).not.toContain("signed-secret-token");
      expect(String(error)).not.toContain("signature=private");
    }

    unmount();
    registry.dispose();
  });

  it("preserves rejected prefetch causes without retaining the signed image URI", async () => {
    const uri =
      "https://example.test/api/assets/signed-secret-token/rejected.png?signature=private";
    const cause = new Error("native image loader failed");
    const imageAtom = createWorkspaceFileImageAtomFamily({ prefetch: () => Promise.reject(cause) });
    const registry = AtomRegistry.make();
    const atom = imageAtom(uri);
    const unmount = registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.isFailure(registry.get(atom))).toBe(true);
    });
    const result = registry.get(atom);
    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      expect(error).toEqual(
        new WorkspaceImagePrefetchFailedError({
          uriHash: Hash.hash(uri),
          uriLength: uri.length,
          uriProtocol: "https:",
          cause,
        }),
      );
      expect((error as WorkspaceImagePrefetchFailedError).cause).toBe(cause);
      expect(error).not.toHaveProperty("uri");
      expect(String(error)).not.toContain("signed-secret-token");
      expect(String(error)).not.toContain("signature=private");
    }

    unmount();
    registry.dispose();
  });
});
