import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpServerResponse } from "effect/http";
import { FILE_PREVIEW_SCROLL_SCRIPT } from "@t3tools/shared/htmlRender";
import { MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";

import { openMediaFile } from "../assets/MediaFile.ts";
import { assetFileResponse } from "../http.ts";
import { readPinnedFilePage } from "./filePagePolicy.ts";

const layerFileResponse = Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer);
const limit = MCP_APP_MAX_HTML_BYTES + 128 * 1024;

describe("file page policy", () => {
  it.effect("adds the network policy only to file pages", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-file-page-policy-" });
      const page = path.join(directory, "report.html");
      yield* fs.writeFileString(page, "<!doctype html><html><body>☃</body></html>");
      const policy = (asset: Parameters<typeof assetFileResponse>[0]) =>
        assetFileResponse(asset).pipe(
          Effect.map((response) =>
            HttpServerResponse.toWeb(response).headers.get("content-security-policy"),
          ),
        );
      const sandbox = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
      for (const filePage of [
        yield* policy({ path: page, renderIntent: "file-preview", htmlPolicy: "file-page" }),
        yield* policy({ path: page, mimeType: "text/html", htmlPolicy: "file-page" }),
      ]) {
        expect(filePage?.startsWith(`${sandbox}; `)).toBe(true);
        for (const directive of [
          "connect-src data: blob:",
          "form-action 'none'",
          "frame-src 'none'",
        ]) {
          expect(filePage).toContain(directive);
        }
        expect(filePage).toMatch(/script-src 'self' https: 'unsafe-inline'/);
        expect(filePage).not.toMatch(/'nonce-|'sha/);
      }
      expect(yield* policy({ path: page })).toBe(sandbox);
      expect(yield* policy({ path: page, mimeType: "text/html" })).toBe(sandbox);
    }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("reads a pinned page up to the size limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-page-" }),
      );
      const page = path.join(directory, "page.html");
      for (const size of [0, limit, limit + 1, limit * 2]) {
        const expected = Buffer.alloc(size, "x");
        yield* fs.writeFile(page, expected);
        const file = yield* openMediaFile(page);
        if (!file) throw new Error("Expected an opened media file");
        const bytes = yield* readPinnedFilePage(page, file);
        if (size > limit) {
          expect(bytes).toBeNull();
        } else {
          expect(bytes !== null && Buffer.from(bytes).equals(expected)).toBe(true);
        }
      }
    }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("serves an exact page from its pinned handle, not its path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-exact-page-" }),
      );
      const page = path.join(directory, "page.html");
      const replacement = path.join(directory, "replacement.html");
      const small = Buffer.from("<!doctype html><html><body>original ☃</body></html>");
      const large = Buffer.alloc(limit + 1, "x");
      const utf16 = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("<p>utf16</p>", "utf16le"),
      ]);
      const withScript = Buffer.concat([small, Buffer.from(FILE_PREVIEW_SCROLL_SCRIPT)]);
      const exact = { path: page, mimeType: "text/html", renderIntent: "file-preview" } as const;
      for (const [bytes, expected] of [
        [small, withScript],
        [large, large],
        [utf16, utf16],
      ] as const) {
        for (const method of ["GET", "HEAD"] as const) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* fs.writeFile(page, bytes);
              const file = yield* openMediaFile(page);
              if (!file) throw new Error("Expected an opened media file");
              yield* fs.writeFileString(replacement, "<p>replacement</p>");
              yield* fs.rename(replacement, page);
              const response = HttpServerResponse.toWeb(
                yield* assetFileResponse({ ...exact, file }, undefined, undefined, method),
              );
              expect(response.status).toBe(200);
              expect(response.headers.get("content-length")).toBe(String(expected.byteLength));
              const body = Buffer.from(yield* Effect.promise(() => response.arrayBuffer()));
              expect(body.equals(method === "HEAD" ? Buffer.alloc(0) : expected)).toBe(true);
            }),
          );
        }
      }
    }).pipe(Effect.provide(layerFileResponse)),
  );
});
