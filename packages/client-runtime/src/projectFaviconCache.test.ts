import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import {
  createProjectFaviconCache,
  createProjectFaviconImageLoader,
  PROJECT_FAVICON_CACHE_MAX_BYTES,
  PROJECT_FAVICON_CACHE_MAX_ENTRIES,
  PROJECT_FAVICON_MAX_DATA_URL_LENGTH,
  PROJECT_FAVICON_MAX_SOURCE_BYTES,
  type ProjectFaviconEntry,
  type ProjectFaviconStorage,
} from "./projectFaviconCache.ts";

const target = { environmentId: EnvironmentId.make("remote"), cwd: "/workspace" };
const url = "https://remote.test/api/assets/token-a/vabc-icon.svg";
const image = "data:image/png;base64,aWNvbg==";
const replacement = "data:image/png;base64,bmV3";
const signal = () => new AbortController().signal;

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const records = new Map<string, ProjectFaviconEntry>();
  const load = vi.fn(async () => image);
  const storage: ProjectFaviconStorage = {
    list: async () => [...records.values()],
    put: async (key, entry) => {
      records.set(key, entry);
    },
    remove: async (key) => {
      records.delete(key);
    },
  };
  return {
    storage,
    load,
    records,
    cache: createProjectFaviconCache({ storage, load }),
  };
}

