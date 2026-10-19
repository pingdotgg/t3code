import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AttachmentImage } from "./AttachmentImage";
import { prepareImageForAttachment } from "../../lib/imageCompression";

vi.mock("../../lib/imageCompression", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/imageCompression")>()),
  prepareImageForAttachment: vi.fn(),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const fetchImage = vi.fn();
const revokeUrl = vi.fn();
const jpeg = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchImage);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:jpeg");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeUrl);
  fetchImage.mockResolvedValue(new Response(new Blob(["heic"])));
  vi.mocked(prepareImageForAttachment).mockResolvedValue({
    ok: true,
    file: jpeg,
    recompressed: true,
  });
});

afterEach(async () => {
  await act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function render(element: ReactNode) {
  if (!container) {
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  }
  await act(() => root!.render(element));
}

function image() {
  const img = container!.querySelector("img");
  expect(img).not.toBeNull();
  return img!;
}

// Stands in for the browser failing to decode the current source.
async function failDecode() {
  const img = image();
  await act(() => {
    img.dispatchEvent(new Event("error"));
  });
  return img;
}

function expectDecodeErrorFor(onError: ReturnType<typeof vi.fn>, img: HTMLImageElement) {
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ type: "error", target: img }));
}

it.each([
  { name: "photo.HEIC", mimeType: undefined },
  { name: "photo", mimeType: "image/heif" },
])(
  "converts $name after native decoding fails and releases its preview",
  async ({ name, mimeType }) => {
    await render(
      <AttachmentImage src="https://environment.test/photo" name={name} mimeType={mimeType} />,
    );
    expect(fetchImage).not.toHaveBeenCalled();
    await failDecode();
    expect(image().getAttribute("src")).toBe("blob:jpeg");
    expect(prepareImageForAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ name, type: "image/heic" }),
      50 * 1024 * 1024,
    );
    await act(() => root!.unmount());
    root = undefined;
    expect(revokeUrl).toHaveBeenCalledWith("blob:jpeg");
  },
);

it("leaves PNG errors to the caller without fetching or converting", async () => {
  const onError = vi.fn();
  await render(<AttachmentImage src="blob:png" name="photo.png" onError={onError} />);
  expectDecodeErrorFor(onError, await failDecode());
  expect(fetchImage).not.toHaveBeenCalled();
});

it("reports failed HEIC conversion through the existing error handler", async () => {
  const onError = vi.fn();
  vi.mocked(prepareImageForAttachment).mockResolvedValue({ ok: false, reason: "unreadable" });
  await render(<AttachmentImage src="blob:heic" name="photo.heif" onError={onError} />);
  expectDecodeErrorFor(onError, await failDecode());
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("discards an old decode when navigating to a different source", async () => {
  let finishDecode!: (result: Awaited<ReturnType<typeof prepareImageForAttachment>>) => void;
  vi.mocked(prepareImageForAttachment).mockReturnValue(
    new Promise((resolve) => {
      finishDecode = resolve;
    }),
  );
  await render(<AttachmentImage src="blob:first" name="photo.heic" />);
  await failDecode();
  await render(<AttachmentImage src="blob:second" name="photo.heic" />);
  await act(() => finishDecode({ ok: true, file: jpeg, recompressed: true }));
  expect(image().getAttribute("src")).toBe("blob:second");
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(fetchImage.mock.calls[0]?.[1].signal.aborted).toBe(true);
});
