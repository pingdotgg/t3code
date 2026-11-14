import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vite-plus/test";
import type { MarkdownImageSourceResolver } from "./SelectableMarkdownText.types";
import { useRetryingImageSource } from "./useRetryingImageSource";

let resolveImage: ReturnType<typeof useRetryingImageSource>;

function Probe(props: { readonly resolve: MarkdownImageSourceResolver }) {
  const resolver = useRetryingImageSource(props.resolve);
  useLayoutEffect(() => {
    resolveImage = resolver;
  });
  return null;
}

it("asks the next resolver for an image the previous one could not resolve", async () => {
  const root = createRoot(document.createElement("div"));
  const offline: MarkdownImageSourceResolver = async () => {
    throw new Error("Markdown image is unavailable");
  };
  await act(async () => root.render(<Probe resolve={offline} />));
  const askedOnce = resolveImage!;

  let source: unknown = "pending";
  const answered = askedOnce({
    id: "img:0:0",
    url: "assets/shot.png",
    altText: "",
    title: "",
    placement: "inline",
  }).then((value) => {
    source = value;
  });
  await act(async () => {});
  expect(source).toBe("pending");

  const online: MarkdownImageSourceResolver = async (image) => ({
    uri: `https://host/${image.href}`,
  });
  await act(async () => root.render(<Probe resolve={online} />));
  await answered;

  expect(source).toEqual({ uri: "https://host/assets/shot.png" });
  expect(resolveImage).toBe(askedOnce);
  act(() => root.unmount());
});
