import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PluginId, type PluginSource } from "@t3tools/contracts/plugin";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as NodeURL from "node:url";

import {
  MarketplaceIndex,
  PluginMarketplace,
  resolveMarketplaceUrl,
  sourceIdForUrl,
  layer as PluginMarketplaceLayer,
} from "./PluginMarketplace.ts";

const encodeMarketplaceJson = Schema.encodeSync(Schema.fromJsonString(MarketplaceIndex));

const validMarketplace = {
  plugins: [
    {
      id: PluginId.make("test-plugin"),
      name: "Test Plugin",
      description: "Adds tests.",
      capabilities: ["agents" as const],
      versions: [
        {
          version: "1.0.0",
          tarball: "https://example.test/test-plugin-1.0.0.tgz",
          sha256: "a".repeat(64),
          hostApi: "^1.0.0",
          publishedAt: "2026-07-03T00:00:00.000Z",
        },
      ],
    },
  ],
};

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(validMarketplace))),
  ),
);

const marketplaceTest = it.layer(
  PluginMarketplaceLayer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(TestHttpClientLive),
  ),
);

const withPluginDev = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => process.env.T3_PLUGIN_DEV),
    () =>
      Effect.sync(() => {
        process.env.T3_PLUGIN_DEV = "1";
      }).pipe(Effect.andThen(effect)),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env.T3_PLUGIN_DEV;
        } else {
          process.env.T3_PLUGIN_DEV = previous;
        }
      }),
  );

marketplaceTest("PluginMarketplace", (it) => {
  it.effect("resolves HTTPS and owner/repo sources and rejects unsafe protocols", () =>
    Effect.sync(() => {
      assert.equal(
        resolveMarketplaceUrl("https://example.test/marketplace.json#ignored"),
        "https://example.test/marketplace.json",
      );
      assert.equal(
        resolveMarketplaceUrl("owner/repo"),
        "https://raw.githubusercontent.com/owner/repo/HEAD/marketplace.json",
      );
      assert.throws(() => resolveMarketplaceUrl("http://example.test/marketplace.json"));
      assert.throws(() => resolveMarketplaceUrl("file:///tmp/marketplace.json"));
    }),
  );

  it.effect("allows file sources only in plugin dev mode", () =>
    withPluginDev(
      Effect.sync(() => {
        assert.equal(
          resolveMarketplaceUrl("file:///tmp/marketplace.json"),
          "file:///tmp/marketplace.json",
        );
      }),
    ),
  );

  it.effect("decodes marketplace json from a source", () =>
    withPluginDev(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const marketplace = yield* PluginMarketplace;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-marketplace-" });
        const filePath = path.join(dir, "marketplace.json");
        yield* fs.writeFileString(filePath, encodeMarketplaceJson(validMarketplace));
        const url = NodeURL.pathToFileURL(filePath).toString();
        const source: PluginSource = {
          id: sourceIdForUrl(url),
          url,
          addedAt: "2026-07-03T00:00:00.000Z",
        };

        const index = yield* marketplace.fetchSource(source);

        assert.equal(index.plugins[0]?.id, PluginId.make("test-plugin"));
      }),
    ),
  );

  it.effect("isolates bad source errors in aggregate catalog calls", () =>
    withPluginDev(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const marketplace = yield* PluginMarketplace;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-marketplace-" });
        const goodPath = path.join(dir, "good.json");
        const badPath = path.join(dir, "bad.json");
        yield* fs.writeFileString(goodPath, encodeMarketplaceJson(validMarketplace));
        yield* fs.writeFileString(badPath, "{not-json");
        const goodUrl = NodeURL.pathToFileURL(goodPath).toString();
        const badUrl = NodeURL.pathToFileURL(badPath).toString();

        const result = yield* marketplace.catalog([
          { id: "good", url: goodUrl, addedAt: "2026-07-03T00:00:00.000Z" },
          { id: "bad", url: badUrl, addedAt: "2026-07-03T00:00:00.000Z" },
        ]);

        assert.equal(result.entries.length, 1);
        assert.equal(result.errors.length, 1);
        assert.equal(result.errors[0]?.sourceId, "bad");
      }),
    ),
  );

  it.effect("rejects marketplace responses over the byte cap", () =>
    withPluginDev(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const marketplace = yield* PluginMarketplace;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-marketplace-" });
        const filePath = path.join(dir, "huge.json");
        yield* fs.writeFileString(filePath, "x".repeat(2 * 1024 * 1024 + 1));
        const url = NodeURL.pathToFileURL(filePath).toString();
        const result = yield* Effect.result(
          marketplace.fetchSource({
            id: "huge",
            url,
            addedAt: "2026-07-03T00:00:00.000Z",
          }),
        );

        assert.isTrue(Result.isFailure(result));
      }),
    ),
  );
});
