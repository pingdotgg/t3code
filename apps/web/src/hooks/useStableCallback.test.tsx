import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useStableCallback } from "./useStableCallback";

let renderer: ReactTestRenderer | null = null;
let handlers: Array<() => string> = [];

function Probe({ label }: { label: string }) {
  handlers.push(useStableCallback(() => label));
  return null;
}

async function render(label: string) {
  await act(() => {
    if (renderer) renderer.update(<Probe label={label} />);
    else renderer = create(<Probe label={label} />);
  });
}

beforeEach(() => {
  handlers = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("useStableCallback", () => {
  it("keeps one identity and calls the latest committed function", async () => {
    await render("first");
    await render("second");

    expect(new Set(handlers).size).toBe(1);
    expect(handlers[0]!()).toBe("second");
  });
});
