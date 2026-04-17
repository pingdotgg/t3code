import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { HttpClient, HttpRouter } from "effect/unstable/http";

import { makeMockUpdateRouteLayer } from "./mock-update-server.ts";

const withMockUpdateServer = <A, E, R>(rootRealPath: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      HttpRouter.serve(makeMockUpdateRouteLayer(rootRealPath), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
    ),
  );

it.layer(NodeServices.layer)("mock-update-server", (it) => {
  it.effect("serves files from the configured root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "mock-update-server-root-",
      });
      const rootRealPath = yield* fileSystem.realPath(root);
      const filePath = path.join(root, "latest.yml");

      yield* fileSystem.writeFileString(filePath, "version: 0.0.1\n");

      yield* withMockUpdateServer(
        rootRealPath,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get("/latest.yml");

          assert.equal(response.status, 200);
          assert.equal(response.headers["content-type"], "text/yaml");
          assert.equal(yield* response.text, "version: 0.0.1\n");
        }),
      );
    }),
  );

  it.effect("rejects encoded path traversal outside the configured root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "mock-update-server-root-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "mock-update-server-outside-",
      });
      const rootRealPath = yield* fileSystem.realPath(root);

      yield* fileSystem.writeFileString(path.join(outside, "secret.txt"), "nope\n");

      yield* withMockUpdateServer(
        rootRealPath,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get("/%2e%2e/secret.txt");

          assert.equal(response.status, 404);
          assert.equal(yield* response.text, "Not Found");
        }),
      );
    }),
  );

  it.effect("rejects symlinked files that escape the configured root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "mock-update-server-root-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "mock-update-server-outside-",
      });
      const rootRealPath = yield* fileSystem.realPath(root);
      const outsideFile = path.join(outside, "outside.yml");
      const linksDir = path.join(root, "links");
      const symlinkPath = path.join(linksDir, "outside.yml");

      yield* fileSystem.writeFileString(outsideFile, "version: outside\n");
      yield* fileSystem.makeDirectory(linksDir, { recursive: true });
      yield* fileSystem.symlink(outsideFile, symlinkPath);

      yield* withMockUpdateServer(
        rootRealPath,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get("/links/outside.yml");

          assert.equal(response.status, 404);
          assert.equal(yield* response.text, "Not Found");
        }),
      );
    }),
  );
});
