import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { FaviconImage } from "./PreviewFaviconIcon";

const GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
const captured = `${GIF}#captured`;
const remote = `${GIF}#remote`;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const image = () => container.querySelector("img");
const failImage = () => act(async () => image()!.dispatchEvent(new Event("error")));

it("falls through failed favicon sources and retries when the source list changes", async () => {
  await act(async () =>
    root.render(<FaviconImage sources={[captured, remote]} fallback={<span>fallback</span>} />),
  );
  expect(image()?.getAttribute("src")).toBe(captured);

  await failImage();
  expect(image()?.getAttribute("src")).toBe(remote);

  await failImage();
  expect(image()).toBeNull();
  expect(container.textContent).toBe("fallback");

  await act(async () =>
    root.render(
      <FaviconImage sources={[captured, `${GIF}#new-icon`]} fallback={<span>fallback</span>} />,
    ),
  );
  expect(image()?.getAttribute("src")).toBe(captured);
});
