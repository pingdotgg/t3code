import type { SnapShotSource } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ExpandedImageDialog } from "./ExpandedImageDialog";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const snapShotSource: SnapShotSource = {
  kind: "snap-shot",
  capturedAt: "2026-01-01T00:00:00.000Z",
  appName: "Finder",
  windowTitle: "Downloads",
};

const D2_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1174 920"><rect width="1174" height="920"/></svg>';

// A full-page screenshot: ~22:1, wider than the viewer once zoomed to fill it.
const TALL = { width: 1170, height: 26490 };

async function renderTallScreenshot() {
  const canvas = new OffscreenCanvas(TALL.width, TALL.height);
  canvas.getContext("2d")?.fillRect(0, 0, TALL.width, TALL.height);
  const src = URL.createObjectURL(await canvas.convertToBlob({ type: "image/png" }));
  await using stack = new AsyncDisposableStack();
  stack.defer(() => URL.revokeObjectURL(src));
  const screen = stack.use(
    await render(
      <ExpandedImageDialog
        preview={{ images: [{ src, name: "Page" }], index: 0 }}
        onClose={vi.fn()}
      />,
      // The dialog renders no links and reads no route.
      { router: false },
    ),
  );
  const viewer = screen.getByRole("region", { name: "Page, zoomable image" });
  const image = screen.getByRole("img", { name: "Page" });
  const availableWidth = window.innerWidth * 0.92 - (window.innerWidth >= 640 ? 96 : 0);
  const maxHeight = Math.min(window.innerHeight * 0.86, window.innerHeight - 160);
  const fitWidth = TALL.width * Math.min(1, availableWidth / TALL.width, maxHeight / TALL.height);
  await vi.waitFor(() =>
    expect(image.element().getBoundingClientRect().width).toBeCloseTo(fitWidth, 0),
  );
  return { viewer, image, availableWidth, stack: stack.move() };
}

describe("ExpandedImageDialog", () => {
  it.each(["/work/pipeline.svg", "/work/diagram#v2.svg", "/work/diagram?v2.svg"])(
    "fits a markdown SVG without intrinsic size to the viewer: %s",
    async (path) => {
      const src = URL.createObjectURL(new Blob([D2_SVG], { type: "image/svg+xml" }));
      using _src = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
      await using screen = await render(
        <ExpandedImageDialog
          preview={{
            images: [
              {
                src,
                name: "Pipeline",
                actionsSource: {
                  kind: "image",
                  name: "Pipeline",
                  src,
                  reference: { kind: "file", path },
                },
              },
            ],
            index: 0,
          }}
          onClose={vi.fn()}
        />,
        // The dialog renders no links and reads no route.
        { router: false },
      );

      const viewer = screen.getByRole("region", { name: "Pipeline, zoomable image" });
      const availableWidth = window.innerWidth * 0.92 - (window.innerWidth >= 640 ? 96 : 0);
      await vi.waitFor(() =>
        expect(viewer.element().getBoundingClientRect().width).toBeCloseTo(availableWidth, 0),
      );
    },
  );

  it("Escape closes a popup opened inside the dialog before the dialog", async () => {
    const onClose = vi.fn();
    await using screen = await render(
      <ExpandedImageDialog
        preview={{ images: [{ src: PIXEL, name: "shot.png", source: snapShotSource }], index: 0 }}
        onClose={onClose}
      />,
      // The dialog renders no links and reads no route.
      { router: false },
    );

    await userEvent.click(screen.getByRole("button", { name: "No accessibility data" }));
    await expect.element(screen.getByText("Accessibility data")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByText("Accessibility data")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // Focus returns to the popup's trigger and opens its tooltip; leave it for a plain control.
    (screen.getByRole("button", { name: "Close image preview" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("a click on a tall image fills the viewer width", async () => {
    const { viewer, image, availableWidth, stack } = await renderTallScreenshot();
    await using _stack = stack;

    await userEvent.click(viewer);

    const fillWidth = Math.min(availableWidth, TALL.width);
    await vi.waitFor(() => {
      const width = image.element().getBoundingClientRect().width;
      expect(width).toBeGreaterThan(fillWidth * 0.9);
      expect(width).toBeLessThanOrEqual(fillWidth + 1);
    });
  });

  it("zooming in on a tall image reaches its natural size", async () => {
    const { viewer, image, stack } = await renderTallScreenshot();
    await using _stack = stack;

    (viewer.element() as HTMLElement).focus();
    await userEvent.keyboard("+".repeat(20));

    await vi.waitFor(() =>
      expect(image.element().getBoundingClientRect().width).toBeGreaterThanOrEqual(TALL.width - 1),
    );
  });
});
