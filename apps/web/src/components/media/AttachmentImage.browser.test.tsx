import { act, render, type Screen } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { AttachmentImage } from "./AttachmentImage";
import { decodeImagePreview } from "../files/decodeImagePreview";

vi.mock("../files/decodeImagePreview", () => ({
  decodeImagePreview: vi.fn(),
}));

const revokeUrl = vi.fn();
const bitmap = new Blob(["png"], { type: "image/png" });

function setup() {
  revokeUrl.mockReset();
  vi.mocked(decodeImagePreview).mockReset().mockResolvedValue(bitmap);
}

function image(screen: Screen) {
  const img = screen.container.querySelector("img");
  expect(img).not.toBeNull();
  return img!;
}

// Stands in for the browser failing to decode the current source.
async function failDecode(screen: Screen) {
  const img = image(screen);
  await act(() => {
    img.dispatchEvent(new Event("error"));
  });
  await act(() => vi.dynamicImportSettled());
  return img;
}

function expectDecodeErrorFor(onError: ReturnType<typeof vi.fn>, img: HTMLImageElement) {
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ type: "error", target: img }));
}

it.each([
  { name: "photo.HEIC", mimeType: undefined, heif: true },
  { name: "photo.heif", mimeType: undefined, heif: true },
  { name: "photo", mimeType: "image/heif", heif: true },
  { name: "scan.TIFF", mimeType: undefined, heif: false },
  { name: "scan", mimeType: "image/tiff", heif: false },
])(
  "converts $name after native decoding fails and releases its preview",
  async ({ name, mimeType, heif }) => {
    setup();
    using _createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:jpeg");
    using _revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeUrl);
    await using screen = await render(
      <AttachmentImage src="https://environment.test/photo" name={name} mimeType={mimeType} />,
    );
    expect(decodeImagePreview).not.toHaveBeenCalled();
    await failDecode(screen);
    expect(image(screen).getAttribute("src")).toBe("blob:jpeg");
    expect(decodeImagePreview).toHaveBeenCalledWith(
      "https://environment.test/photo",
      heif,
      expect.any(AbortSignal),
    );
    await screen.unmount();
    expect(revokeUrl).toHaveBeenCalledWith("blob:jpeg");
  },
);

it("leaves PNG errors to the caller without fetching or converting", async () => {
  setup();
  using _createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:jpeg");
  using _revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeUrl);
  const onError = vi.fn();
  await using screen = await render(
    <AttachmentImage src="blob:png" name="photo.png" onError={onError} />,
  );
  expectDecodeErrorFor(onError, await failDecode(screen));
  expect(decodeImagePreview).not.toHaveBeenCalled();
});

it("reports failed HEIC conversion through the existing error handler", async () => {
  setup();
  using _createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:jpeg");
  using _revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeUrl);
  const onError = vi.fn();
  vi.mocked(decodeImagePreview).mockRejectedValue(new Error("unreadable"));
  await using screen = await render(
    <AttachmentImage src="blob:heic" name="photo.heif" onError={onError} />,
  );
  expectDecodeErrorFor(onError, await failDecode(screen));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("discards an old decode when navigating to a different source", async () => {
  setup();
  using _createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:jpeg");
  using _revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeUrl);
  let finishDecode!: (result: Blob) => void;
  vi.mocked(decodeImagePreview).mockReturnValue(
    new Promise((resolve) => {
      finishDecode = resolve;
    }),
  );
  await using screen = await render(<AttachmentImage src="blob:first" name="photo.heic" />);
  await failDecode(screen);
  const secondSource = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>";
  await screen.rerender(<AttachmentImage src={secondSource} name="photo.heic" />);
  await act(() => finishDecode(bitmap));
  expect(image(screen).getAttribute("src")).toBe(secondSource);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(vi.mocked(decodeImagePreview).mock.calls[0]?.[2].aborted).toBe(true);
});
