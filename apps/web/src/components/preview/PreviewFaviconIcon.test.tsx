import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/browserFaviconStore", () => ({ useFaviconForThreadUrl: () => null }));

import { FaviconImage } from "./PreviewFaviconIcon";

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("falls through failed favicon sources and retries when the source list changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const captured = "data:image/png;base64,AAAA";
  const remote = "https://public.example/icon";
  await act(async () => {
    renderer = create(
      <FaviconImage sources={[captured, remote]} fallback={<span>fallback</span>} />,
    );
  });
  expect(renderer!.root.findByType("img").props.src).toBe(captured);

  await act(async () => renderer!.root.findByType("img").props.onError());
  expect(renderer!.root.findByType("img").props.src).toBe(remote);

  await act(async () => renderer!.root.findByType("img").props.onError());
  expect(renderer!.root.findAllByType("img")).toHaveLength(0);
  expect(renderer!.root.findByType("span").children).toEqual(["fallback"]);

  await act(async () => {
    renderer!.update(
      <FaviconImage
        sources={[captured, "https://public.example/new-icon"]}
        fallback={<span>fallback</span>}
      />,
    );
  });
  expect(renderer!.root.findByType("img").props.src).toBe(captured);
});
