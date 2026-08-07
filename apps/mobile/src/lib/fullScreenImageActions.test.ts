import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  copy: vi.fn(),
  directoryCreate: vi.fn(),
  directoryDelete: vi.fn(),
  downloadFileAsync: vi.fn(),
  write: vi.fn(),
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

class FakeFile {
  readonly uri: string;
  constructor(...segments: ReadonlyArray<{ uri: string } | string>) {
    this.uri = segments
      .map((segment) => (typeof segment === "string" ? segment : segment.uri))
      .join("/");
  }
  create = (options?: unknown) => mocks.create(this.uri, options);
  copy = (destination: FakeFile) => mocks.copy(this.uri, destination.uri);
  write = (content: string, options?: unknown) => mocks.write(this.uri, content, options);
  static downloadFileAsync = (url: string, destination: FakeFile, options?: unknown) =>
    mocks.downloadFileAsync(url, destination, options);
}

class FakeDirectory {
  readonly uri: string;
  constructor(...segments: ReadonlyArray<{ uri: string } | string>) {
    this.uri = segments
      .map((segment) => (typeof segment === "string" ? segment : segment.uri))
      .join("/");
  }
  create = (options?: unknown) => mocks.directoryCreate(this.uri, options);
  delete = () => mocks.directoryDelete(this.uri);
}

vi.mock("expo-file-system", () => ({
  Directory: FakeDirectory,
  File: FakeFile,
  Paths: { cache: { uri: "file:///cache" } },
}));

vi.mock("expo-sharing", () => ({
  isAvailableAsync: mocks.isAvailableAsync,
  shareAsync: mocks.shareAsync,
}));

import {
  SHARE_FAILED_MESSAGE,
  SHARING_UNAVAILABLE_MESSAGE,
  imageUriMetadata,
  shareImage,
} from "./fullScreenImageActions";

/** A signed asset URL of the shape `assets.createUrl` mints. */
const SIGNED_ASSET_URL =
  "https://relay.example.test/api/assets/eyJhIjoxfQ.s3cr3tS1gnatur3/light-ui.png";

describe("imageUriMetadata", () => {
  it("keeps the signed token out of asset URL diagnostics", () => {
    const metadata = imageUriMetadata(SIGNED_ASSET_URL);

    expect(metadata).toEqual({ scheme: "https", host: "relay.example.test" });
    expect(JSON.stringify(metadata)).not.toContain("s3cr3tS1gnatur3");
  });

  it("reduces a data URI to its media type", () => {
    expect(imageUriMetadata("data:image/png;base64,U0VDUkVU")).toEqual({
      scheme: "data",
      host: "image/png",
    });
    expect(imageUriMetadata("data:image/png;charset=utf-8;base64,U0VDUkVU")).toEqual({
      scheme: "data",
      host: "image/png",
    });
  });

  it("handles local files and unparseable input", () => {
    expect(imageUriMetadata("file:///tmp/shot.png").scheme).toBe("file");
    expect(imageUriMetadata("not a url").scheme).toBe("unknown");
  });
});

