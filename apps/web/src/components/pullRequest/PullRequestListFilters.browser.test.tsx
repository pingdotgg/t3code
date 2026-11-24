import { useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { registerCommands } from "../../shortcuts/dispatcher";
import { PullRequestSearchInput } from "./PullRequestListFilters";

import "~/index.css";

function SearchHarness({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <PullRequestSearchInput
      value={value}
      label="Search pull requests"
      placeholder="Search pull requests"
      onChange={setValue}
      onSubmit={onSubmit}
    />
  );
}

it("Escape in the search clears it before the page's Escape leaves", async () => {
  const onSubmit = vi.fn();
  await using _screen = await render(<SearchHarness onSubmit={onSubmit} />);
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
  const search = page.getByRole("searchbox", { name: "Search pull requests" });
  // Safari ends the composition just before the confirming keydown.
  const pressDuringComposition = (key: string) =>
    act(() => {
      for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
        search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        search
          .element()
          .dispatchEvent(new KeyboardEvent("keydown", { key, ...composition, bubbles: true }));
      }
    });
  await expect.element(search).toHaveAttribute("type", "text");
  await userEvent.fill(search, "label:bug");

  await pressDuringComposition("Enter");
  await pressDuringComposition("Escape");
  expect(onSubmit).not.toHaveBeenCalled();
  await expect.element(search).toHaveValue("label:bug");
  await userEvent.keyboard("{Enter}");
  expect(onSubmit.mock.calls).toEqual([["label:bug"]]);

  // An Escape another scope already claimed, like the close sweep, keeps the query.
  window.addEventListener("keydown", (event) => event.preventDefault(), {
    capture: true,
    once: true,
  });
  await userEvent.keyboard("{Escape}");
  await expect.element(search).toHaveValue("label:bug");
  // A modified Escape is left to the user's keybindings.
  await userEvent.keyboard("{Shift>}{Escape}{/Shift}");
  await expect.element(search).toHaveValue("label:bug");
  expect(leave).toHaveBeenCalledOnce();
  leave.mockClear();

  await userEvent.keyboard("{Escape}");
  await expect.element(search).toHaveValue("");
  await expect.element(search).toHaveFocus();
  await userEvent.tab();
  await expect.element(search).toHaveValue("");

  await userEvent.click(search);
  await pressDuringComposition("Escape");
  expect(leave).not.toHaveBeenCalled();

  await userEvent.keyboard("{Escape}");
  expect(leave).toHaveBeenCalledOnce();
});
