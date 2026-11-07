import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { SidebarSearchResultRow } from "./SidebarThreadRow";

describe("SidebarSearchResultRow", () => {
  it("leaves focus in the search box when a click picks the result", async () => {
    const onSelect = vi.fn();
    await using screen = await render(
      <>
        <input aria-label="Search threads" />
        <ul role="listbox">
          <SidebarSearchResultRow
            isSettled={false}
            thread={makeThreadFixture({ title: "Invoice export" })}
            project={null}
            projectDisplayName={null}
            environmentLabel={null}
            environmentMachine="server"
            providerEntryByInstanceId={new Map()}
            isHighlighted={false}
            isRouteActive={false}
            resultId="result-0"
            searchMatch={null}
            searchQuery="invoice"
            onHighlight={() => {}}
            onSelect={onSelect}
            onFileDropThreads={() => {}}
          />
        </ul>
      </>,
    );
    const search = screen.getByRole("textbox", { name: "Search threads" });
    await userEvent.click(search);

    await userEvent.click(screen.getByRole("option"));

    expect(onSelect).toHaveBeenCalledOnce();
    // Picking clears the results; a focused result would drop focus for recovery to place.
    await expect.element(search).toHaveFocus();
  });
});
