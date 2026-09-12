import { tarGzipDirectory } from "@/Util/tarGzip.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as zlib from "node:zlib";

describe("tarGzipDirectory", () => {
  it.effect("packs a Dockerfile and nested files into a gzipped ustar", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "alchemy-tar-" });
      yield* fs.writeFileString(
        path.join(dir, "Dockerfile"),
        "FROM oven/bun:1\n",
      );
      yield* fs.makeDirectory(path.join(dir, "dist"), { recursive: true });
      yield* fs.writeFileString(
        path.join(dir, "dist", "index.html"),
        "<h1>ok</h1>\n",
      );
      const gz = yield* tarGzipDirectory(dir);
      expect(gz.byteLength).toBeGreaterThan(80);
      const tar = yield* Effect.sync(() => zlib.gunzipSync(gz));
      const latin1 = new TextDecoder("latin1").decode(tar);
      expect(latin1).toContain("Dockerfile");
      expect(latin1).toContain("index.html");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
