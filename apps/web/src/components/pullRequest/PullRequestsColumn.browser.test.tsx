import { createRef, type RefObject } from "react";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { PullRequestsColumn } from "./PullRequestsColumn";

function createColumn(maximizedAway: boolean, scrollRef: RefObject<HTMLDivElement | null>) {
  return (
    <PullRequestsColumn
      refreshing={false}
      onRefresh={() => {}}
      searchValue=""
      involvement="all"
      state="open"
      host={undefined}
      hostMenuOptions={[]}
      onInvolvement={() => {}}
      onState={() => {}}
      onHost={() => {}}
      searchInput={<input aria-label="Search pull requests" />}
      sortMenu={null}
      filtersMenu={null}
      savedViewsMenu={null}
      rightPanelControl={null}
      titlebarControls={null}
      rightPanelOpen={maximizedAway}
      maximizedAway={maximizedAway}
      listBody={null}
      scrollRef={scrollRef}
    />
  );
}

function dispatchFindShortcut() {
  const event = new KeyboardEvent("keydown", {
    key: "f",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

describe("PullRequestsColumn find shortcut", () => {
  it("leaves Cmd/Ctrl+F to the browser while the detail panel is maximized", async () => {
    const scrollRef = createRef<HTMLDivElement>();
    await using screen = await render(createColumn(false, scrollRef));

    await screen.rerender(createColumn(true, scrollRef));
    expect(dispatchFindShortcut().defaultPrevented).toBe(false);

    await screen.rerender(createColumn(false, scrollRef));
    expect(dispatchFindShortcut().defaultPrevented).toBe(true);
    await expect
      .element(screen.getByRole("textbox", { name: "Search pull requests" }))
      .toHaveFocus();
  });
});
