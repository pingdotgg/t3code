import { createRef, type RefObject, useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { PullRequestSearchInput } from "./PullRequestListFilters";
import { PullRequestsColumn } from "./PullRequestsColumn";

import "~/index.css";

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

function CondensedSearchColumn({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const [query, setQuery] = useState("label:bug");
  return (
    <div style={{ display: "flex", height: 400 }}>
      <PullRequestsColumn
        refreshing={false}
        onRefresh={() => {}}
        searchValue={query}
        involvement="all"
        state="open"
        host={undefined}
        hostMenuOptions={[]}
        onInvolvement={() => {}}
        onState={() => {}}
        onHost={() => {}}
        searchInput={
          <PullRequestSearchInput
            value={query}
            label="Search pull requests"
            placeholder="Search pull requests"
            onChange={setQuery}
            onSubmit={() => {}}
          />
        }
        sortMenu={null}
        filtersMenu={null}
        savedViewsMenu={null}
        rightPanelControl={null}
        titlebarControls={null}
        rightPanelOpen={false}
        maximizedAway={false}
        listBody={<div style={{ height: 2000 }} />}
        scrollRef={scrollRef}
      />
      <button type="button" onClick={() => setQuery("")}>
        Clear query
      </button>
    </div>
  );
}

async function renderCondensed() {
  await using stack = new AsyncDisposableStack();
  const scrollRef = createRef<HTMLDivElement>();
  const screen = stack.use(await render(<CondensedSearchColumn scrollRef={scrollRef} />));
  scrollRef.current?.scrollTo({ top: 1000 });
  const searches = page.getByRole("searchbox", { name: "Search pull requests" });
  // The topbar copy comes first and mounts once the header condenses.
  await expect.element(searches.nth(1)).toBeInTheDocument();
  const environment = stack.move();
  return Object.assign(screen, {
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
    topbarSearch: searches.nth(0),
  });
}

describe("PullRequestsColumn condensed search", () => {
  it("keeps the topbar search focused when Escape clears the query that kept it open", async () => {
    await using screen = await renderCondensed();

    await userEvent.click(screen.topbarSearch);
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.topbarSearch).toHaveValue("");
    await expect.element(screen.topbarSearch).toHaveFocus();
  });

  it("collapses the topbar search when its query clears after focus left it", async () => {
    await using screen = await renderCondensed();

    await userEvent.click(screen.topbarSearch);
    await userEvent.click(page.getByRole("button", { name: "Clear query" }));
    await expect
      .element(page.getByRole("button", { name: "Search pull requests" }))
      .toBeInTheDocument();
  });
});
