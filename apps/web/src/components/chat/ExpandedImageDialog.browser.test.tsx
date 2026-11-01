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
});
