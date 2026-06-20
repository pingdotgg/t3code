import * as Cause from "effect/Cause";
import { AtomRegistry } from "effect/unstable/reactivity";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createSourceHighlightAtomFamily,
  SourceHighlightError,
  type SourceHighlightTokens,
} from "./sourceHighlightingState";

const highlightedTokens: SourceHighlightTokens = [
  [{ content: "const", color: "#0000ff", fontStyle: null }],
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sourceHighlightingState", () => {
  it("reuses completed highlighting across equivalent route remounts", async () => {
    const highlight = vi.fn(async () => highlightedTokens);
    const sourceHighlightAtom = createSourceHighlightAtomFamily({ highlight, idleTtlMs: 1_000 });
    const registry = AtomRegistry.make({ timeoutResolution: 1 });
    const input = {
      path: "src/example.ts",
      contents: "const value = 1;",
      theme: "light" as const,
    };
    const firstAtom = sourceHighlightAtom(input);
    const firstUnmount = registry.mount(firstAtom);

    await vi.waitFor(() => {
      expect(AsyncResult.isSuccess(registry.get(firstAtom))).toBe(true);
    });
    firstUnmount();

    const remountedAtom = sourceHighlightAtom({ ...input });
    const secondUnmount = registry.mount(remountedAtom);

    expect(remountedAtom).toBe(firstAtom);
    expect(AsyncResult.isSuccess(registry.get(remountedAtom))).toBe(true);
    expect(highlight).toHaveBeenCalledTimes(1);

    secondUnmount();
    registry.dispose();
  });

  it("does not reuse highlighting when the source contents change", async () => {
    const highlight = vi.fn(async () => highlightedTokens);
    const sourceHighlightAtom = createSourceHighlightAtomFamily({ highlight });
    const registry = AtomRegistry.make();
    const firstAtom = sourceHighlightAtom({
      path: "src/example.ts",
      contents: "const value = 1;",
      theme: "light",
    });
    const secondAtom = sourceHighlightAtom({
      path: "src/example.ts",
      contents: "const value = 2;",
      theme: "light",
    });
    const firstUnmount = registry.mount(firstAtom);
    const secondUnmount = registry.mount(secondAtom);

    await vi.waitFor(() => {
      expect(AsyncResult.isSuccess(registry.get(firstAtom))).toBe(true);
      expect(AsyncResult.isSuccess(registry.get(secondAtom))).toBe(true);
    });
    expect(secondAtom).not.toBe(firstAtom);
    expect(highlight).toHaveBeenCalledTimes(2);

    firstUnmount();
    secondUnmount();
    registry.dispose();
  });

  it("recomputes highlighting after the idle cache entry expires", async () => {
    const highlight = vi.fn(async () => highlightedTokens);
    const sourceHighlightAtom = createSourceHighlightAtomFamily({ highlight, idleTtlMs: 5 });
    const registry = AtomRegistry.make({ timeoutResolution: 1 });
    const atom = sourceHighlightAtom({
      path: "src/example.ts",
      contents: "const value = 1;",
      theme: "light",
    });
    const firstUnmount = registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.isSuccess(registry.get(atom))).toBe(true);
    });
    firstUnmount();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const secondUnmount = registry.mount(atom);
    await vi.waitFor(() => {
      expect(highlight).toHaveBeenCalledTimes(2);
      expect(AsyncResult.isSuccess(registry.get(atom))).toBe(true);
    });

    secondUnmount();
    registry.dispose();
  });

  it("preserves highlighter failures with the source path and theme", async () => {
    const cause = new Error("highlight failed");
    const highlight = vi.fn(() => Promise.reject(cause));
    const sourceHighlightAtom = createSourceHighlightAtomFamily({ highlight });
    const registry = AtomRegistry.make();
    const path = "src/example.ts";
    const theme = "light" as const;
    const atom = sourceHighlightAtom({
      path,
      contents: "const value = 1;",
      theme,
    });
    const unmount = registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.isFailure(registry.get(atom))).toBe(true);
    });
    const result = registry.get(atom);
    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      expect(error).toEqual(new SourceHighlightError({ path, theme, cause }));
      expect((error as SourceHighlightError).cause).toBe(cause);
    }

    unmount();
    registry.dispose();
  });
});
