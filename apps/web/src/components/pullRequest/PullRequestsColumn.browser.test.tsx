import { createRef, type RefObject, useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { registerCommands } from "../../shortcuts/dispatcher";
import { Plug2Icon } from "lucide-react";
import { PullRequestSearchInput } from "./PullRequestListFilters";
import type { PullRequestFilterOption } from "./PullRequestListFilters";
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

function CondensedSearchColumn({
  scrollRef,
  onSubmit,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  onSubmit: (value: string) => void;
}) {
  const [query, setQuery] = useState("label:bug");
  return (
    <div className="flex h-[400px]">
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
            onSubmit={onSubmit}
          />
        }
        sortMenu={null}
        filtersMenu={null}
        savedViewsMenu={null}
        rightPanelControl={null}
        titlebarControls={null}
        rightPanelOpen={false}
        maximizedAway={false}
        listBody={<div className="h-[2000px]" />}
        scrollRef={scrollRef}
      />
      <button type="button">Elsewhere</button>
    </div>
  );
}

describe("PullRequestsColumn condensed search", () => {
  it("Escape clears the topbar search before the page's Escape leaves", async () => {
    const onSubmit = vi.fn();
    const scrollRef = createRef<HTMLDivElement>();
    await using _screen = await render(
      <CondensedSearchColumn scrollRef={scrollRef} onSubmit={onSubmit} />,
    );
    // Mirrors the /pull-requests observer, which leaves on an unclaimed Escape.
    const leave = vi.fn();
    using stack = new DisposableStack();
    stack.defer(
      registerCommands(
        {},
        {
          observe: (event, consumed) => {
            if (!consumed && !event.repeat && !event.isComposing && event.key === "Escape") leave();
          },
        },
      ),
    );
    scrollRef.current?.scrollTo({ top: 1000 });
    const searches = page.getByRole("searchbox", { name: "Search pull requests" });
    // The topbar copy comes first and mounts once the header condenses.
    await expect.element(searches.nth(1)).toBeInTheDocument();
    const search = searches.nth(0);
    // Safari ends the composition just before the confirming keydown, reporting only keyCode 229.
    const pressDuringComposition = (key: string) =>
      act(() => {
        for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
          search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
          search
            .element()
            .dispatchEvent(new KeyboardEvent("keydown", { key, ...composition, bubbles: true }));
        }
      });

    await userEvent.click(search);
    await pressDuringComposition("Enter");
    await pressDuringComposition("Escape");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
    await expect.element(search).toHaveValue("label:bug");

    await userEvent.keyboard("{Escape}");
    await expect.element(search).toHaveValue("");
    await expect.element(search).toHaveFocus();
    expect(leave).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(leave).toHaveBeenCalledOnce();

    await userEvent.click(page.getByRole("button", { name: "Elsewhere" }));
    await expect
      .element(page.getByRole("button", { name: "Search pull requests" }))
      .toBeInTheDocument();
  });
});

function HostFilteredColumn({
  host,
  onHost,
}: {
  host: string | undefined;
  onHost: (host: string | undefined) => void;
}) {
  const scrollRef = createRef<HTMLDivElement>();
  return (
    <PullRequestsColumn
      refreshing={false}
      onRefresh={() => {}}
      searchValue=""
      involvement="all"
      state="open"
      host={host}
      hostMenuOptions={HOST_OPTIONS}
      onInvolvement={() => {}}
      onState={() => {}}
      onHost={onHost}
      searchInput={<input aria-label="Search pull requests" />}
      sortMenu={null}
      filtersMenu={null}
      savedViewsMenu={null}
      rightPanelControl={null}
      titlebarControls={null}
      rightPanelOpen={false}
      maximizedAway={false}
      listBody={<div className="h-[2000px]" />}
      scrollRef={scrollRef}
    />
  );
}

const HOST_OPTIONS: ReadonlyArray<PullRequestFilterOption<string>> = [
  { value: "", label: "All", Icon: Plug2Icon },
  { value: "github.com", label: "GitHub", Icon: Plug2Icon },
  { value: "gitlab.com", label: "GitLab", Icon: Plug2Icon },
];

describe("PullRequestsColumn host selector", () => {
  // Base UI unmounts the popup on pick, so each case opens the menu exactly once.
  async function pickHost(from: string | undefined, pick: string) {
    const onHost = vi.fn();
    await using screen = await render(<HostFilteredColumn host={from} onHost={onHost} />);
    const name = from === undefined ? "All" : from === "github.com" ? "GitHub" : "GitLab";
    await userEvent.click(screen.getByRole("button", { name: `Filter by provider: ${name}` }));
    const items = page.getByRole("menuitemradio");
    await userEvent.click(items.filter({ hasText: pick }));
    return onHost;
  }

  it("moves from All to GitHub", async () => {
    const onHost = await pickHost(undefined, "GitHub");
    expect(onHost).toHaveBeenLastCalledWith("github.com");
  });

  it("moves from GitHub to GitLab", async () => {
    const onHost = await pickHost("github.com", "GitLab");
    expect(onHost).toHaveBeenLastCalledWith("gitlab.com");
  });

  it("clears back to All", async () => {
    const onHost = await pickHost("gitlab.com", "All");
    expect(onHost).toHaveBeenLastCalledWith(undefined);
  });

  it("shows the active host on the surviving selector", async () => {
    await using screen = await render(<HostFilteredColumn host="gitlab.com" onHost={() => {}} />);
    // Once a host is chosen the trigger is icon-only, so its accessible name carries the choice.
    const trigger = screen.getByRole("button", { name: "Filter by provider: GitLab" });
    await expect.element(trigger).toBeInTheDocument();
    expect(trigger.element().getAttribute("title")).toBe("Filter by provider: GitLab");

    await userEvent.click(trigger);
    expect(
      await page
        .getByRole("menuitemradio", { name: "GitLab" })
        .element()
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});
