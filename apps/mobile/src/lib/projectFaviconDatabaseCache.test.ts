import {
  createProjectFaviconImageLoader,
  PROJECT_FAVICON_MAX_DATA_URL_LENGTH,
} from "@t3tools/client-runtime/project-favicon-cache";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  platform: { OS: "ios" },
  uuid: vi.fn(() => "ab74bbb8-c8aa-4b3a-a2d1-91cfb7688a85"),
  load: vi.fn(
    async (
      _source: string | { uri?: string },
      options: { maxWidth: number; maxHeight: number },
    ) => ({
      width: options.maxWidth,
      height: options.maxHeight,
      release: vi.fn(),
    }),
  ),
  write: vi.fn(async () => {}),
  path: vi.fn(async () => "/cache/thumbnail"),
  read: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: native.platform }));
vi.mock("expo-image", () => ({
  Image: {
    loadAsync: native.load,
    writeToCacheAsync: native.write,
    getCachePathAsync: native.path,
  },
}));
vi.mock("expo-crypto", () => ({
  randomUUID: native.uuid,
  CryptoDigestAlgorithm: { SHA256: "sha256" },
  digest: async (algorithm: string, bytes: Uint8Array) =>
    Uint8Array.from(NodeCrypto.createHash(algorithm).update(bytes).digest()).buffer,
}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  File: class {
    uri: string;
    constructor(...parts: string[]) {
      this.uri = parts.join("/");
    }
    size = 24_000;
    create() {}
    async write() {}
    base64 = native.read;
    delete = native.remove;
  },
}));

import { File } from "expo-file-system";

import { downscaleProjectFavicon } from "./projectFaviconDatabaseCache";

const png = "iVBORw0KGgoAAAAA";
const image = { url: "https://remote/icon.png", bytes: Uint8Array.from([137, 80, 78, 71]) };

beforeEach(() => {
  vi.clearAllMocks();
  native.platform.OS = "ios";
  native.read.mockReset().mockResolvedValue(png);
  native.load.mockReset().mockImplementation(async (_url, { maxWidth }) => ({
    width: maxWidth,
    height: maxWidth,
    release: vi.fn(),
  }));
});

