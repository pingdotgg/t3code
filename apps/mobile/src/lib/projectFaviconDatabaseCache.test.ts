import {
  createProjectFaviconImageLoader,
  PROJECT_FAVICON_MAX_DATA_URL_LENGTH,
} from "@t3tools/client-runtime/project-favicon-cache";
import * as NodeFSP from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
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
vi.mock("expo-image", () => ({
  Image: {
    loadAsync: native.load,
    writeToCacheAsync: native.write,
    getCachePathAsync: native.path,
  },
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

import { downscaleProjectFavicon } from "./projectFaviconDatabaseCache";

const png = "iVBORw0KGgoAAAAA";
const image = { url: "https://remote/icon.png" };

beforeEach(() => {
  vi.clearAllMocks();
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

  it("reduces an oversized encoding and deletes temporary thumbnail files", async () => {
    native.read.mockResolvedValueOnce(
      `iVBORw0KGgo${"a".repeat(PROJECT_FAVICON_MAX_DATA_URL_LENGTH)}`,
    );
    const thumbnail = await downscaleProjectFavicon(image, new AbortController().signal);
    expect(thumbnail).toBe(`data:image/png;base64,${png}`);
    expect(native.load.mock.calls.map(([, options]) => options.maxWidth)).toEqual([96, 48]);
    expect(native.remove).toHaveBeenCalledTimes(2);
    for (const call of native.load.mock.results)
      expect((await call.value).release).toHaveBeenCalledOnce();
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
    expect(native.write).not.toHaveBeenCalled();
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
