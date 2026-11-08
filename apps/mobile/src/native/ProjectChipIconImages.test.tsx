import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  answers: [] as Array<string | undefined>,
  captures: 0,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("uniwind", () => ({ useResolveClassNames: () => ({}) }));
vi.mock("react-native-svg", async () => {
  const { Component } = await import("react");
  class Svg extends Component<{ children?: ReactNode }> {
    toDataURL(callback: (base64?: string) => void) {
      native.captures += 1;
      callback(native.answers.shift());
    }
    override render() {
      return null;
    }
  }
  return { default: Svg, Rect: () => null, Text: () => null };
});

import {
  ProjectChipIconRasterizer,
  projectGlyphImageAtom,
  projectGlyphKey,
} from "./ProjectChipIconImages";

const valueOrTag = (result: AsyncResult.AsyncResult<string, unknown>) =>
  AsyncResult.isSuccess(result) ? result.value : result._tag;

async function request(registry: AtomRegistry.AtomRegistry, key: string) {
  let result!: AsyncResult.AsyncResult<string, unknown>;
  await act(async () => {
    result = await executeAtomQuery(registry, projectGlyphImageAtom(key), {
      reportFailure: false,
    });
  });
  return valueOrTag(result);
}

it("captures a glyph again after a failed capture and reuses one that rendered", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  using _frame = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 0;
  });
  const root = createRoot(document.createElement("div"));
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      queueMicrotask(task);
      return () => {};
    },
  });
  const key = projectGlyphKey({ kind: "emoji", emoji: "🚀" });
  const uri = "data:image/png;base64,iVBORw0KGgo=";
  native.answers.push(undefined, "iVBORw0KGgo=");
  try {
    await act(async () => root.render(<ProjectChipIconRasterizer />));

    expect(await request(registry, key)).toBe("Failure");
    expect(await request(registry, key)).toBe(uri);
    expect(valueOrTag(AtomRegistry.make().get(projectGlyphImageAtom(key)))).toBe(uri);
    expect(native.captures).toBe(2);
  } finally {
    registry.dispose();
    await act(async () => root.unmount());
  }
});
