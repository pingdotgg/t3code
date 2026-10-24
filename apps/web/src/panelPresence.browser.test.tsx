import { act, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { usePanelPresence } from "./panelAnimations";

let root: Root;
let observed: ReturnType<typeof usePanelPresence<{ label: string }>>;
function Probe({
  open,
  scope = "one",
  label = "panel",
  animated = true,
}: {
  open: boolean;
  scope?: string;
  label?: string;
  animated?: boolean;
}) {
  // oxlint-disable-next-line t3code/no-manual-memo -- Exercise fresh caller inputs rather than compiler-stabilized references.
  "use no memo";
  const [ready, setReady] = useState(false);
  const result = usePanelPresence(open, { label }, animated, scope, 150);
  if (!ready) setReady(true);
  useLayoutEffect(() => {
    observed = result;
  });
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("converges with fresh values and retains the last open value until exit finishes", async () => {
  await act(() => root.render(<Probe open />));
  expect(observed).toEqual({ present: true, value: { label: "panel" } });
  await act(() => root.render(<Probe open label="updated" />));
  await act(() => root.render(<Probe open={false} label="closed" />));
  expect(observed).toEqual({ present: true, value: { label: "updated" } });
  await act(() => vi.advanceTimersByTime(150));
  expect(observed).toEqual({ present: false, value: null });
});
it("does not retain a different thread's panel and closes immediately without animation", async () => {
  await act(() => root.render(<Probe open />));
  await act(() => root.render(<Probe open={false} scope="two" />));
  expect(observed).toEqual({ present: false, value: null });
  await act(() => root.render(<Probe open scope="two" label="second" />));
  expect(observed.value).toEqual({ label: "second" });
  await act(() => root.render(<Probe open={false} scope="two" animated={false} />));
  expect(observed).toEqual({ present: false, value: null });
});
