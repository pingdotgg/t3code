import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { PreviewChromeRow } from "./PreviewChromeRow";

it("ignores composing keys in the address bar", async () => {
  const onSubmit = vi.fn();
  await using _screen = await render(
    <PreviewChromeRow
      url="https://example.com/"
      loading={false}
      canGoBack={false}
      canGoForward={false}
      refreshDisabled={false}
      urlInputRef={createRef()}
      onBack={() => {}}
      onForward={() => {}}
      onRefresh={() => {}}
      onSubmit={onSubmit}
    />,
  );
  const input = page.getByRole("textbox", { name: "Search or enter URL" });
  await input.fill("東京");

  for (const composition of [
    { key: "Enter", isComposing: true, keyCode: 13 },
    { key: "Enter", isComposing: false, keyCode: 229 },
    { key: "Escape", isComposing: true, keyCode: 27 },
    { key: "Escape", isComposing: false, keyCode: 229 },
  ]) {
    const event = new KeyboardEvent("keydown", { ...composition, bubbles: true, cancelable: true });
    await act(() => input.element().dispatchEvent(event));
    if (composition.key === "Enter") expect(event.defaultPrevented).toBe(true);
    await expect.element(input).toHaveValue("東京");
    await expect.element(input).toHaveFocus();
  }
  expect(onSubmit).not.toHaveBeenCalled();

  await userEvent.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith("東京");
});
