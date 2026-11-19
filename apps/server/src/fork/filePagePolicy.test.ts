import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpServerResponse } from "effect/http";

import { assetFileResponse } from "../http.ts";

const layerFileResponse = Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer);

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
});
