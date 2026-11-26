import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { FileBreadcrumbs } from "./FileBreadcrumbs";

/** What the browser puts on the clipboard: a copy handler's data, else its own serialization. */
function copySelection(): string {
  const clipboardData = new DataTransfer();
  const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData });
  const selection = document.getSelection()!;
  const anchor = selection.anchorNode;
  (anchor instanceof Element ? anchor : anchor!.parentElement!).dispatchEvent(event);
  return event.defaultPrevented ? clipboardData.getData("text/plain") : selection.toString();
}

function selectCrumbs(nav: Element, from: string, to: string) {
  const labels = [...nav.querySelectorAll("[data-file-crumb]")];
  const textOf = (label: string) => {
    const crumb = labels.find((element) => element.textContent === label)!;
    return document.createTreeWalker(crumb, NodeFilter.SHOW_TEXT).nextNode()!;
  };
  const range = document.createRange();
  range.setStart(textOf(from), 0);
  const end = textOf(to);
  range.setEnd(end, end.textContent!.length);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
}

const renderCrumbs = (relativePath: string) =>
  render(
    <FileBreadcrumbs
      cwd="/repo"
      environmentId={EnvironmentId.make("environment-local")}
      onNavigateFolder={() => {}}
      onOpenFile={() => {}}
      projectName="t3code"
      relativePath={relativePath}
      trail={relativePath}
      workspaceMutationId={null}
    />,
  );

it.each([
  ["src/components/App.tsx", "t3code", "App.tsx", "src/components/App.tsx"],
  ["src/components/App.tsx", "components", "App.tsx", "components/App.tsx"],
  ["src/components/App.tsx", "src", "components", "src/components"],
  ["/Users/me/notes.md", "Users", "notes.md", "/Users/me/notes.md"],
  ["/Users/me/notes.md", "me", "notes.md", "me/notes.md"],
])("copies selected crumbs of %s from %s to %s as a path", async (path, from, to, expected) => {
  await using crumbs = await renderCrumbs(path);
  const nav = crumbs.container.querySelector("nav")!;
  selectCrumbs(nav, from, to);
  expect(copySelection()).toBe(expected);
});

it("leaves a selection inside one crumb to the browser", async () => {
  await using crumbs = await renderCrumbs("src/components/App.tsx");
  const label = crumbs.container.querySelector("[data-current-file-crumb=true]")!;
  const text = document.createTreeWalker(label, NodeFilter.SHOW_TEXT).nextNode()!;
  document.getSelection()!.setBaseAndExtent(text, 0, text, 3);
  expect(copySelection()).toBe("App");
});
