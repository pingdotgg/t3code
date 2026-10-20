import { act, render } from "../../../test/render";
import { expect, it } from "vite-plus/test";

import { FaviconImage } from "./PreviewFaviconIcon";

const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const captured = `${GIF}#captured`;
const remote = `${GIF}#remote`;

it("falls through failed favicon sources and retries when the source list changes", async () => {
  await using screen = await render(
    <FaviconImage sources={[captured, remote]} fallback={<span>fallback</span>} />,
  );
  const image = () => screen.container.querySelector("img");
  const failImage = () => act(async () => image()!.dispatchEvent(new Event("error")));
  expect(image()?.getAttribute("src")).toBe(captured);

  await failImage();
  expect(image()?.getAttribute("src")).toBe(remote);

  await failImage();
  expect(image()).toBeNull();
  expect(screen.container.textContent).toBe("fallback");

  await screen.rerender(
    <FaviconImage sources={[captured, `${GIF}#new-icon`]} fallback={<span>fallback</span>} />,
  );
  expect(image()?.getAttribute("src")).toBe(captured);
});
