import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";
import { vi } from "vite-plus/test";

import { loadGitHubUserAttachment } from "./GitHubUserAttachment.ts";

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const EMPTY_IHDR = Array.from({ length: 13 }, () => 0);
const SRGB_CHRM = [
  0, 0, 122, 38, 0, 0, 128, 132, 0, 0, 250, 0, 0, 0, 128, 232, 0, 0, 117, 48, 0, 0, 234, 96, 0, 0,
  58, 152, 0, 0, 23, 112,
];

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function pngChunk(type: string, data: ReadonlyArray<number>): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  new DataView(chunk.buffer).setUint32(0, data.length, false);
  for (let index = 0; index < type.length; index += 1) {
    chunk[4 + index] = type.charCodeAt(index);
  }
  chunk.set(data, 8);
  return chunk;
}

function pngWithCicp(
  cicp: ReadonlyArray<number>,
  options: { readonly includeSrgbFallback?: boolean } = {},
): Uint8Array {
  const colorFallback =
    options.includeSrgbFallback === false
      ? []
      : [pngChunk("cHRM", SRGB_CHRM), pngChunk("gAMA", [0, 0, 177, 143])];
  return concatBytes([
    PNG_SIGNATURE,
    pngChunk("IHDR", EMPTY_IHDR),
    pngChunk("cICP", cicp),
    ...colorFallback,
    pngChunk("IDAT", [4, 5, 6]),
    pngChunk("IEND", []),
  ]);
}

function loadDirectImage(bytes: Uint8Array) {
  const fetchMock = Object.assign(
    vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: {
            "content-length": String(bytes.length),
            "content-type": "image/png",
          },
        }),
    ),
    { preconnect: vi.fn() },
  );
  return loadGitHubUserAttachment(
    "https://github.com/user-attachments/assets/f1d65268-4213-47a5-864d-5067e8bf5918",
  ).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetchMock),
  );
}

function chunkTypes(bytes: Uint8Array): string[] {
  const types: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    types.push(String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)));
    offset += 12 + length;
  }
  return types;
}

describe("GitHub user attachments", () => {
  it.effect("drops only the conflicting cICP chunk without changing image data", () =>
    Effect.gen(function* () {
      const source = pngWithCicp([1, 1, 0, 1]);
      const { bytes: normalized } = yield* loadDirectImage(source);

      expect(normalized.buffer.byteLength).toBe(source.byteLength);
      expect(chunkTypes(normalized)).toEqual(["IHDR", "cHRM", "gAMA", "IDAT", "IEND"]);
      expect(normalized).toEqual(
        concatBytes([
          PNG_SIGNATURE,
          pngChunk("IHDR", EMPTY_IHDR),
          pngChunk("cHRM", SRGB_CHRM),
          pngChunk("gAMA", [0, 0, 177, 143]),
          pngChunk("IDAT", [4, 5, 6]),
          pngChunk("IEND", []),
        ]),
      );
    }),
  );

  it.effect("leaves valid BT.709 and other color profiles untouched", () =>
    Effect.gen(function* () {
      const bt709 = pngWithCicp([1, 1, 0, 1], { includeSrgbFallback: false });
      const displayP3 = pngWithCicp([12, 13, 0, 1]);

      expect((yield* loadDirectImage(bt709)).bytes).toEqual(bt709);
      expect((yield* loadDirectImage(displayP3)).bytes).toEqual(displayP3);
    }),
  );

  it.effect("follows only GitHub's attachment host and normalizes PNG responses", () =>
    Effect.gen(function* () {
      const sourceUrl =
        "https://github.com/user-attachments/assets/f1d65268-4213-47a5-864d-5067e8bf5918";
      const redirectedUrl =
        "https://github-production-user-asset-6210df.s3.amazonaws.com/asset?signature=redacted";
      const source = pngWithCicp([1, 1, 0, 1]);
      const fetchMock = Object.assign(
        vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
          const url = String(input);
          if (url === sourceUrl) {
            return new Response(null, { status: 302, headers: { location: redirectedUrl } });
          }
          return new Response(source, {
            status: 200,
            headers: {
              "content-length": String(source.length),
              "content-type": "image/png",
            },
          });
        }),
        { preconnect: vi.fn() },
      );

      const result = yield* loadGitHubUserAttachment(sourceUrl).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetchMock),
      );

      expect(chunkTypes(result.bytes)).not.toContain("cICP");
      expect(chunkTypes(result.bytes)).toEqual(["IHDR", "cHRM", "gAMA", "IDAT", "IEND"]);
      expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
        sourceUrl,
        redirectedUrl,
      ]);
      expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === "manual")).toBe(true);
    }),
  );

  it.effect("rejects redirects outside GitHub's attachment bucket", () =>
    Effect.gen(function* () {
      const fetchMock = Object.assign(
        vi.fn(
          async () =>
            new Response(null, {
              status: 302,
              headers: { location: "http://127.0.0.1/private" },
            }),
        ),
        { preconnect: vi.fn() },
      );
      const error = yield* loadGitHubUserAttachment(
        "https://github.com/user-attachments/assets/f1d65268-4213-47a5-864d-5067e8bf5918",
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetchMock),
        Effect.flip,
      );

      expect(error.reason).toBe("redirect");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("preserves transport failures as the error cause", () =>
    Effect.gen(function* () {
      const fetchMock = Object.assign(
        vi.fn(async () => Promise.reject(new Error("offline"))),
        {
          preconnect: vi.fn(),
        },
      );
      const error = yield* loadGitHubUserAttachment(
        "https://github.com/user-attachments/assets/f1d65268-4213-47a5-864d-5067e8bf5918",
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetchMock),
        Effect.flip,
      );

      expect(error.reason).toBe("transport");
      expect(error.cause).toBeDefined();
    }),
  );
});
