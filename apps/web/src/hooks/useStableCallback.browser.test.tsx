import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useStableCallback } from "./useStableCallback";

let root: Root;
let handlers: Array<() => string> = [];

function Probe({ label }: { label: string }) {
  handlers.push(useStableCallback(() => label));
  return null;
}

beforeEach(() => {
  handlers = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("useStableCallback", () => {
  it("keeps one identity and calls the latest committed function", async () => {
    await act(() => root.render(<Probe label="first" />));
    await act(() => root.render(<Probe label="second" />));

    expect(new Set(handlers).size).toBe(1);
    expect(handlers[0]!()).toBe("second");
  });
});
