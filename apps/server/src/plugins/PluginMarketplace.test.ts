import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PluginId, type PluginSource } from "@t3tools/contracts/plugin";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as NodeURL from "node:url";

import { PluginHttpClientTransportService } from "./capabilities/HttpClientCapability.ts";
import { OutboundUrlError, OutboundUrlLookup } from "./OutboundUrlValidator.ts";
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

// example.test resolves publicly; internal.test resolves into RFC1918 space so
// the SSRF guard must refuse to fetch it.
const TestOutboundLookupLive = Layer.succeed(OutboundUrlLookup, (host: string) => {
  if (host === "example.test") {
    return Effect.succeed([{ address: "93.184.216.34", family: 4 as const }]);
  }
  if (host === "internal.test") {
    return Effect.succeed([{ address: "192.168.1.10", family: 4 as const }]);
  }
  return Effect.fail(new OutboundUrlError({ reason: `unexpected lookup ${host}` }));
});

const TestPluginHttpClientTransportLive = Layer.succeed(
  PluginHttpClientTransportService,
  (request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        HttpClientRequest.get(request.url.toString()),
        Response.json(validMarketplace),
      ),
    ),
);

const marketplaceTest = it.layer(
  PluginMarketplaceLayer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(TestOutboundLookupLive),
    Layer.provideMerge(TestPluginHttpClientTransportLive),
  ),
);

// A response whose body stream never emits and never closes: the capped read
// suspends forever, standing in for a byte-drip / stalled endpoint that stays
// under the byte cap but would otherwise hold catalog refresh open indefinitely.
const neverEndingResponse = () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start() {
        // never enqueue, never close
      },
    }),
    { headers: { "content-type": "application/json" } },
  );

const HangingTransportLive = Layer.succeed(PluginHttpClientTransportService, (request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      HttpClientRequest.get(request.url.toString()),
      neverEndingResponse(),
    ),
  ),
);

const marketplaceTimeoutLayer = PluginMarketplaceLayer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(TestClock.layer()),
  Layer.provideMerge(TestOutboundLookupLive),
  Layer.provideMerge(HangingTransportLive),
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
      // Embedded credentials must be stripped so they are never persisted in
      // the lockfile or echoed back through listSources / error payloads.
      assert.equal(
        resolveMarketplaceUrl("https://user:secret@example.test/marketplace.json"),
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

  it.effect("surfaces a non-HTTPS tarball as a typed failure, not a defect", () =>
    withPluginDev(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const marketplace = yield* PluginMarketplace;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-marketplace-" });
        const filePath = path.join(dir, "marketplace.json");
        yield* fs.writeFileString(
          filePath,
          encodeMarketplaceJson({
            plugins: [
              {
                ...validMarketplace.plugins[0]!,
                versions: [
                  {
                    ...validMarketplace.plugins[0]!.versions[0]!,
                    tarball: "http://insecure.test/test-plugin-1.0.0.tgz",
                  },
                ],
              },
            ],
          }),
        );
        const url = NodeURL.pathToFileURL(filePath).toString();
        const source: PluginSource = {
          id: sourceIdForUrl(url),
          url,
          addedAt: "2026-07-03T00:00:00.000Z",
        };

        const result = yield* Effect.result(
          marketplace.findVersion({
            source,
            pluginId: PluginId.make("test-plugin"),
            version: "1.0.0",
          }),
        );

        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.equal(result.failure.code, "invalid-source");
      }),
    ),
  );

  it.effect("refuses to fetch marketplace hosts that resolve to private addresses", () =>
    Effect.gen(function* () {
      const marketplace = yield* PluginMarketplace;

      const result = yield* Effect.result(
        marketplace.fetchSource({
          id: "internal",
          url: "https://internal.test/marketplace.json",
          addedAt: "2026-07-03T00:00:00.000Z",
        }),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(result.failure.code, "catalog-fetch-failed");
        assert.include(result.failure.message, "not allowed");
      }
    }),
  );

  it.effect("fetches marketplace json over the guarded HTTP path", () =>
    Effect.gen(function* () {
      const marketplace = yield* PluginMarketplace;

      const index = yield* marketplace.fetchSource({
        id: "https",
        url: "https://example.test/marketplace.json",
        addedAt: "2026-07-03T00:00:00.000Z",
      });

      assert.equal(index.plugins[0]?.id, PluginId.make("test-plugin"));
    }),
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

// A body-drip endpoint (response arrives, bytes never do) must not hold catalog
// refresh open past the wall-clock deadline. The transport `timeoutMs` only
// bounds socket inactivity, so the pipeline-level Effect.timeoutOrElse is what
// bounds this. Driven under TestClock so the real MARKETPLACE_FETCH_TIMEOUT_MS
// (30s) constant is exercised deterministically.
it.effect("marketplace fetch times out when the response body never completes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const marketplace = yield* PluginMarketplace;
      const child = yield* Effect.forkChild(
        Effect.result(
          marketplace.fetchSource({
            id: "hang",
            url: "https://example.test/marketplace.json",
            addedAt: "2026-07-03T00:00:00.000Z",
          }),
        ),
        { startImmediately: true },
      );
      yield* TestClock.adjust("30 seconds");
      const result = yield* Fiber.join(child);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(result.failure.code, "catalog-fetch-failed");
        assert.include(result.failure.message, "time limit");
      }
    }).pipe(Effect.provide(marketplaceTimeoutLayer)),
  ),
);
