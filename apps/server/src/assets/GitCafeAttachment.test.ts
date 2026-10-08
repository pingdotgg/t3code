import { describe, expect, it } from "@effect/vitest";
import { AssetResource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitCafeCredentials from "../sourceControl/GitCafeCredentials.ts";
import { downloadGitCafeAttachment, sniffRasterImageMimeType } from "./GitCafeAttachment.ts";

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]);
const resource = { _tag: "gitcafe-attachment", host: "git.cafe", attachmentId: "attach_123abc" };

describe("GitCafe attachment download", () => {
  it.effect.each([
    ["binary bytes across chunks", [png.slice(0, 4), png.slice(4)], 200, png],
    ["failed authentication", [png], 401, null],
    ["over limit", [new Uint8Array(10 * 1024 * 1024), png], 200, null],
  ] as const)("downloads %s", ([, chunks, status, expected]) => {
    const invalidated: Array<string> = [];
    return Effect.gen(function* () {
      expect(yield* downloadGitCafeAttachment("staging.git.cafe", "attach_123abc")).toEqual(
        expected,
      );
      // A refused token is dropped so the next read asks its source again.
      expect(invalidated).toEqual(status === 401 ? ["staging.git.cafe"] : []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(GitCafeCredentials.GitCafeCredentials)({
            get: (host) => Effect.succeed({ host, token: Redacted.make("token"), source: "env" }),
            invalidate: (host) => Effect.sync(() => void invalidated.push(host)),
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              expect(request.url).toBe("https://staging.git.cafe/api/attachments/attach_123abc");
              expect(request.headers.authorization).toBe("Bearer token");
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(Stream.toReadableStream(Stream.fromIterable(chunks)), { status }),
                ),
              );
            }),
          ),
        ),
      ),
    );
  });

  it("only accepts fixed GitCafe hosts and attachment ids", () => {
    const valid = Schema.is(AssetResource);
    expect(valid(resource)).toBe(true);
    expect(valid({ ...resource, host: "evil.example" })).toBe(false);
    expect(valid({ ...resource, attachmentId: "attach_123/../../auth" })).toBe(false);
    expect(valid({ ...resource, attachmentId: "attach_123?url=evil" })).toBe(false);
  });
  it("sniffs raster signatures rather than trusting file extensions or CLI error output", () => {
    expect(sniffRasterImageMimeType(png)).toBe("image/png");
    expect(sniffRasterImageMimeType(Uint8Array.from([255, 216, 255, 224]))).toBe("image/jpeg");
    expect(sniffRasterImageMimeType(new TextEncoder().encode("GIF89a123"))).toBe("image/gif");
    expect(sniffRasterImageMimeType(new TextEncoder().encode("RIFF1234WEBP"))).toBe("image/webp");
    for (const data of ["<svg></svg>", "<html>error</html>", '{"error":"auth"}', "GIF"])
      expect(sniffRasterImageMimeType(new TextEncoder().encode(data))).toBeNull();
  });
});
