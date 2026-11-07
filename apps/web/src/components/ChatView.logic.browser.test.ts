import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { shouldRefocusComposerOnWindowFocus } from "./ChatView.logic";

it("keeps keyboard focus on a sidebar row on window return, but not a clicked row", async () => {
  const list = document.createElement("ul");
  const row = (name: string) => {
    const element = document.createElement("div");
    element.setAttribute("role", "button");
    element.tabIndex = 0;
    element.dataset.sidebarRow = name;
    element.textContent = name;
    list.append(element);
    return element;
  };
  const clicked = row("Clicked thread");
  const tabbed = row("Tabbed thread");
  document.body.append(list);
  using _list = { [Symbol.dispose]: () => list.remove() };

  await userEvent.click(clicked);
  expect(document.activeElement).toBe(clicked);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement, document.getSelection())).toBe(
    true,
  );

  await userEvent.tab();
  expect(document.activeElement).toBe(tabbed);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement, document.getSelection())).toBe(
    false,
  );
});

it("leaves a text selection in the timeline alone on window return", async () => {
  const timeline = document.createElement("div");
  timeline.tabIndex = -1;
  const reply = document.createElement("p");
  reply.textContent = "Steel bridges are also easy to recycle at the end of their life.";
  timeline.append(reply);
  document.body.append(timeline);
  using _timeline = { [Symbol.dispose]: () => timeline.remove() };

  await userEvent.tripleClick(reply);
  expect(document.activeElement).toBe(timeline);
  expect(document.getSelection()?.toString()).toContain("Steel bridges");
  expect(
    shouldRefocusComposerOnWindowFocus(document.activeElement, document.getSelection()),
    "refocusing the composer would clear the selected reply text",
  ).toBe(false);
});
