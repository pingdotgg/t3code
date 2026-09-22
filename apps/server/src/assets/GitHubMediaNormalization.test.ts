import { isGitHubUserAttachmentFetchUrl } from "@t3tools/shared/githubMedia";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerResponse,
} from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { githubMediaResponse } from "./GitHubMediaFetch.ts";
import {
  MAX_NORMALIZED_PNG_BYTES,
  PNG_CICP_PEEK_BYTES,
  readBoundedBody,
  stripConflictingBt709Cicp,
} from "./GitHubMediaNormalization.ts";

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const EMPTY_IHDR = Array.from({ length: 13 }, () => 0);
const SRGB_GAMMA = [0, 0, 177, 143];
const SRGB_CHRM = [
  0, 0, 122, 38, 0, 0, 128, 132, 0, 0, 250, 0, 0, 0, 128, 232, 0, 0, 117, 48, 0, 0, 234, 96, 0, 0,
  58, 152, 0, 0, 23, 112,
];
const ATTACHMENT_URL =
  "https://github.com/user-attachments/assets/f1d65268-4213-47a5-864d-5067e8bf5918";
const REDIRECTED_URL =
  "https://github-production-user-asset-6210df.s3.amazonaws.com/asset?signature=redacted";

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
      : [pngChunk("cHRM", SRGB_CHRM), pngChunk("gAMA", SRGB_GAMMA)];
  return concatBytes([
    PNG_SIGNATURE,
    pngChunk("IHDR", EMPTY_IHDR),
    pngChunk("cICP", cicp),
    ...colorFallback,
    pngChunk("IDAT", [4, 5, 6]),
    pngChunk("IEND", []),
  ]);
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

describe("isGitHubUserAttachmentFetchUrl", () => {
  it("matches attachment fetches with or without a query string", () => {
    expect(isGitHubUserAttachmentFetchUrl(ATTACHMENT_URL)).toBe(true);
    expect(isGitHubUserAttachmentFetchUrl(`${ATTACHMENT_URL}?x=1`)).toBe(true);
    expect(isGitHubUserAttachmentFetchUrl("https://github.com/owner/repo/assets/123/abc-def")).toBe(
      true,
    );
    expect(
      isGitHubUserAttachmentFetchUrl("https://raw.githubusercontent.com/owner/repo/main/a.png"),
    ).toBe(false);
    expect(isGitHubUserAttachmentFetchUrl("https://github.com/owner/repo/blob/main/a.png")).toBe(
      false,
    );
    expect(
      isGitHubUserAttachmentFetchUrl("https://github.com.evil.test/user-attachments/assets/abc"),
    ).toBe(false);
  });
});

describe("stripConflictingBt709Cicp", () => {
  it("drops only the conflicting cICP chunk without changing image data", () => {
    const source = pngWithCicp([1, 1, 0, 1]);
    const normalized = stripConflictingBt709Cicp(source);

    expect(chunkTypes(normalized)).toEqual(["IHDR", "cHRM", "gAMA", "IDAT", "IEND"]);
    expect(normalized).toEqual(
      concatBytes([
        PNG_SIGNATURE,
        pngChunk("IHDR", EMPTY_IHDR),
        pngChunk("cHRM", SRGB_CHRM),
        pngChunk("gAMA", SRGB_GAMMA),
        pngChunk("IDAT", [4, 5, 6]),
        pngChunk("IEND", []),
      ]),
    );
  });

  it("leaves valid BT.709 and other color profiles untouched", () => {
    const bt709 = pngWithCicp([1, 1, 0, 1], { includeSrgbFallback: false });
    const displayP3 = pngWithCicp([12, 13, 0, 1]);

    expect(stripConflictingBt709Cicp(bt709)).toEqual(bt709);
    expect(stripConflictingBt709Cicp(displayP3)).toEqual(displayP3);
  });

  it("leaves truncated and duplicate-profile PNGs untouched", () => {
    const source = pngWithCicp([1, 1, 0, 1]);
    const duplicate = concatBytes([source, pngChunk("cICP", [1, 1, 0, 1])]);

    expect(stripConflictingBt709Cicp(source.subarray(0, source.length - 1))).toEqual(
      source.subarray(0, source.length - 1),
    );
    expect(stripConflictingBt709Cicp(duplicate)).toEqual(duplicate);
  });
});

const gitHubCliLayer = Layer.mock(GitHubCli.GitHubCli)({
  execute: () =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: "test-token",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
});

function httpClientLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) {
  return Layer.merge(
    Layer.succeed(HttpClient.HttpClient, HttpClient.make(handler)),
    gitHubCliLayer,
  );
}

function header(response: HttpServerResponse.HttpServerResponse, name: string): string | undefined {
  return Option.getOrUndefined(Headers.get(name)(response.headers));
}

function readResponseBody(response: HttpServerResponse.HttpServerResponse) {
  if (response.body._tag === "Uint8Array") return Effect.succeed(response.body.body);
  if (response.body._tag === "Stream") {
    return response.body.stream.pipe(
      Stream.runCollect,
      Effect.map((chunks) => concatBytes(Array.from(chunks))),
      Effect.catchCause((cause) => Effect.die(cause)),
    );
  }
  return Effect.die(new Error(`unexpected response body ${response.body._tag}`));
}

const mediaAsset = (url: string) => ({ url, cwd: "/repo", expiresAt: Number.MAX_SAFE_INTEGER });

describe("githubMediaResponse PNG normalization", () => {
  it.effect("normalizes conflicting PNG bytes through the authenticated flow", () =>
    Effect.gen(function* () {
      const source = pngWithCicp([1, 1, 0, 1]);
      const authorizations: Array<string | undefined> = [];
      const seenUrls: Array<string> = [];
      const response = yield* githubMediaResponse(mediaAsset(ATTACHMENT_URL), {}).pipe(
        Effect.provide(
          httpClientLayer((request) => {
            authorizations.push(request.headers.authorization);
            seenUrls.push(request.url);
            if (request.url === ATTACHMENT_URL) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(null, { status: 302, headers: { location: REDIRECTED_URL } }),
                ),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(source, {
                  status: 200,
                  headers: {
                    "content-length": String(source.length),
                    "content-type": "image/png",
                    "accept-ranges": "bytes",
                    etag: '"upstream"',
                  },
                }),
              ),
            );
          }),
        ),
        Effect.scoped,
      );

      // The credential rides only to GitHub; the signed redirect goes without it.
      expect(authorizations).toEqual(["Bearer test-token", undefined]);
      expect(seenUrls).toEqual([ATTACHMENT_URL, REDIRECTED_URL]);
      expect(response.status).toBe(200);
      expect(header(response, "content-type")).toBe("image/png");
      expect(header(response, "cache-control")).toMatch(/^private, max-age=\d+$/);
      // A validator for the upstream bytes must not describe the normalized ones, and
      // ranges must not be advertised for offsets that only exist unmodified upstream.
      expect(header(response, "etag")).toBeUndefined();
      expect(header(response, "accept-ranges")).toBeUndefined();
      expect(chunkTypes(yield* readResponseBody(response))).toEqual([
        "IHDR",
        "cHRM",
        "gAMA",
        "IDAT",
        "IEND",
      ]);
    }),
  );

  it.effect("streams non-attachment PNGs without buffering", () =>
    Effect.gen(function* () {
      const source = pngWithCicp([1, 1, 0, 1]);
      const response = yield* githubMediaResponse(
        mediaAsset("https://raw.githubusercontent.com/owner/repo/main/shot.png"),
        {},
      ).pipe(
        Effect.provide(
          httpClientLayer((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(source, {
                  status: 200,
                  headers: { "content-length": String(source.length), "content-type": "image/png" },
                }),
              ),
            ),
          ),
        ),
        Effect.scoped,
      );

      expect(response.body._tag).toBe("Stream");
      expect(yield* readResponseBody(response)).toEqual(source);
    }),
  );

  it.effect("streams attachment PNGs without a cICP chunk instead of buffering them", () =>
    Effect.gen(function* () {
      // The chunk headers up to IDAT decide; the image data past them is never pulled whole.
      const idat = new Uint8Array(PNG_CICP_PEEK_BYTES * 4).fill(7);
      const source = concatBytes([
        PNG_SIGNATURE,
        pngChunk("IHDR", EMPTY_IHDR),
        pngChunk("cHRM", SRGB_CHRM),
        pngChunk("gAMA", SRGB_GAMMA),
        pngChunk("IDAT", Array.from(idat)),
        pngChunk("IEND", []),
      ]);
      let pulled = 0;
      const upstream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < source.length; offset += 1024) {
            controller.enqueue(source.subarray(offset, offset + 1024));
          }
          controller.close();
        },
      }).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            pulled += chunk.length;
            controller.enqueue(chunk);
          },
        }),
      );
      // The peeked remainder lives in the route scope, which outlives the response being sent.
      const { response, body } = yield* Effect.gen(function* () {
        const response = yield* githubMediaResponse(mediaAsset(ATTACHMENT_URL), {});
        expect(response.body._tag).toBe("Stream");
        expect(pulled).toBeLessThan(PNG_CICP_PEEK_BYTES);
        return { response, body: yield* readResponseBody(response) };
      }).pipe(
        Effect.provide(
          httpClientLayer((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(upstream, {
                  status: 200,
                  headers: {
                    "content-length": String(source.length),
                    "content-type": "image/png",
                    "accept-ranges": "bytes",
                    etag: '"upstream"',
                  },
                }),
              ),
            ),
          ),
        ),
        Effect.scoped,
      );

      // Streaming keeps the upstream entity headers, since the bytes are the upstream bytes.
      expect(header(response, "etag")).toBe('"upstream"');
      expect(header(response, "accept-ranges")).toBe("bytes");
      expect(body).toEqual(source);
    }),
  );

  it.effect("streams videos and ranged requests without buffering", () =>
    Effect.gen(function* () {
      const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5]);
      const upstreamHeaders: Array<Record<string, string | undefined>> = [];
      const response = yield* githubMediaResponse(mediaAsset(ATTACHMENT_URL), {
        range: "bytes=0-5",
      }).pipe(
        Effect.provide(
          httpClientLayer((request) => {
            upstreamHeaders.push({ range: request.headers.range });
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(bytes, {
                  status: 206,
                  headers: {
                    "content-range": "bytes 0-5/100",
                    "content-length": "6",
                    "content-type": "video/mp4",
                    "accept-ranges": "bytes",
                  },
                }),
              ),
            );
          }),
        ),
        Effect.scoped,
      );

      // A seek costs one upstream range request, not a buffered download.
      expect(upstreamHeaders).toEqual([{ range: "bytes=0-5" }]);
      expect(response.body._tag).toBe("Stream");
      expect(response.status).toBe(206);
      expect(header(response, "content-range")).toBe("bytes 0-5/100");
      expect(yield* readResponseBody(response)).toEqual(bytes);
    }),
  );

  it.effect("passes upstream refusals through with no normalization", () =>
    Effect.gen(function* () {
      const missing =
        "https://github.com/user-attachments/assets/00000000-0000-4000-8000-000000000000";
      const response = yield* githubMediaResponse(mediaAsset(missing), {}).pipe(
        Effect.provide(
          httpClientLayer((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(null, { status: 404, headers: { "content-type": "image/png" } }),
              ),
            ),
          ),
        ),
        Effect.scoped,
      );

      expect(response.status).toBe(404);
    }),
  );

  it.effect("answers 502 past the normalization size bound", () =>
    Effect.gen(function* () {
      const declaredTooLarge = yield* githubMediaResponse(mediaAsset(ATTACHMENT_URL), {}).pipe(
        Effect.provide(
          httpClientLayer((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(null, {
                  status: 200,
                  headers: {
                    "content-length": String(MAX_NORMALIZED_PNG_BYTES + 1),
                    "content-type": "image/png",
                  },
                }),
              ),
            ),
          ),
        ),
        Effect.scoped,
      );
      expect(declaredTooLarge.status).toBe(502);

      const oversized = concatBytes([
        pngWithCicp([1, 1, 0, 1]),
        new Uint8Array(MAX_NORMALIZED_PNG_BYTES),
      ]);
      const streamedTooLarge = yield* githubMediaResponse(mediaAsset(ATTACHMENT_URL), {}).pipe(
        Effect.provide(
          httpClientLayer((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(oversized, {
                  status: 200,
                  headers: { "content-type": "image/png" },
                }),
              ),
            ),
          ),
        ),
        Effect.scoped,
      );
      expect(streamedTooLarge.status).toBe(502);
    }),
  );

  it.effect("times out a stalled normalization body", () =>
    Effect.gen(function* () {
      const request = HttpClientRequest.get(ATTACHMENT_URL);
      const response = HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(PNG_SIGNATURE);
            },
          }),
          { status: 200, headers: { "content-type": "image/png" } },
        ),
      );
      const fiber = yield* readBoundedBody(response).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("30 seconds");
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
