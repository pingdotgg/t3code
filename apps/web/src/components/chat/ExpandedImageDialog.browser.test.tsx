import type { SnapShotSource } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

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

function MediaOpener() {
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
            alt="repro shot"
            width={200}
            height={200}
            onClick={() => setOpen(true)}
          />
        </MediaActions>
        <div className="h-[600px]" />
      </TooltipScrollDismissArea>
      {open ? (
        <ExpandedImageDialog
          preview={{ images: [{ src: PIXEL, name: "shot.png", actionsSource: source }], index: 0 }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
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

  it("Escape returns focus to a mouse-opened image without opening its path tooltip", async () => {
    // The dialog renders no links and reads no route.
    await using screen = await render(<MediaOpener />, { router: false });

    const opener = screen.getByRole("img", { name: "repro shot" });
    await userEvent.click(opener);
    await expect.element(screen.getByRole("button", { name: "Close image preview" })).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    await expect.element(opener).toHaveFocus();
    expect(
      opener.element().matches(":focus-visible"),
      "focus returned to a mouse-opened image is :focus-visible",
    ).toBe(false);
    await expect.element(screen.getByText("/work/shot.png")).not.toBeInTheDocument();
  });

  it("a hovered image's path tooltip closes on scroll after its mouse-opened preview closes", async () => {
    // The dialog renders no links and reads no route.
    await using screen = await render(<MediaOpener />, { router: false });

    const opener = screen.getByRole("img", { name: "repro shot" });
    await userEvent.click(opener);
    await userEvent.keyboard("{Escape}");
    await expect.element(opener).toHaveFocus();
    await userEvent.hover(opener);
    await expect.element(screen.getByText("/work/shot.png")).toBeVisible();

    screen.getByTestId("timeline").element().scrollTop = 20;
    await expect.element(screen.getByText("/work/shot.png")).not.toBeInTheDocument();
  });
});