describe("shareImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAvailableAsync.mockResolvedValue(true);
    mocks.shareAsync.mockResolvedValue(undefined);
    mocks.downloadFileAsync.mockImplementation(async (_url, destination) => destination);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shares a local file directly and never deletes anything", async () => {
    const result = await shareImage({ uri: "file:///tmp/shot.png" });

    expect(result).toEqual({ ok: true });
    expect(mocks.shareAsync).toHaveBeenCalledWith(
      "file:///tmp/shot.png",
      expect.objectContaining({ mimeType: "image/png", UTI: "public.png" }),
    );
    expect(mocks.downloadFileAsync).not.toHaveBeenCalled();
    expect(mocks.directoryDelete).not.toHaveBeenCalled();
  });

  it("copies an Android content:// URI into a real file before sharing", async () => {
    const result = await shareImage({ uri: "content://media/external/images/media/42" });

    expect(result).toEqual({ ok: true });
    expect(mocks.downloadFileAsync).not.toHaveBeenCalled();
    // Android's shareAsync throws on any scheme other than file, so the sheet
    // must never be handed the content URI itself.
    expect(mocks.copy).toHaveBeenCalledTimes(1);
    const sharedUri = mocks.shareAsync.mock.calls[0]?.[0] as string;
    expect(sharedUri).not.toContain("content://");
    expect(mocks.directoryDelete).toHaveBeenCalledTimes(1);
  });

  it("writes a data URI to a temp directory, shares it, then removes the directory", async () => {
    const result = await shareImage({ uri: "data:image/png;base64,QUJD" });

    expect(result).toEqual({ ok: true });
    expect(mocks.write).toHaveBeenCalledWith(
      expect.stringContaining(".png"),
      "QUJD",
      expect.objectContaining({ encoding: "base64" }),
    );
    expect(mocks.directoryDelete).toHaveBeenCalledTimes(1);
  });

  it("handles data URIs carrying extra media-type parameters", async () => {
    const result = await shareImage({ uri: "data:image/png;charset=utf-8;base64,QUJD" });

    expect(result).toEqual({ ok: true });
    expect(mocks.write).toHaveBeenCalledWith(expect.anything(), "QUJD", expect.anything());
  });

  it("downloads a remote image, then removes the temp directory", async () => {
    const result = await shareImage({ uri: "https://example.test/assets/a.png?revision=3" });

    expect(result).toEqual({ ok: true });
    // The cache-buster must not be read as part of the extension.
    expect(mocks.shareAsync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mimeType: "image/png" }),
    );
    expect(mocks.directoryDelete).toHaveBeenCalledTimes(1);
  });

  it("keeps the display name intact while isolating each share in its own directory", async () => {
    await shareImage({ uri: SIGNED_ASSET_URL, fileName: "../../etc/light-ui.png" });
    await shareImage({ uri: SIGNED_ASSET_URL, fileName: "light-ui.png" });

    const [first, second] = mocks.downloadFileAsync.mock.calls.map((call) => call[1].uri);
    expect(first).toContain("light-ui.png");
    expect(second).toContain("light-ui.png");
    expect(first).not.toBe(second);
  });

  it("removes the temp directory when writing the file fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.write.mockImplementation(() => {
      throw new Error("storage exhausted");
    });

    const result = await shareImage({ uri: "data:image/png;base64,QUJD" });

    expect(result).toEqual({ ok: false, message: SHARE_FAILED_MESSAGE });
    expect(mocks.directoryDelete).toHaveBeenCalledTimes(1);
    expect(mocks.shareAsync).not.toHaveBeenCalled();
  });

  it("reports when sharing is unavailable instead of throwing", async () => {
    mocks.isAvailableAsync.mockResolvedValue(false);

    const result = await shareImage({ uri: "file:///tmp/shot.png" });

    expect(result).toEqual({ ok: false, message: SHARING_UNAVAILABLE_MESSAGE });
    expect(mocks.shareAsync).not.toHaveBeenCalled();
  });

  it("logs neither the signed token nor image bytes, and records the failing stage", async () => {
    const logged: Array<{ message: string; stage: string; host?: string }> = [];
    vi.spyOn(console, "error").mockImplementation((value: unknown) => {
      logged.push(value as { message: string; stage: string; host?: string });
    });
    mocks.shareAsync.mockRejectedValue(new Error("sheet failed"));

    await shareImage({ uri: SIGNED_ASSET_URL });
    await shareImage({ uri: "data:image/png;base64,U0VDUkVU" });

    const serialized = logged.map((entry) => entry.message).join("\n");
    expect(serialized).not.toContain("s3cr3tS1gnatur3");
    expect(serialized).not.toContain("U0VDUkVU");
    expect(logged[0]?.host).toBe("relay.example.test");
    expect(logged[0]?.stage).toBe("share");
  });
});
