import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { shouldRefocusComposerOnWindowFocus } from "./ChatView.logic";

it("keeps keyboard focus on a sidebar row on window return, but not a clicked row", async () => {
  const tree = document.createElement("div");
  tree.setAttribute("role", "tree");
  const row = (name: string, tabIndex: number) => {
    const element = document.createElement("div");
    element.setAttribute("role", "treeitem");
    element.tabIndex = tabIndex;
    element.textContent = name;
    tree.append(element);
    return element;
  };
  const clicked = row("Clicked thread", -1);
  const tabbed = row("Tabbed thread", 0);
  document.body.append(tree);
  using _tree = { [Symbol.dispose]: () => tree.remove() };

  await userEvent.click(clicked);
  expect(document.activeElement).toBe(clicked);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(true);

  await userEvent.tab();
  expect(document.activeElement).toBe(tabbed);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(false);
});

it("keeps keyboard focus on the conversation timeline on window return, but not a click", async () => {
  const timeline = document.createElement("div");
  timeline.className = "messages-timeline-scroll";
  timeline.tabIndex = -1;
  timeline.textContent = "Assistant reply";
  document.body.append(timeline);
  using _timeline = { [Symbol.dispose]: () => timeline.remove() };

  await userEvent.click(timeline);
  expect(document.activeElement).toBe(timeline);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(true);

  timeline.blur();
  // F6 focuses the timeline from a key press, as workspace focus does.
  await userEvent.keyboard("{F6}");
  timeline.focus();
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(false);
});
