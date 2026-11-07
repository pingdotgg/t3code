import { useState } from "react";
import type { SnapShotSource } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { MediaActions } from "../media/MediaActions";
import { TooltipScrollDismissArea } from "../ui/tooltip";
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

function ImagePreviewTimeline() {
  const [open, setOpen] = useState(false);
  const source = {
    kind: "image" as const,
    name: "shot.png",
    src: PIXEL,
    reference: { kind: "file" as const, path: "/work/shot.png" },
  };
  return (
    <>
      <TooltipScrollDismissArea data-testid="timeline" className="mt-16 h-80 overflow-y-auto">
        <MediaActions source={source}>
          <img
            src={PIXEL}
            alt="Timeline image"
            width={200}
            height={200}
            role="button"
            tabIndex={0}
            aria-label="Preview Timeline image"
            onClick={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(true);
              }
            }}
          />
        </MediaActions>
        <div className="h-[600px]" />
      </TooltipScrollDismissArea>
      <button type="button">Next timeline action</button>
      {open && (
        <ExpandedImageDialog
          preview={{ images: [{ src: PIXEL, name: "shot.png", actionsSource: source }], index: 0 }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

describe("ExpandedImageDialog", () => {
  it("dismisses the image path tooltip on scroll after returning focus from the preview", async () => {
    await using screen = await render(<ImagePreviewTimeline />);
    const image = screen.getByRole("button", { name: "Preview Timeline image" });
    await userEvent.click(image);
    await expect.element(page.getByRole("button", { name: "Close image preview" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(image).toHaveFocus();
    expect(image.element().matches(":focus-visible")).toBe(false);
    await expect.element(page.getByText("/work/shot.png", { exact: true })).not.toBeInTheDocument();
    await userEvent.unhover(image);
    await userEvent.hover(image);
    await expect.element(page.getByText("/work/shot.png", { exact: true })).toBeVisible();
    screen.getByTestId("timeline").element().scrollTop = 20;
    await expect.element(page.getByText("/work/shot.png", { exact: true })).not.toBeInTheDocument();
    await expect.element(image).toHaveFocus();
    await userEvent.keyboard("{Tab}{Shift>}{Tab}{/Shift}");
    await expect.element(image).toHaveFocus();
    expect(image.element().matches(":focus-visible")).toBe(true);
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("button", { name: "Close image preview" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(image).toHaveFocus();
    expect(image.element().matches(":focus-visible")).toBe(true);
  });

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
