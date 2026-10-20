import { render } from "../../../test/render";
import { expect, it } from "vite-plus/test";

import { BrowserDocumentFrame } from "./BrowserDocumentFrame";

it("keeps the loaded HTML page while its signed URL renews, and reloads on a new revision", async () => {
  const frameUi = (src: string, documentKey?: string) => (
    <BrowserDocumentFrame src={src} title="Review" pdf={false} documentKey={documentKey} />
  );

  await using screen = await render(frameUi("about:blank#token-a", "review.html:1"));
  const { container } = screen;
  const frame = container.querySelector("iframe");
  await screen.rerender(frameUi("about:blank#token-b", "review.html:1"));
  expect(container.querySelector("iframe")).toBe(frame);
  expect(frame?.getAttribute("src")).toBe("about:blank#token-a");

  await screen.rerender(frameUi("about:blank#token-c", "review.html:2"));
  expect(container.querySelector("iframe")).not.toBe(frame);
  expect(container.querySelector("iframe")?.getAttribute("src")).toBe("about:blank#token-c");

  await screen.rerender(frameUi("about:blank#first"));
  const urlDrivenFrame = container.querySelector("iframe");
  await screen.rerender(frameUi("about:blank#second"));
  expect(container.querySelector("iframe")).not.toBe(urlDrivenFrame);
  expect(container.querySelector("iframe")?.getAttribute("src")).toBe("about:blank#second");
});
