import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { useSyncListLayoutOnChange } from "./useSyncListLayoutOnChange";

const syncLayout = vi.hoisted(() => vi.fn());
vi.mock("@legendapp/list/react-native", () => ({ useSyncLayout: () => syncLayout }));

function Row(props: { contentKey: unknown; label: string }) {
  useSyncListLayoutOnChange(props.contentKey);
  return createElement("span", null, props.label);
}

it("re-measures the row on mount and when its key changes, not on other renders", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const render = (contentKey: unknown, label: string) =>
    act(async () => root.render(createElement(Row, { contentKey, label })));

  await render(false, "a");
  expect(syncLayout).toHaveBeenCalledTimes(1);
  await render(false, "b");
  expect(syncLayout).toHaveBeenCalledTimes(1);
  await render(true, "b");
  expect(syncLayout).toHaveBeenCalledTimes(2);
  await render(true, "c");
  expect(syncLayout).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
});
