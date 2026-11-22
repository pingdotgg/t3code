import { describe, expect, it, vi } from "vite-plus/test";

import { downloadRest } from "./largeSourceDownload";

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

describe("downloadRest", () => {
  it("resumes at the preview's UTF-8 length and appends the rest", async () => {
    const preview = "const café = 1;\n";
    const rest = "const naïve = 2;\n";
    const sizeBytes = encoder.encode(preview + rest).length;
    using fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(rest, {
        status: 206,
        headers: { "content-range": `bytes ${encoder.encode(preview).length}-/${sizeBytes}` },
      }),
    );
    expect(await download(preview, sizeBytes)).toBe(preview + rest);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchSpy.mock.calls[0]![1]!.headers).get("range")).toBe(
      `bytes=${encoder.encode(preview).length}-`,
    );
  });

  it("downloads the whole file again when it changed since the preview was read", async () => {
    const whole = "rewritten\nfile\n";
    using fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("tail", { status: 206, headers: { "content-range": "bytes 4-/99" } }),
      )
      .mockResolvedValueOnce(new Response(whole, { status: 200 }));
    expect(await download("old\n", 20)).toBe(whole);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchSpy.mock.calls[1]![1]!.headers).get("range")).toBeNull();
  });
});
