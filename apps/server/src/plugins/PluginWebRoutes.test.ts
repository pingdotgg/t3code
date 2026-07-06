import { assert, describe, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EMPTY_PLUGIN_LOCKFILE,
  PluginId,
  type PluginLockfilePlugin,
} from "@t3tools/contracts/plugin";
import {
  PLUGIN_WEB_BUNDLE_CACHE_CONTROL,
  PLUGIN_WEB_SHIM_CACHE_CONTROL,
} from "@t3tools/shared/pluginHostWeb";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { PluginLockfileStore } from "./PluginLockfileStore.ts";
import * as PluginLockfileStoreLayer from "./PluginLockfileStore.ts";
import { pluginVersionDir } from "./PluginPaths.ts";
import { pluginWebRouteLayer, readLockfileCached } from "./PluginWebRoutes.ts";

const pluginId = PluginId.make("web-plugin");

const canBindLoopback = async () => {
  const NodeNet = await import("node:net");
  return await new Promise<boolean>((resolve) => {
    const server = NodeNet.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.close(() => resolve(true));
    });
  });
};

const loopbackAvailable = await canBindLoopback();

const nodeHttpServerLayer = Layer.unwrap(
  Effect.promise(() => import("node:http")).pipe(
    Effect.map((NodeHttp) =>
      NodeHttpServer.layer(NodeHttp.createServer, {
        host: "127.0.0.1",
        port: 0,
      }),
    ),
  ),
);

const makePlugin = (overrides: Partial<PluginLockfilePlugin> = {}): PluginLockfilePlugin => ({
  version: "1.0.0",
  sha256: "sha",
  sourceId: "local",
  enabled: true,
  state: "active",
  activation: { activatingSince: null, crashCount: 0 },
  installedAt: "2026-07-03T00:00:00.000Z",
  lastError: null,
  ...overrides,
});

const makeRouteLayer = () =>
  HttpRouter.serve(pluginWebRouteLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(PluginLockfileStoreLayer.layer),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-plugin-web-routes-" })),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(nodeHttpServerLayer),
    Layer.provideMerge(FetchHttpClient.layer),
  );

const routeUrl = (pathname: string) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    if (typeof address === "string" || !("port" in address)) {
      assert.fail(`Expected TCP address, got ${String(address)}`);
    }
    return `http://127.0.0.1:${address.port}${pathname}`;
  });

const getPath = (pathname: string) =>
  Effect.gen(function* () {
    const url = yield* routeUrl(pathname);
    return yield* HttpClient.get(url);
  });

const installPluginFile = (input: {
  readonly plugin?: Partial<PluginLockfilePlugin>;
  readonly relativePath: string;
  readonly contents: string;
}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* PluginLockfileStore;
    const plugin = makePlugin(input.plugin);
    yield* store.updatePlugin(pluginId, () => Effect.succeed(plugin));
    const versionDir = pluginVersionDir(config.pluginsDir, pluginId, plugin.version, path.join);
    const filePath = path.join(versionDir, input.relativePath);
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, input.contents);
    return { filePath, versionDir };
  });

