import { act, type SyntheticEvent } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AttachmentImage } from "./AttachmentImage";
import { prepareImageForAttachment } from "../../lib/imageCompression";

vi.mock("../../lib/imageCompression", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/imageCompression")>()),
  prepareImageForAttachment: vi.fn(),
}));

let renderer: ReactTestRenderer;
const fetchImage = vi.fn();
const revokeUrl = vi.fn();
const decodeError = {} as SyntheticEvent<HTMLImageElement>;
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
  await act(() => renderer?.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([
  { name: "photo.HEIC", mimeType: undefined },
  { name: "photo", mimeType: "image/heif" },
])(
  "converts $name after native decoding fails and releases its preview",
  async ({ name, mimeType }) => {
    await act(() => {
      renderer = create(
        <AttachmentImage src="https://environment.test/photo" name={name} mimeType={mimeType} />,
      );
    });
    expect(fetchImage).not.toHaveBeenCalled();
    await act(() => renderer.root.findByType("img").props.onError(decodeError));
    expect(renderer.root.findByType("img").props.src).toBe("blob:jpeg");
    expect(prepareImageForAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ name, type: "image/heic" }),
      50 * 1024 * 1024,
    );
    await act(() => renderer.unmount());
    expect(revokeUrl).toHaveBeenCalledWith("blob:jpeg");
  },
);

it("leaves PNG errors to the caller without fetching or converting", async () => {
  const onError = vi.fn();
  await act(() => {
    renderer = create(<AttachmentImage src="blob:png" name="photo.png" onError={onError} />);
  });
  await act(() => renderer.root.findByType("img").props.onError(decodeError));
  expect(onError).toHaveBeenCalledWith(decodeError);
  expect(fetchImage).not.toHaveBeenCalled();
});

it("reports failed HEIC conversion through the existing error handler", async () => {
  const onError = vi.fn();
  vi.mocked(prepareImageForAttachment).mockResolvedValue({ ok: false, reason: "unreadable" });
  await act(() => {
    renderer = create(<AttachmentImage src="blob:heic" name="photo.heif" onError={onError} />);
  });
  await act(() => renderer.root.findByType("img").props.onError(decodeError));
  expect(onError).toHaveBeenCalledWith(decodeError);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("discards an old decode when navigating to a different source", async () => {
  let finishDecode!: (result: Awaited<ReturnType<typeof prepareImageForAttachment>>) => void;
  vi.mocked(prepareImageForAttachment).mockReturnValue(
    new Promise((resolve) => {
      finishDecode = resolve;
    }),
  );
  await act(() => {
    renderer = create(<AttachmentImage src="blob:first" name="photo.heic" />);
  });
  await act(() => renderer.root.findByType("img").props.onError(decodeError));
  await act(() => renderer.update(<AttachmentImage src="blob:second" name="photo.heic" />));
  await act(() => finishDecode({ ok: true, file: jpeg, recompressed: true }));
  expect(renderer.root.findByType("img").props.src).toBe("blob:second");
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(fetchImage.mock.calls[0]?.[1].signal.aborted).toBe(true);
});
