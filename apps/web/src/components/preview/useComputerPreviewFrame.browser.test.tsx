import type { CuaWindowPreviewFrame } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useComputerPreviewFrame } from "./useComputerPreviewFrame";

const images: DeferredImage[] = [];
class DeferredImage {
  src = "";
  naturalWidth = 480;
  naturalHeight = 800;
  resolve!: () => void;
  ready = new Promise<void>((resolve) => {
    this.resolve = resolve;
  });
  constructor() {
    images.push(this);
  }
  decode() {
    return this.ready;
  }
}

const makeFrame = (data: string): CuaWindowPreviewFrame => ({
  appName: data,
  mimeType: "image/png",
  dataBase64: data,
  width: 480,
  height: 800,
  capturedAt: "2026-10-16T00:00:00Z",
});

function Harness({ frame }: { frame: CuaWindowPreviewFrame | null }) {
  const { canvasRef, frame: painted } = useComputerPreviewFrame(frame);
  return (
    <>
      <canvas ref={canvasRef} />
      <output>{painted?.appName ?? ""}</output>
    </>
  );
}

// Images decode only when a test resolves them, and canvas drawing is recorded.
function stubFrameDecoding() {
  vi.stubGlobal("Image", DeferredImage);
  images.length = 0;
  const drawImage = vi
    .spyOn(CanvasRenderingContext2D.prototype, "drawImage")
    .mockImplementation(() => undefined);
  return {
    drawImage,
    [Symbol.dispose]() {
      drawImage.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

it("keeps the previous pixels and caption until the replacement finishes decoding", async () => {
  using stubs = stubFrameDecoding();
  const { drawImage } = stubs;
  await using screen = await render(<Harness frame={makeFrame("first")} />, { router: false });
  const caption = () => screen.container.querySelector("output")?.textContent;
  await act(async () => images[0]!.resolve());
  expect(caption()).toBe("first");

  await screen.rerender(<Harness frame={makeFrame("next")} />);
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(caption()).toBe("first");
  await act(async () => images[1]!.resolve());
  expect(drawImage).toHaveBeenLastCalledWith(images[1], 0, 0);
  expect(caption()).toBe("next");
});

it("ignores a decode that finishes after a newer frame", async () => {
  using stubs = stubFrameDecoding();
  const { drawImage } = stubs;
  await using screen = await render(<Harness frame={makeFrame("old")} />, { router: false });
  await screen.rerender(<Harness frame={makeFrame("new")} />);
  await act(async () => images[1]!.resolve());
  await act(async () => images[0]!.resolve());
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(screen.container.querySelector("output")?.textContent).toBe("new");
});
