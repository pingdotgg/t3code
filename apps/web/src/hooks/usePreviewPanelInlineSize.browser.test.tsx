import { useLayoutEffect } from "react";
import { page } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";
import { usePreviewPanelInlineSize } from "./usePreviewPanelInlineSize";
const state = vi.hoisted(() => ({ resize: () => {} }));
vi.mock("../lib/observeResize", () => ({
  observeResize: (_: unknown, callback: () => void) => {
    state.resize = callback;
    return () => {};
  },
}));
function setup() {
  state.resize = () => {};
  localStorage.clear();
  const row = { clientWidth: 1500 };
  let result: ReturnType<typeof usePreviewPanelInlineSize>;
  function Panel({
    balanced = true,
    storageKey = "sidechat",
  }: {
    balanced?: boolean;
    storageKey?: string;
  }) {
    const size = usePreviewPanelInlineSize(undefined, {
      container: row as HTMLElement,
      balancedDefault: balanced,
      widthStorageKey: storageKey,
    });
    useLayoutEffect(() => {
      result = size;
    });
    return null;
  }
  return {
    row,
    Panel,
    get result() {
      return result;
    },
  };
}
it("starts at half the available row and follows sidebar resizes before an explicit drag", async () => {
  const fixture = setup();
  await page.viewport(1920, 1080);
  await using screen = await render(<fixture.Panel />);
  expect(fixture.result.width).toBe(750);
  for (const [width, expected] of [
    [1200, 600],
    [800, 400],
    [650, 360],
  ]) {
    fixture.row.clientWidth = width!;
    await act(() => state.resize());
    expect(fixture.result.width).toBe(expected);
  }
});
it("keeps the normal file/browser default when the active surface changes", async () => {
  const fixture = setup();
  await page.viewport(1920, 1080);
  await using screen = await render(<fixture.Panel />);
  expect(fixture.result.width).toBe(750);
  await screen.rerender(<fixture.Panel balanced={false} storageKey="browser" />);
  expect(fixture.result.width).toBe(540);
});
