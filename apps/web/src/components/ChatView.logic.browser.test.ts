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
