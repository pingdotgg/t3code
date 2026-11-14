import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { createComposerImageThumbnail } from "../../lib/imageCompression";
import { ComposerImageThumbnail } from "./ComposerImageThumbnail";

it("keeps a native preview available after thumbnail generation has failed", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!)));
  const file = new File([blob], "screenshot.png", { type: "image/png" });
  using _bitmap = vi
    .spyOn(window, "createImageBitmap")
    .mockRejectedValue(new Error("Thumbnail decoder unavailable"));
  expect(await createComposerImageThumbnail(file)).toBeNull();

  const container = document.createElement("div");
  const holdLoad = (event: Event) => event.stopPropagation();
  container.addEventListener("load", holdLoad, true);
  using complete = vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  await using screen = await render(
    <ComposerImageThumbnail
      file={file}
      alt={file.name}
      className="size-16 object-cover"
      fallback={<span>Preview unavailable</span>}
    />,
    { container },
  );
  using revoke = vi.spyOn(URL, "revokeObjectURL");
  await expect.element(screen.getByText("Preview unavailable")).toBeVisible();
  const loadingImage = screen.container.querySelector("img")!;
  await loadingImage.decode();
  complete.mockRestore();
  container.removeEventListener("load", holdLoad, true);
  await act(() => loadingImage.dispatchEvent(new Event("load")));
  const image = screen.getByRole("img", { name: file.name });
  await expect.element(image).toBeVisible();
  await expect.element(screen.getByText("Preview unavailable")).not.toBeInTheDocument();
  const src = image.element().getAttribute("src");
  expect(src).toMatch(/^blob:/);
  await screen.unmount();
  expect(revoke).toHaveBeenCalledWith(src);
});

it("shows the fallback while HEIC preparation is pending", async () => {
  let finishReading!: (bytes: ArrayBuffer) => void;
  const metadata = new Promise<ArrayBuffer>((resolve) => {
    finishReading = resolve;
  });
  using _read = vi.spyOn(Blob.prototype, "arrayBuffer").mockReturnValue(metadata);
  const file = new File(["pending"], "photo.heic", { type: "image/heic" });

  await using screen = await render(
    <ComposerImageThumbnail
      file={file}
      alt={file.name}
      className="size-16 object-cover"
      fallback={<span role="img" aria-label="Preparing image" />}
    />,
  );
  try {
    expect(screen.container.querySelector('[aria-label="Preparing image"]')).not.toBeNull();
  } finally {
    finishReading(new ArrayBuffer(0));
    await createComposerImageThumbnail(file);
  }
});