if (loopbackAvailable) {
  it.layer(makeRouteLayer())("plugin web route layer", (it) => {
    it.effect("serves installed plugin web bundles with immutable cache headers", () =>
      Effect.gen(function* () {
        yield* installPluginFile({
          relativePath: "web/entry.js",
          contents: "export const ok = true;\n",
        });

        const response = yield* getPath("/plugins/web-plugin/1.0.0/web/entry.js");

        assert.equal(response.status, 200);
        assert.match(response.headers["content-type"] ?? "", /^text\/javascript/u);
        assert.equal(response.headers["cache-control"], PLUGIN_WEB_BUNDLE_CACHE_CONTROL);
        assert.equal(response.headers["x-content-type-options"], "nosniff");
        assert.equal(yield* response.text, "export const ok = true;\n");
      }),
    );

    it.effect("serves installed disabled plugin bundles", () =>
      Effect.gen(function* () {
        yield* installPluginFile({
          plugin: { enabled: false, state: "disabled" },
          relativePath: "assets/panel.css",
          contents: ".panel { color: red; }\n",
        });

        const response = yield* getPath("/plugins/web-plugin/1.0.0/assets/panel.css");

        assert.equal(response.status, 200);
        assert.match(response.headers["content-type"] ?? "", /^text\/css/u);
        assert.equal(yield* response.text, ".panel { color: red; }\n");
      }),
    );

    it.effect("returns 404 for unknown plugins", () =>
      Effect.gen(function* () {
        const response = yield* getPath("/plugins/missing-plugin/1.0.0/web/entry.js");

        assert.equal(response.status, 404);
        assert.equal(yield* response.text, "Not Found");
      }),
    );

    it.effect("rejects textual traversal and symlink escapes", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { versionDir } = yield* installPluginFile({
          relativePath: "web/entry.js",
          contents: "export const ok = true;\n",
        });
        const outsideFile = path.join(path.dirname(versionDir), "outside.js");
        yield* fileSystem.writeFileString(outsideFile, "export const secret = true;\n");
        yield* fileSystem.symlink(outsideFile, path.join(versionDir, "web", "escape.js"));

        const traversal = yield* getPath("/plugins/web-plugin/1.0.0/web/%2e%2e/outside.js");
        const escape = yield* getPath("/plugins/web-plugin/1.0.0/web/escape.js");

        assert.equal(traversal.status, 404);
        assert.equal(escape.status, 404);
      }),
    );

    it.effect("serves host shim modules as JavaScript with short cache headers", () =>
      Effect.gen(function* () {
        const response = yield* getPath("/plugin-host/react.js");
        const source = yield* response.text;

        assert.equal(response.status, 200);
        assert.match(response.headers["content-type"] ?? "", /^text\/javascript/u);
        assert.equal(response.headers["cache-control"], PLUGIN_WEB_SHIM_CACHE_CONTROL);
        assert.include(source, 'globalThis.__T3_PLUGIN_HOST__["react"]');
        assert.include(source, "export const useState = m.useState;");
      }),
    );
  });
} else {
  describe.skip("plugin web live route layer", () => {
    it("skips live router assertions when local TCP bind is unavailable", () => {});
  });
}

describe("readLockfileCached", () => {
  it.effect("serves cached reads within the TTL and re-reads after it expires", () =>
    Effect.gen(function* () {
      const cacheKey = {};
      let reads = 0;
      const read = Effect.sync(() => {
        reads += 1;
        return EMPTY_PLUGIN_LOCKFILE;
      });

      const first = yield* readLockfileCached(cacheKey, read);
      const second = yield* readLockfileCached(cacheKey, read);
      assert.strictEqual(first, EMPTY_PLUGIN_LOCKFILE);
      assert.strictEqual(second, EMPTY_PLUGIN_LOCKFILE);
      assert.strictEqual(reads, 1);

      yield* TestClock.adjust(2_000);
      yield* readLockfileCached(cacheKey, read);
      assert.strictEqual(reads, 2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps caches for distinct stores isolated and does not cache failures", () =>
    Effect.gen(function* () {
      const cacheKey = {};
      const otherKey = {};
      let reads = 0;
      const read = Effect.sync(() => {
        reads += 1;
        return EMPTY_PLUGIN_LOCKFILE;
      });

      const failure = yield* readLockfileCached(cacheKey, Effect.fail("boom" as const)).pipe(
        Effect.flip,
      );
      assert.strictEqual(failure, "boom");

      // The failed read left nothing behind for this key…
      yield* readLockfileCached(cacheKey, read);
      assert.strictEqual(reads, 1);
      // …and a different store gets its own fresh read.
      yield* readLockfileCached(otherKey, read);
      assert.strictEqual(reads, 2);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