describe("mobile project icon thumbnails", () => {
  it("downloads the project icon bytes once on a cold cache", async () => {
    const bytes = await NodeFSP.readFile(
      new URL("../../assets/android-splash-icon-prod.png", import.meta.url),
    );
    let transferredBytes = 0;
    const download = () => {
      transferredBytes += bytes.length;
      return Promise.resolve(
        new Response(new Uint8Array(bytes), {
          headers: { "content-type": "image/png" },
        }),
      );
    };
    const decode = native.load.getMockImplementation()!;
    native.load.mockImplementation(async (source, options) => {
      // The native decoder downloads its input when given an uncached remote URL.
      const uri = typeof source === "string" ? source : source.uri;
      if (uri?.startsWith("https:")) await (await download()).arrayBuffer();
      return decode(source, options);
    });
    const load = createProjectFaviconImageLoader({
      fetch: download,
      downscale: downscaleProjectFavicon,
    });

    expect(await load(image.url, new AbortController().signal)).toBe(
      `data:image/png;base64,${png}`,
    );
    expect(
      transferredBytes,
      "Cold icon load should transfer only one copy of the source bitmap",
    ).toBe(bytes.length);
  });

  it("reuses the downloaded bytes for a smaller thumbnail and deletes the temporary files", async () => {
    using writeSource = vi.spyOn(File.prototype, "write");
    native.read.mockResolvedValueOnce(
      `iVBORw0KGgo${"a".repeat(PROJECT_FAVICON_MAX_DATA_URL_LENGTH)}`,
    );
    const thumbnail = await downscaleProjectFavicon(image, new AbortController().signal);
    expect(thumbnail).toBe(`data:image/png;base64,${png}`);
    expect(writeSource).toHaveBeenCalledExactlyOnceWith(image.bytes);
    expect(new Set(native.load.mock.calls.map(([source]) => source)).size).toBe(1);
    expect(native.load.mock.calls.map(([, options]) => options.maxWidth)).toEqual([96, 48]);
    expect(native.remove).toHaveBeenCalledTimes(3);
    for (const call of native.load.mock.results)
      expect((await call.value).release).toHaveBeenCalledOnce();
  });

  it("gives the native cache the same key for the same bytes across thumbnail requests", async () => {
    native.uuid.mockReturnValueOnce("f2ba85a6-b79f-4acb-8ba5-df7322ba2f16");
    const signal = new AbortController().signal;
    await downscaleProjectFavicon(image, signal);
    await downscaleProjectFavicon(image, signal);
    await downscaleProjectFavicon({ ...image, bytes: Uint8Array.from([137, 80, 78, 72]) }, signal);

    const [first, repeated, changed] = native.load.mock.calls.map(([source]) => source);
    expect(first).toMatchObject({ uri: expect.any(String), cacheKey: expect.any(String) });
    if (typeof first !== "object" || !("cacheKey" in first)) {
      throw new Error("Expected an image source with a cache key");
    }
    expect(repeated).toMatchObject({ cacheKey: first.cacheKey });
    expect(repeated).not.toMatchObject({ uri: first.uri });
    expect(changed).toMatchObject({ cacheKey: expect.any(String) });
    expect(changed).not.toMatchObject({ cacheKey: first.cacheKey });
  });

  it("reuses the Android decode URI and keeps the source staged while a decode is pending", async () => {
    native.platform.OS = "android";
    using writeSource = vi.spyOn(File.prototype, "write");
    const started = Promise.withResolvers<string | undefined>();
    const finish = Promise.withResolvers<void>();
    const decode = native.load.getMockImplementation()!;
    native.load.mockImplementationOnce(async (source, options) => {
      started.resolve(typeof source === "string" ? source : source.uri);
      await finish.promise;
      return decode(source, options);
    });
    native.uuid
      .mockReturnValueOnce("c276136f-2c37-4abf-82a1-90af524a2352")
      .mockReturnValueOnce("6921e15a-429d-45dc-81f9-c98bfd295433");
    const signal = new AbortController().signal;
    const pending = downscaleProjectFavicon(image, signal);
    const uri = await started.promise;
    try {
      await downscaleProjectFavicon(image, signal);
      expect(native.load.mock.calls[1]?.[0]).toMatchObject({ uri });
      expect(writeSource).toHaveBeenCalledOnce();
      expect(native.remove.mock.contexts).not.toContainEqual(expect.objectContaining({ uri }));
    } finally {
      finish.resolve();
      await pending;
    }
    expect(native.remove.mock.contexts).toContainEqual(expect.objectContaining({ uri }));

    await downscaleProjectFavicon(image, signal);
    await downscaleProjectFavicon({ ...image, bytes: Uint8Array.from([137, 80, 78, 72]) }, signal);
    expect(native.load.mock.calls[2]?.[0]).toMatchObject({ uri });
    expect(native.load.mock.calls[3]?.[0]).not.toMatchObject({ uri });
  });

  it("releases a decoded image when its request was canceled", async () => {
    const controller = new AbortController();
    const release = vi.fn();
    native.load.mockImplementationOnce(async () => {
      controller.abort();
      return { width: 96, height: 96, release };
    });
    await expect(downscaleProjectFavicon(image, controller.signal)).rejects.toThrow();
    expect(release).toHaveBeenCalledOnce();
    expect(native.remove).toHaveBeenCalledOnce();
    expect(native.write).not.toHaveBeenCalled();
  });

  it("deletes the temporary source when writing it fails", async () => {
    using writeSource = vi.spyOn(File.prototype, "write");
    const failure = new Error("Could not write icon");
    writeSource.mockRejectedValueOnce(failure);
    await expect(downscaleProjectFavicon(image, new AbortController().signal)).rejects.toBe(
      failure,
    );
    expect(native.remove).toHaveBeenCalledOnce();
  });

  it("rejects an image the native decoder did not downsize", async () => {
    const release = vi.fn();
    native.load.mockResolvedValueOnce({ width: 4000, height: 3000, release });
    await expect(downscaleProjectFavicon(image, new AbortController().signal)).rejects.toThrow(
      "not resized",
    );
    expect(native.write).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
