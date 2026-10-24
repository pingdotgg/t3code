import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { BrowserDocumentFrame } from "./BrowserDocumentFrame";

const pdf = (src: string, documentKey: string) => (
  <BrowserDocumentFrame src={src} documentKey={documentKey} title="paper.pdf" pdf />
);

it("keeps a PDF open across URL renewals until its document changes", async () => {
  await using screen = await render(pdf("/asset/first/paper.pdf?file-revision=a", "paper:a"));
  const embed = () => screen.container.querySelector("embed");
  const opened = embed();
  expect(opened?.getAttribute("src")).toBe("/asset/first/paper.pdf?file-revision=a");

  // Another command re-signs the URL, but the file is unchanged.
  await screen.rerender(pdf("/asset/second/paper.pdf?file-revision=a", "paper:a"));
  expect(embed()).toBe(opened);
  expect(embed()?.getAttribute("src")).toBe("/asset/first/paper.pdf?file-revision=a");

  await screen.rerender(pdf("/asset/third/paper.pdf?file-revision=b", "paper:b"));
  expect(embed()).not.toBe(opened);
  expect(embed()?.getAttribute("src")).toBe("/asset/third/paper.pdf?file-revision=b");
});
