import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { ImageGallery } from "./ImageGallery";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImageItem } from "../chat/ExpandedImagePreview";

function installShareApis(share: Navigator["share"], canShare: Navigator["canShare"]) {
  const original = ["share", "canShare"].map(
    (name) => [name, Object.getOwnPropertyDescriptor(navigator, name)] as const,
  );
  Object.defineProperties(navigator, {
    share: { configurable: true, value: share },
    canShare: { configurable: true, value: canShare },
  });
  return {
    [Symbol.dispose]() {
      for (const [name, descriptor] of original) {
        if (descriptor) Object.defineProperty(navigator, name, descriptor);
        else Reflect.deleteProperty(navigator, name);
      }
    },
  };
}

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

it("passes the exact GIF snapshot used to decode the frame sheet to chat", async () => {
  const gif = Uint8Array.from(
    atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
    (char) => char.charCodeAt(0),
  );
  const image = { src: PIXEL, name: "animation.gif", mimeType: "image/gif" };
  const readImage = vi.fn(async () => new Blob([gif], { type: "application/octet-stream" }));
  const onFrameSheet = vi
    .fn<(item: ExpandedImageItem, file: File, context: string, original: File) => Promise<void>>()
    .mockResolvedValue(undefined);
  await using screen = await render(
    <ImageGallery
      images={[image]}
      readImage={readImage}
      onFrameSheet={onFrameSheet}
      onOpen={vi.fn()}
      onApply={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Edit frames" }));
  await vi.waitFor(() => expect(onFrameSheet).toHaveBeenCalledOnce());
  expect(readImage).toHaveBeenCalledOnce();
  const [item, sheet, context, original] = onFrameSheet.mock.calls[0]!;
  expect(item).toBe(image);
  expect(sheet.type).toBe("image/png");
  expect(context).toContain("all 1 frames of animation.gif");
  expect(original.name).toBe("animation.gif");
  expect(original.type).toBe("image/gif");
  expect(new Uint8Array(await original.arrayBuffer())).toEqual(gif);
  const bitmap = await createImageBitmap(sheet);
  expect(bitmap.width).toBeGreaterThan(0);
  expect(bitmap.height).toBeGreaterThan(0);
  bitmap.close();
});

it("keeps batch selections and feedback through a failed edit while locking competing actions", async () => {
  const first = { src: PIXEL, name: "first.png" };
  const second = { src: PIXEL, name: "second.png" };
  let rejectCompletion!: (reason: Error) => void;
  const completion = new Promise<void>((_resolve, reject) => {
    rejectCompletion = reject;
  });
  const onApply = vi.fn(() => completion);
  const onOpen = vi.fn();
  await using screen = await render(
    <ImageGallery
      images={[first, { src: PIXEL, name: "video.mp4", type: "video" }, second]}
      onOpen={onOpen}
      onApply={onApply}
      onClose={vi.fn()}
      readImage={async () => new Blob()}
    />,
  );
  await expect.element(screen.getByRole("button", { name: "Add edits to chat" })).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox", { name: "first.png" }));
  await expect.element(screen.getByText("1 selected", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("checkbox", { name: "Select all" }))
    .toHaveAttribute("aria-checked", "mixed");
  await userEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
  await expect.element(screen.getByText("2 selected", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("checkbox", { name: "second.png" }));
  await userEvent.click(screen.getByRole("button", { name: "Open image 3, second.png" }));
  expect(onOpen).toHaveBeenCalledWith(2);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Edit selected images" }),
    "Use blue backgrounds",
  );
  await userEvent.click(screen.getByRole("button", { name: "Add edits to chat" }));
  await expect.element(screen.getByRole("button", { name: "Preparing images…" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  await expect.element(screen.getByRole("checkbox", { name: "first.png" })).toBeDisabled();
  expect(onApply).toHaveBeenCalledOnce();
  expect(onApply).toHaveBeenCalledWith([first], "Use blue backgrounds");
  await act(() => rejectCompletion(new Error("Reconnect to attach the images.")));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Reconnect to attach the images.");
  await expect
    .element(screen.getByRole("textbox", { name: "Edit selected images" }))
    .toHaveValue("Use blue backgrounds");
  await expect.element(screen.getByRole("checkbox", { name: "first.png" })).toBeChecked();
  await expect.element(screen.getByRole("checkbox", { name: "second.png" })).not.toBeChecked();
  await expect.element(screen.getByRole("button", { name: "Add edits to chat" })).toBeEnabled();
});

it("prepares a ZIP before a second share gesture, ignores cancellation and invalidates changed selections", async () => {
  const share = vi
    .fn<Navigator["share"]>()
    .mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"))
    .mockResolvedValue(undefined);
  const canShare = vi.fn<Navigator["canShare"]>().mockReturnValue(true);
  using _share = installShareApis(share, canShare);
  const readImage = vi.fn(async () => new Blob([new Uint8Array([0, 255])], { type: "image/png" }));
  await using screen = await render(
    <ImageGallery
      images={[
        { src: PIXEL, name: "first.png" },
        { src: PIXEL, name: "second.png" },
      ]}
      readImage={readImage}
      onOpen={vi.fn()}
      onApply={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Prepare share" }));
  await expect.element(screen.getByRole("button", { name: "Share ZIP" })).toBeEnabled();
  expect(share).not.toHaveBeenCalled();
  expect(readImage).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole("button", { name: "Share ZIP" }));
  await vi.waitFor(() => expect(share).toHaveBeenCalledOnce());
  await expect.element(screen.getByRole("button", { name: "Share ZIP" })).toBeEnabled();
  expect(screen.getByRole("alert").elements()).toHaveLength(0);
  const file = share.mock.calls[0]![0]!.files![0]!;
  expect(file.name).toBe("t3-images.zip");
  expect(file.type).toBe("application/zip");
  expect(file.size).toBeGreaterThan(0);
  await userEvent.click(screen.getByRole("checkbox", { name: "first.png" }));
  await expect.element(screen.getByRole("button", { name: "Prepare share" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Prepare share" }));
  await expect.element(screen.getByRole("button", { name: "Share ZIP" })).toBeEnabled();
  expect(readImage).toHaveBeenCalledTimes(3);
  await userEvent.click(screen.getByRole("button", { name: "Share ZIP" }));
  await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(2));
});

it("reports unsupported ZIP sharing and recovers for a new preparation", async () => {
  const share = vi.fn<Navigator["share"]>();
  const canShare = vi.fn<Navigator["canShare"]>().mockReturnValueOnce(false).mockReturnValue(true);
  using _share = installShareApis(share, canShare);
  await using screen = await render(
    <ImageGallery
      images={[{ src: PIXEL, name: "image.png" }]}
      readImage={async () => new Blob(["pixels"])}
      onOpen={vi.fn()}
      onApply={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Prepare share" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("This browser cannot share ZIP files. Download the images to share them.");
  await expect.element(screen.getByRole("button", { name: "Prepare share" })).toBeEnabled();
  expect(share).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Prepare share" }));
  await expect.element(screen.getByRole("button", { name: "Share ZIP" })).toBeEnabled();
  expect(screen.getByRole("alert").elements()).toHaveLength(0);
});

it("recovers a failed download without losing selection and downloads the retried subset once", async () => {
  const readImage = vi
    .fn<(image: ExpandedImageItem) => Promise<Blob>>()
    .mockRejectedValueOnce(new Error("Image is unavailable"))
    .mockResolvedValue(new Blob(["pixels"]));
  await using screen = await render(
    <ImageGallery
      images={[
        { src: PIXEL, name: "first.png" },
        { src: PIXEL, name: "second.png" },
      ]}
      readImage={readImage}
      onOpen={vi.fn()}
      onApply={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  using click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await userEvent.click(screen.getByRole("checkbox", { name: "second.png" }));
  await userEvent.click(screen.getByRole("button", { name: "Download 1 selected" }));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Image is unavailable");
  await expect.element(screen.getByRole("checkbox", { name: "second.png" })).toBeChecked();
  await userEvent.click(screen.getByRole("button", { name: "Download 1 selected" }));
  await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(readImage).toHaveBeenCalledTimes(2);
  expect(readImage.mock.calls.every(([image]) => image.name === "second.png")).toBe(true);
});

it("requires nonblank feedback and submits the selected originals with the keyboard shortcut", async () => {
  const image = { src: PIXEL, name: "image.png" };
  const onApply = vi.fn().mockResolvedValue(undefined);
  await using screen = await render(
    <ImageGallery
      images={[image]}
      readImage={async () => new Blob()}
      onOpen={vi.fn()}
      onApply={onApply}
      onClose={vi.fn()}
    />,
  );
  await userEvent.click(screen.getByRole("checkbox", { name: "image.png" }));
  const feedback = screen.getByRole("textbox", { name: "Edit selected images" });
  await userEvent.fill(feedback, "   ");
  await expect.element(screen.getByRole("button", { name: "Add edits to chat" })).toBeDisabled();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(onApply).not.toHaveBeenCalled();
  await userEvent.fill(feedback, "  Use blue backgrounds  ");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await vi.waitFor(() => expect(onApply).toHaveBeenCalledOnce());
  expect(onApply).toHaveBeenCalledWith([image], "Use blue backgrounds");
});

it("dismisses the gallery with Escape while feedback is focused", async () => {
  const onClose = vi.fn();
  const onApply = vi.fn().mockResolvedValue(undefined);
  await using screen = await render(
    <ExpandedImageDialog
      preview={{ images: [{ src: PIXEL, name: "image.png" }], index: 0, gallery: true }}
      onClose={onClose}
      onApplyBatch={onApply}
    />,
  );
  const feedback = screen.getByRole("textbox", { name: "Edit selected images" });
  await userEvent.fill(feedback, "Keep this feedback until I close the gallery");
  await expect.element(feedback).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onApply).not.toHaveBeenCalled();
});
