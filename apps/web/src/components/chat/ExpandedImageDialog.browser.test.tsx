import { useState } from "react";
import type { SnapShotSource } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
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

function ImagePreviewOpener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open preview
      </button>
      {open && (
        <ExpandedImageDialog
          preview={{ images: [{ src: PIXEL, name: "shot.png", source: snapShotSource }], index: 0 }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

describe("ExpandedImageDialog", () => {
  it.each([
    { opener: "mouse", focusVisible: false },
    { opener: "keyboard", focusVisible: true },
  ])("returns $opener focus to the opener on close", async (c) => {
    await using screen = await render(<ImagePreviewOpener />, {
      // The opener renders no links and reads no route.
      router: false,
    });
    const opener = screen.getByRole("button", { name: "Open preview" });
    if (c.opener === "mouse") {
      await userEvent.click(opener);
    } else {
      await userEvent.keyboard("{Tab}");
      await userEvent.keyboard("{Enter}");
    }
    await expect.element(page.getByRole("button", { name: "Close image preview" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(opener).toHaveFocus();
    expect(opener.element().matches(":focus-visible")).toBe(c.focusVisible);
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

  it("scrolling pans the image while Ctrl+wheel zooms around the pointer", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 1200;
    await using screen = await render(
      <ExpandedImageDialog
        preview={{ images: [{ src: canvas.toDataURL(), name: "large.png" }], index: 0 }}
        onClose={() => {}}
      />,
      // The dialog renders no links and reads no route.
      { router: false },
    );
    const viewportLocator = screen.getByRole("region", { name: "large.png, zoomable image" });
    const viewport = viewportLocator.element() as HTMLElement;
    const image = screen.getByRole("img", { name: "large.png" }).element() as HTMLElement;
    await vi.waitFor(() => expect(image.style.width).not.toBe(""));
    const fitWidth = image.getBoundingClientRect().width;
    const wheels: { ctrlKey: boolean; canceled: boolean }[] = [];
    const recordWheel = (event: WheelEvent) =>
      wheels.push({ ctrlKey: event.ctrlKey, canceled: event.defaultPrevented });
    document.addEventListener("wheel", recordWheel);
    using _wheelListener = {
      [Symbol.dispose]: () => document.removeEventListener("wheel", recordWheel),
    };
    // Wheels land on the viewport's center; this is the image fraction under it.
    const pointerFraction = () => {
      const viewportBounds = viewport.getBoundingClientRect();
      const imageBounds = image.getBoundingClientRect();
      return {
        x: (viewportBounds.left + viewportBounds.width / 2 - imageBounds.left) / imageBounds.width,
        y: (viewportBounds.top + viewportBounds.height / 2 - imageBounds.top) / imageBounds.height,
      };
    };
    const ctrlWheel = async (deltaY: number) => {
      await userEvent.keyboard("{Control>}");
      await userEvent.wheel(viewportLocator, { delta: { y: deltaY } });
      await userEvent.keyboard("{/Control}");
    };

    await userEvent.wheel(viewportLocator, { delta: { y: 120 } });
    expect(wheels.at(-1)).toEqual({ ctrlKey: false, canceled: false });
    expect(image.getBoundingClientRect().width).toBe(fitWidth);

    await ctrlWheel(-100);
    expect(wheels.at(-1)).toEqual({ ctrlKey: true, canceled: true });
    const zoomedWidth = image.getBoundingClientRect().width;
    expect(zoomedWidth).toBeCloseTo(fitWidth * Math.E, 0);

    const pan = async (delta: { x: number; y: number }) => {
      const { scrollLeft, scrollTop } = viewport;
      await userEvent.wheel(viewportLocator, { delta });
      await vi.waitFor(() => {
        expect(Math.sign(viewport.scrollLeft - scrollLeft)).toBe(Math.sign(delta.x));
        expect(Math.sign(viewport.scrollTop - scrollTop)).toBe(Math.sign(delta.y));
      });
    };
    await pan({ x: 60, y: 0 });
    await pan({ x: 0, y: 60 });
    await pan({ x: -40, y: -40 });
    expect(wheels.filter((wheel) => !wheel.ctrlKey).every((wheel) => !wheel.canceled)).toBe(true);
    expect(image.getBoundingClientRect().width).toBe(zoomedWidth);

    const anchor = pointerFraction();
    await ctrlWheel(-50);
    expect(image.getBoundingClientRect().width).toBeGreaterThan(zoomedWidth);
    expect(pointerFraction().x).toBeCloseTo(anchor.x, 2);
    expect(pointerFraction().y).toBeCloseTo(anchor.y, 2);
  });

  it("draws in place: the image, its caption and the controls stay put", async () => {
    const file = new File([await (await fetch(PIXEL)).blob()], "shot.png", { type: "image/png" });
    const save = vi.fn(async () => null);
    const onClose = vi.fn();
    await using screen = await render(
      <ExpandedImageDialog
        preview={{
          images: [
            {
              src: PIXEL,
              name: "shot.png",
              mimeType: "image/png",
              edit: { file, name: "shot.png", mimeType: "image/png", save },
            },
            { src: PIXEL, name: "other.png" },
          ],
          index: 0,
        }}
        onClose={onClose}
      />,
      // The dialog renders no links and reads no route.
      { router: false },
    );
    const image = screen.getByRole("img", { name: "shot.png", exact: true });
    const caption = screen.getByText("shot.png (1/2)");
    await expect.element(image).toBeVisible();
    const rects = () =>
      [image, caption].map((locator) => locator.element().getBoundingClientRect().toJSON());
    const before = rects();

    await userEvent.click(screen.getByRole("button", { name: "Draw on image" }));
    await expect.element(screen.getByRole("button", { name: "Done" })).toHaveFocus();
    expect(rects()).toEqual(before);
    await expect
      .element(screen.getByRole("button", { name: "Draw on image" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByRole("button", { name: "Next media" })).toBeEnabled();

    // The close button cancels the drawing and keeps the preview open.
    await userEvent.click(screen.getByRole("button", { name: "Cancel drawing" }));
    await expect.element(screen.getByRole("button", { name: "Done" })).not.toBeInTheDocument();
    expect(rects()).toEqual(before);
    expect(onClose).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    { gesture: "backdrop to image", closes: false },
    { gesture: "image to backdrop", closes: false },
    { gesture: "backdrop to backdrop", closes: true },
  ])(
    "a press dragged from the $gesture closes the preview: $closes",
    async ({ gesture, closes }) => {
      await page.viewport(1280, 800);
      const onClose = vi.fn();
      await using screen = await render(
        <ExpandedImageDialog
          preview={{ images: [{ src: PIXEL, name: "shot.png" }], index: 0 }}
          onClose={onClose}
        />,
        // The dialog renders no links and reads no route.
        { router: false },
      );
      const image = screen.getByRole("img", { name: "shot.png", exact: true });
      await expect.element(image).toBeVisible();
      const popup = screen.getByRole("dialog").element();
      const box = popup.getBoundingClientRect();
      const imageBox = image.element().getBoundingClientRect();
      // The empty part of the preview around the image closes it on a plain click.
      const empty = { x: box.left + 8, y: box.top + box.height / 2 };
      expect(document.elementFromPoint(empty.x, empty.y)).toBe(popup);
      const onImage = {
        x: imageBox.left + imageBox.width / 2,
        y: imageBox.top + imageBox.height / 2,
      };
      const from = gesture.startsWith("image") ? onImage : empty;
      const to = gesture.endsWith("image") ? onImage : empty;
      const frame = window.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const mouse = (type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number) =>
        cdp().send("Input.dispatchMouseEvent", {
          type,
          x: frame.left + x,
          y: frame.top + y,
          button: "left",
          buttons: type === "mouseReleased" ? 0 : 1,
          clickCount: 1,
        });

      await mouse("mousePressed", from.x, from.y);
      await mouse("mouseMoved", to.x, to.y);
      await mouse("mouseReleased", to.x, to.y);

      if (closes) await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      else {
        await expect.element(image).toBeVisible();
        expect(onClose).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves cursor-anchored zoom in an RTL document", async () => {
    const previousDir = document.documentElement.getAttribute("dir");
    document.documentElement.dir = "rtl";
    using _restoreDir = {
      [Symbol.dispose]: () => {
        if (previousDir === null) document.documentElement.removeAttribute("dir");
        else document.documentElement.setAttribute("dir", previousDir);
      },
    };
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 1200;
    await using _screen = await render(
      <ExpandedImageDialog
        preview={{ images: [{ src: canvas.toDataURL(), name: "rtl-large.png" }], index: 0 }}
        onClose={() => {}}
      />,
      { router: false },
    );
    const viewportLocator = page.getByRole("region", { name: "rtl-large.png, zoomable image" });
    const viewport = viewportLocator.element() as HTMLElement;
    const image = page.getByRole("img", { name: "rtl-large.png" }).element() as HTMLElement;
    await vi.waitFor(() => expect(image.style.width).not.toBe(""));
    expect(getComputedStyle(document.documentElement).direction).toBe("rtl");
    expect(getComputedStyle(viewport).direction).toBe("ltr");

    const bounds = viewport.getBoundingClientRect();
    const clickX = bounds.left + bounds.width * 0.4;
    const clickY = bounds.top + bounds.height * 0.5;
    const imageBefore = image.getBoundingClientRect();
    const expectedFractionX = (clickX - imageBefore.left) / imageBefore.width;

    await act(() => {
      viewport.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: clickX, clientY: clickY }),
      );
    });
    const imageAfter = image.getBoundingClientRect();
    const actualFractionX = (clickX - imageAfter.left) / imageAfter.width;
    expect(imageAfter.width).toBeGreaterThan(imageBefore.width);
    expect(actualFractionX).toBeCloseTo(expectedFractionX, 2);
  });
});
