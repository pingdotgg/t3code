import { describe, expect, it, vi } from "vite-plus/test";

import { downloadRest } from "./fullFileText";

const encoder = new TextEncoder();

function download(preview: string, sizeBytes: number) {
  return downloadRest({
    src: "/assets/file.ts",
    preview,
    sizeBytes,
    signal: new AbortController().signal,
    onProgress: () => {},
  });
}

/** Serves `bytes=N-` ranges of `file`, as the asset route does. */
function serve(file: Uint8Array) {
  return (_input: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("range");
    if (range === null) return Promise.resolve(new Response(file.slice(), { status: 200 }));
    const start = Number(/bytes=(\d+)-/.exec(range)![1]);
    return Promise.resolve(
      new Response(file.slice(start), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${file.byteLength - 1}/${file.byteLength}` },
      }),
    );
  };
}

describe("downloadRest", () => {
  it("resumes after the preview's UTF-8 bytes and appends the rest", async () => {
    const preview = "const café = 1;\n";
    const whole = encoder.encode(`${preview}const naïve = 2;\n`);
    using fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(serve(whole));
    expect(await download(preview, whole.byteLength)).toBe(`${preview}const naïve = 2;\n`);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("skips a byte order mark the preview read dropped", async () => {
    const preview = "line one\n";
    const whole = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(`${preview}line two\n`)]);
    using fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(serve(whole));
    expect(await download(preview, whole.byteLength)).toBe(`${preview}line two\n`);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("downloads the whole file again when it changed since the preview was read", async () => {
    // Same size, different content: only the overlap with the preview tells them apart.
    const whole = encoder.encode("BBBB\nBBBB\n");
    using fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(serve(whole));
    expect(await download("AAAA\n", whole.byteLength)).toBe("BBBB\nBBBB\n");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchSpy.mock.calls[1]![1]!.headers).get("range")).toBeNull();
  });

  it("downloads the whole file again when its size changed", async () => {
    const whole = encoder.encode("old\nand more\n");
    using fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(serve(whole));
    expect(await download("old\n", whole.byteLength + 5)).toBe("old\nand more\n");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
