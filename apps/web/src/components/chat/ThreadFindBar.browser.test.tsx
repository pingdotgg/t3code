import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { cdp, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ThreadFindBar } from "./ThreadFindBar";

function ThreadFindBarHarness(props: {
  readonly initialQuery: string;
  readonly onQueryChange: (query: string) => void;
}) {
  const [query, setQuery] = useState(props.initialQuery);
  return (
    <ThreadFindBar
      open
      query={query}
      matchCount={0}
      status={null}
      onRetry={() => {}}
      activeIndex={0}
      navigationId={0}
      settled
      focusRequestId={0}
      onQueryChange={(next) => {
        setQuery(next);
        props.onQueryChange(next);
      }}
      onNext={() => {}}
      onPrevious={() => {}}
      onClose={() => {}}
    />
  );
}

it("keeps the find query on Escape during IME composition", async () => {
  const onQueryChange = vi.fn<(query: string) => void>();
  await using screen = await render(
    <ThreadFindBarHarness initialQuery="needle" onQueryChange={onQueryChange} />,
  );

  const search = screen.getByRole("searchbox", { name: "Find in thread" });
  await expect.element(search).toHaveFocus();
  await expect.element(search).toHaveValue("needle");

  // The bar selects its query on open; move the caret so composition appends.
  await userEvent.keyboard("{ArrowRight}");

  const session = cdp();
  await session.send("Input.imeSetComposition", {
    text: "に",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await expect.element(search).toHaveValue("needleに");

  await session.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });

  await expect.element(search).toHaveValue("needleに");
  expect(onQueryChange).not.toHaveBeenCalledWith("");
  await expect.element(search).toHaveAttribute("enterkeyhint", "search");
});