describe("persistent project favicon cache", () => {
  it("restores image bytes in a fresh client before any remote response", async () => {
    const { cache, storage, load } = fixture();
    expect(await cache.resolve(target, url, signal())).toBe(image);
    await cache.flush();
    const reloaded = createProjectFaviconCache({ storage, load });
    await reloaded.hydrate();
    expect(reloaded.peek(target)).toBe(image);
    expect(await reloaded.resolve(target, null, signal())).toBe(image);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reuses the image when signed URLs or connection origins change", async () => {
    const { cache, load } = fixture();
    await cache.resolve(target, url, signal());
    expect(
      await cache.resolve(target, "https://new.test/api/assets/token-b/vabc-icon.svg", signal()),
    ).toBe(image);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps the old image during refresh and failures, then persists its replacement", async () => {
    const { cache, load, storage } = fixture();
    await cache.resolve(target, url, signal());
    const next = deferred<string>();
    load.mockImplementationOnce(() => next.promise);
    const refreshing = cache.resolve(target, url.replace("vabc", "vdef"), signal());
    expect(cache.peek(target)).toBe(image);
    next.resolve(replacement);
    expect(await refreshing).toBe(replacement);
    load.mockRejectedValueOnce(new Error("offline"));
    expect(await cache.resolve(target, url, signal())).toBe(replacement);
    await cache.flush();
    expect(await createProjectFaviconCache({ storage, load }).resolve(target, null, signal())).toBe(
      replacement,
    );
  });

  it("persists confirmed removal and ignores an aborted older download", async () => {
    const { cache, load, storage } = fixture();
    await cache.resolve(target, url, signal());
    const next = deferred<string>();
    const started = deferred<void>();
    load.mockImplementationOnce(() => {
      started.resolve();
      return next.promise;
    });
    const controller = new AbortController();
    const pending = cache.resolve(target, url.replace("vabc", "vdef"), controller.signal);
    await started.promise;
    controller.abort();
    expect(
      await cache.resolve(
        target,
        "https://remote.test/api/assets/token/project-favicon-missing",
        signal(),
      ),
    ).toBeNull();
    next.resolve(replacement);
    await pending;
    await cache.flush();
    expect(
      await createProjectFaviconCache({ storage, load }).resolve(target, null, signal()),
    ).toBeNull();
  });

  it("isolates environments, workspaces, and icon selections", async () => {
    const { cache } = fixture();
    await cache.resolve(target, url, signal());
    expect(cache.peek({ ...target, faviconPath: null })).toBe(image);
    expect(cache.peek({ ...target, faviconPath: "brand.svg" })).toBeNull();
    expect(cache.peek({ ...target, cwd: "/other" })).toBeNull();
    expect(cache.peek({ ...target, environmentId: EnvironmentId.make("other") })).toBeNull();
  });

  it.each([
    {
      scope: "one environment",
      clear: (cache: ReturnType<typeof fixture>["cache"]) =>
        cache.clearEnvironment(target.environmentId),
      remaining: 1,
    },
    {
      scope: "every environment",
      clear: (cache: ReturnType<typeof fixture>["cache"]) => cache.clearAll(),
      remaining: 0,
    },
  ])(
    "does not restore images for $scope removed during a download",
    async ({ clear, remaining }) => {
      const { cache, load, records } = fixture();
      const other = { ...target, environmentId: EnvironmentId.make("other") };
      await cache.resolve(other, url, signal());
      const next = deferred<string>();
      const started = deferred<void>();
      load.mockImplementationOnce(() => {
        started.resolve();
        return next.promise;
      });
      const pending = cache.resolve(target, url, signal());
      await started.promise;
      await clear(cache);
      next.resolve(image);
      await pending;
      await cache.flush();
      expect(cache.peek(target)).toBeNull();
      expect(records.size).toBe(remaining);
    },
  );

  it("discards a download that starts while the environment is being cleared", async () => {
    const records = new Map<string, ProjectFaviconEntry>();
    const removal = deferred<void>();
    const load = vi.fn(async () => image);
    const storage: ProjectFaviconStorage = {
      list: async () => [...records.values()],
      put: async (key, entry) => {
        records.set(key, entry);
      },
      remove: async (key) => {
        await removal.promise;
        records.delete(key);
      },
    };
    const cache = createProjectFaviconCache({ storage, load });
    await cache.resolve(target, url, signal());
    await cache.flush();
    const clearing = cache.clearEnvironment(target.environmentId);
    await Promise.resolve();
    const late = cache.resolve(target, url.replace("vabc", "vdef"), signal());
    removal.resolve();
    await clearing;
    expect(records.size).toBe(0);
    expect(cache.peek(target)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(await late).toBe(image);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("bounds individual images, total bytes, and entry count in storage", async () => {
    const { cache, load, records } = fixture();
    load.mockResolvedValueOnce(
      `data:image/png;base64,${"a".repeat(PROJECT_FAVICON_MAX_DATA_URL_LENGTH)}`,
    );
    expect(await cache.resolve(target, url, signal())).toBe(url);
    expect(cache.peek(target)).toBeNull();
    const large = `data:image/png;base64,${"a".repeat(PROJECT_FAVICON_MAX_DATA_URL_LENGTH - 32)}`;
    load.mockResolvedValue(large);
    for (let i = 0; i < 40; i++) {
      await cache.resolve({ ...target, cwd: `/large-${i}` }, url, signal());
    }
    await cache.flush();
    expect(
      [...records.values()].reduce((total, entry) => total + entry.dataUrl.length, 0),
    ).toBeLessThanOrEqual(PROJECT_FAVICON_CACHE_MAX_BYTES);
    expect(cache.peek({ ...target, cwd: "/large-0" })).toBeNull();
    expect(cache.peek({ ...target, cwd: "/large-39" })).toBe(large);
    load.mockResolvedValue(image);
    for (let i = 0; i <= PROJECT_FAVICON_CACHE_MAX_ENTRIES; i++) {
      await cache.resolve({ ...target, cwd: `/small-${i}` }, url, signal());
    }
    await cache.flush();
    expect(records.size).toBe(PROJECT_FAVICON_CACHE_MAX_ENTRIES);
    expect(cache.peek({ ...target, cwd: "/small-0" })).toBeNull();
  });

  it("skips corrupt records and tolerates unavailable storage", async () => {
    const corrupt = createProjectFaviconCache({
      storage: {
        list: async () => [
          { ...target, faviconPath: null, revision: "r", dataUrl: image },
          { ...target, cwd: "/broken", faviconPath: null, revision: "r", dataUrl: "not-an-image" },
          "garbage",
        ],
        put: async () => {},
        remove: async () => {},
      },
      load: async () => replacement,
    });
    await corrupt.hydrate();
    expect(corrupt.peek(target)).toBe(image);
    expect(corrupt.peek({ ...target, cwd: "/broken" })).toBeNull();

    const unavailable = createProjectFaviconCache({
      storage: {
        list: async () => {
          throw new Error("storage unavailable");
        },
        put: async () => {
          throw new Error("quota exceeded");
        },
        remove: async () => {
          throw new Error("quota exceeded");
        },
      },
      load: async () => image,
    });
    expect(await unavailable.resolve(target, url, signal())).toBe(image);
    await unavailable.flush();
    expect(unavailable.peek(target)).toBe(image);
  });
});

describe("project favicon image loader", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>';
  const svgBase64 = btoa(svg);

  function loader(response: Response, downscale = vi.fn(async () => replacement)) {
    return {
      downscale,
      load: createProjectFaviconImageLoader({ fetch: async () => response, downscale }),
    };
  }

  it("inlines small icons exactly as served without rasterizing", async () => {
    const { load, downscale } = loader(
      new Response(svg, { headers: { "content-type": "image/svg+xml; charset=utf-8" } }),
    );
    expect(await load(url, signal())).toBe(`data:image/svg+xml;base64,${svgBase64}`);
    expect(downscale).not.toHaveBeenCalled();
  });

  it("falls back to the file extension when the response has no image type", async () => {
    const { load } = loader(new Response(svg, { headers: { "content-type": "text/plain" } }));
    expect(await load(url, signal())).toBe(`data:image/svg+xml;base64,${svgBase64}`);
  });

  it("downscales large bitmaps and refuses large vector icons", async () => {
    const bytes = new Uint8Array(PROJECT_FAVICON_MAX_DATA_URL_LENGTH);
    const bitmap = loader(new Response(bytes, { headers: { "content-type": "image/png" } }));
    expect(await bitmap.load("https://remote.test/api/assets/t/v1-icon.png", signal())).toBe(
      replacement,
    );
    expect(bitmap.downscale).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "image/png", bytes }),
      expect.any(AbortSignal),
    );
    const vector = loader(new Response(bytes, { headers: { "content-type": "image/svg+xml" } }));
    await expect(vector.load(url, signal())).rejects.toThrow("exceeds the cache limit");
    expect(vector.downscale).not.toHaveBeenCalled();
  });

  it("stops reading a response that exceeds the source limit", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const { load, downscale } = loader(
      new Response(stream, { headers: { "content-type": "image/png" } }),
    );
    await expect(load(url, signal())).rejects.toThrow("too large");
    expect(pulled).toBeLessThan(PROJECT_FAVICON_MAX_SOURCE_BYTES / chunk.byteLength + 3);
    expect(downscale).not.toHaveBeenCalled();
    const declared = loader(
      new Response("x", {
        headers: { "content-type": "image/png", "content-length": String(2 ** 40) },
      }),
    );
    await expect(declared.load(url, signal())).rejects.toThrow("too large");
  });

  it("rejects failed responses and non-image payloads", async () => {
    const failed = loader(new Response("nope", { status: 404 }));
    await expect(failed.load(url, signal())).rejects.toThrow("404");
    const html = loader(new Response("<html/>", { headers: { "content-type": "text/html" } }));
    await expect(
      html.load("https://remote.test/api/assets/t/v1-favicon", signal()),
    ).rejects.toThrow("no image type");
  });
});
