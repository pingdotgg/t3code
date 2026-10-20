import { act, render, stubGlobal, type Screen } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { AttachmentImage } from "./AttachmentImage";
import { prepareImageForAttachment } from "../../lib/imageCompression";

vi.mock("../../lib/imageCompression", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/imageCompression")>()),
  prepareImageForAttachment: vi.fn(),
}));

const fetchImage = vi.fn();
const revokeUrl = vi.fn();
const jpeg = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });

function setup() {
  fetchImage.mockReset().mockResolvedValue(new Response(new Blob(["heic"])));
  revokeUrl.mockReset();
  vi.mocked(prepareImageForAttachment)
    .mockReset()
    .mockResolvedValue({ ok: true, file: jpeg, recompressed: true });
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
    setup();
    using _fetch = stubGlobal("fetch", fetchImage);
    using _createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:jpeg");
    using _revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeUrl);
    await using screen = await render(
      <AttachmentImage src="https://environment.test/photo" name={name} mimeType={mimeType} />,
    );
    expect(fetchImage).not.toHaveBeenCalled();
    await failDecode(screen);
    await vi.waitFor(() => expect(image(screen).getAttribute("src")).toBe("blob:jpeg"));
    expect(prepareImageForAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ name, type: "image/heic" }),
      50 * 1024 * 1024,
    );
    await screen.unmount();
    expect(revokeUrl).toHaveBeenCalledWith("blob:jpeg");
  },
);

it("leaves PNG errors to the caller without fetching or converting", async () => {
  setup();
  using _fetch = stubGlobal("fetch", fetchImage);
  using _createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:jpeg");
  using _revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeUrl);
  const onError = vi.fn();
  await using screen = await render(
    <AttachmentImage src="blob:png" name="photo.png" onError={onError} />,
  );
  expectDecodeErrorFor(onError, await failDecode(screen));
  expect(fetchImage).not.toHaveBeenCalled();
});

it("reports failed HEIC conversion through the existing error handler", async () => {
  setup();
  using _fetch = stubGlobal("fetch", fetchImage);
  using _createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:jpeg");
  using _revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeUrl);
  const onError = vi.fn();
  vi.mocked(prepareImageForAttachment).mockResolvedValue({ ok: false, reason: "unreadable" });
  await using screen = await render(
    <AttachmentImage src="blob:heic" name="photo.heif" onError={onError} />,
  );
  expectDecodeErrorFor(onError, await failDecode(screen));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("discards an old decode when navigating to a different source", async () => {
  setup();
  using _fetch = stubGlobal("fetch", fetchImage);
  using _createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:jpeg");
  using _revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeUrl);
  let finishDecode!: (result: Awaited<ReturnType<typeof prepareImageForAttachment>>) => void;
  vi.mocked(prepareImageForAttachment).mockReturnValue(
    new Promise((resolve) => {
      finishDecode = resolve;
    }),
  );
  await using screen = await render(<AttachmentImage src="blob:first" name="photo.heic" />);
  await failDecode(screen);
  await screen.rerender(<AttachmentImage src="blob:second" name="photo.heic" />);
  await act(() => finishDecode({ ok: true, file: jpeg, recompressed: true }));
  expect(image(screen).getAttribute("src")).toBe("blob:second");
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(fetchImage.mock.calls[0]?.[1].signal.aborted).toBe(true);
});
