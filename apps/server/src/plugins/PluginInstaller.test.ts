import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  PluginId,
  PluginManifest,
  type PluginManifest as PluginManifestType,
} from "@t3tools/contracts/plugin";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import * as ServerConfig from "../config.ts";
import { PluginCatalog } from "./PluginCatalog.ts";
import { PluginHost } from "./PluginHost.ts";
import { PluginInstaller } from "./PluginInstaller.ts";
import * as PluginInstallerModule from "./PluginInstaller.ts";
import { PluginLockfileStore } from "./PluginLockfileStore.ts";
import * as PluginLockfileStoreLayer from "./PluginLockfileStore.ts";
import { MarketplaceIndex } from "./PluginMarketplace.ts";
import * as PluginMarketplaceModule from "./PluginMarketplace.ts";

const pluginId = PluginId.make("test-plugin");
const sourceId = "src-test";
const tarballUrl = "https://market.test/test-plugin-1.0.0.tgz";

const encodeManifestJson = Schema.encodeSync(Schema.fromJsonString(PluginManifest));
const encodeMarketplaceJson = Schema.encodeSync(Schema.fromJsonString(MarketplaceIndex));

const manifest = (overrides: Partial<PluginManifestType> = {}): PluginManifestType => ({
  id: pluginId,
  name: "Test Plugin",
  version: "1.0.0",
  hostApi: "^1.0.0",
  capabilities: ["agents"],
  entries: { server: "server/index.js" },
  ...overrides,
});

const textEncoder = new TextEncoder();

function checksum(header: Uint8Array): number {
  let sum = 0;
  for (const byte of header) sum += byte;
  return sum;
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string) {
  target.set(textEncoder.encode(value).slice(0, length), offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number) {
  writeAscii(target, offset, length, value.toString(8).padStart(length - 1, "0"));
}

function tarEntry(input: {
  readonly name: string;
  readonly body?: Uint8Array;
  readonly type?: "0" | "2" | "5";
}) {
  const body = input.body ?? new Uint8Array();
  const header = new Uint8Array(512);
  writeAscii(header, 0, 100, input.name);
  writeOctal(header, 100, 8, input.type === "5" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, body.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeAscii(header, 156, 1, input.type ?? "0");
  writeAscii(header, 257, 6, "ustar");
  writeAscii(header, 263, 2, "00");
  writeOctal(header, 148, 8, checksum(header));
  const paddedSize = Math.ceil(body.byteLength / 512) * 512;
  const padded = new Uint8Array(512 + paddedSize);
  padded.set(header, 0);
  padded.set(body, 512);
  return padded;
}

function tar(entries: ReadonlyArray<Parameters<typeof tarEntry>[0]>): Uint8Array {
  const chunks = [...entries.map(tarEntry), new Uint8Array(1024)];
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const tarballForManifest = (pluginManifest = manifest()) =>
  tarballForManifestJson(encodeManifestJson(pluginManifest));

const tarballForManifestJson = (
  manifestJson: string,
  extraEntries: ReadonlyArray<Parameters<typeof tarEntry>[0]> = [],
) =>
  tar([
    {
      name: "manifest.json",
      body: textEncoder.encode(manifestJson),
    },
    {
      name: "server/index.js",
      body: textEncoder.encode("export default { register() { return {}; } };"),
    },
    ...extraEntries,
  ]);

const marketplaceJson = (sha: string, version = "1.0.0") => ({
  plugins: [
    {
      id: pluginId,
      name: "Test Plugin",
      description: "Adds tests.",
      capabilities: ["agents" as const],
      versions: [
        {
          version,
          tarball: tarballUrl,
          sha256: sha,
          hostApi: "^1.0.0",
          publishedAt: "2026-07-03T00:00:00.000Z",
        },
      ],
    },
  ],
});

function installerLayer(input: {
  readonly tarball: Uint8Array;
  readonly marketplaceSha?: string;
  readonly activated?: Array<string>;
}) {
  const platform = NodeServices.layer;
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-installer-" }).pipe(
    Layer.provide(platform),
  );
  const marketplace = marketplaceJson(input.marketplaceSha ?? sha256(input.tarball));
  const marketplaceBody = encodeMarketplaceJson(marketplace);
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const url = request.url.toString();
      if (url === "https://market.test/marketplace.json") {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(marketplaceBody, { headers: { "content-type": "application/json" } }),
          ),
        );
      }
      if (url === tarballUrl) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(input.tarball)));
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 404 })));
    }),
  );
  const host = Layer.succeed(
    PluginHost,
    PluginHost.of({
      start: Effect.void,
      activatePlugin: (id) =>
        Effect.sync(() => {
          input.activated?.push(id);
        }),
      deactivatePlugin: () => Effect.void,
    }),
  );
  const catalog = Layer.succeed(
    PluginCatalog,
    PluginCatalog.of({
      list: Effect.succeed([
        {
          id: pluginId,
          name: "Test Plugin",
          version: "1.0.0",
          state: "active" as const,
          capabilities: ["agents" as const],
          hasWeb: false,
          lastError: null,
        },
      ]),
    }),
  );
  return PluginInstallerModule.layer.pipe(
    Layer.provideMerge(PluginMarketplaceModule.layer),
    Layer.provideMerge(PluginLockfileStoreLayer.layer),
    Layer.provideMerge(host),
    Layer.provideMerge(catalog),
    Layer.provideMerge(http),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(config),
    Layer.provide(platform),
  );
}

const seedSource = Effect.gen(function* () {
  const store = yield* PluginLockfileStore;
  yield* store.updateSources(() =>
    Effect.succeed([
      {
        id: sourceId,
        url: "https://market.test/marketplace.json",
        addedAt: "2026-07-03T00:00:00.000Z",
      },
    ]),
  );
});

it.effect("PluginInstaller rejects sha mismatches without staging", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      yield* seedSource;

      const result = yield* Effect.result(
        installer.beginInstall({
          sourceId,
          pluginId,
          version: "1.0.0",
        }),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.code, "checksum-mismatch");
    }).pipe(
      Effect.provide(
        installerLayer({ tarball: tarballForManifest(), marketplaceSha: "b".repeat(64) }),
      ),
    ),
  ),
);

it.effect("PluginInstaller rejects unsafe tar entries", () => {
  const traversal = tar([
    { name: "manifest.json", body: textEncoder.encode(encodeManifestJson(manifest())) },
    { name: "../escape.js", body: textEncoder.encode("x") },
  ]);
  return Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      yield* seedSource;

      const result = yield* Effect.result(
        installer.beginInstall({ sourceId, pluginId, version: "1.0.0" }),
      );

      assert.isTrue(Result.isFailure(result));
    }).pipe(Effect.provide(installerLayer({ tarball: traversal }))),
  );
});

it.effect("PluginInstaller rejects symlinks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      yield* seedSource;

      const symlinkResult = yield* Effect.result(
        installer.beginInstall({ sourceId, pluginId, version: "1.0.0" }),
      );
      assert.isTrue(Result.isFailure(symlinkResult));
    }).pipe(
      Effect.provide(
        installerLayer({
          tarball: tar([
            { name: "manifest.json", body: textEncoder.encode(encodeManifestJson(manifest())) },
            { name: "server/link", type: "2" },
          ]),
        }),
      ),
    ),
  ),
);

it.effect("PluginInstaller rejects oversize files and gzip compression bombs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      yield* seedSource;

      const oversizeResult = yield* Effect.result(
        installer.beginInstall({ sourceId, pluginId, version: "1.0.0" }),
      );
      assert.isTrue(Result.isFailure(oversizeResult));
      if (Result.isFailure(oversizeResult))
        assert.equal(oversizeResult.failure.code, "extract-failed");
    }).pipe(
      Effect.provide(
        installerLayer({
          tarball: tarballForManifestJson(encodeManifestJson(manifest()), [
            { name: "assets/large.bin", body: new Uint8Array(16 * 1024 * 1024 + 1) },
          ]),
        }),
      ),
    ),
  ).pipe(
    Effect.andThen(
      Effect.scoped(
        Effect.gen(function* () {
          const installer = yield* PluginInstaller;
          yield* seedSource;

          const bombResult = yield* Effect.result(
            installer.beginInstall({ sourceId, pluginId, version: "1.0.0" }),
          );
          assert.isTrue(Result.isFailure(bombResult));
          if (Result.isFailure(bombResult)) assert.equal(bombResult.failure.code, "extract-failed");
        }).pipe(
          Effect.provide(
            installerLayer({
              tarball: NodeZlib.gzipSync(
                tarballForManifestJson(encodeManifestJson(manifest()), [
                  { name: "assets/repeated.bin", body: new Uint8Array(1024 * 1024) },
                ]),
              ),
            }),
          ),
        ),
      ),
    ),
  ),
);

it.effect("PluginInstaller rejects invalid manifests before staging can be confirmed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      yield* seedSource;

      const idMismatch = yield* Effect.result(
        installer.beginInstall({ sourceId, pluginId, version: "1.0.0" }),
      );
      assert.isTrue(Result.isFailure(idMismatch));
      if (Result.isFailure(idMismatch)) assert.equal(idMismatch.failure.code, "manifest-invalid");
    }).pipe(
      Effect.provide(
        installerLayer({
          tarball: tarballForManifest(manifest({ id: PluginId.make("other-plugin") })),
        }),
      ),
    ),
  ).pipe(
    Effect.andThen(
      Effect.scoped(
        Effect.gen(function* () {
          const installer = yield* PluginInstaller;
          yield* seedSource;

          const hostApiMismatch = yield* Effect.result(
            installer.beginInstall({ sourceId, pluginId, version: "1.0.0" }),
          );
          assert.isTrue(Result.isFailure(hostApiMismatch));
          if (Result.isFailure(hostApiMismatch)) {
            assert.equal(hostApiMismatch.failure.code, "manifest-invalid");
          }
        }).pipe(
          Effect.provide(
            installerLayer({ tarball: tarballForManifest(manifest({ hostApi: "2.0.0" })) }),
          ),
        ),
      ),
    ),
    Effect.andThen(
      Effect.scoped(
        Effect.gen(function* () {
          const installer = yield* PluginInstaller;
          yield* seedSource;

          const unknownCapability = yield* Effect.result(
            installer.beginInstall({ sourceId, pluginId, version: "1.0.0" }),
          );
          assert.isTrue(Result.isFailure(unknownCapability));
          if (Result.isFailure(unknownCapability)) {
            assert.equal(unknownCapability.failure.code, "manifest-invalid");
          }
        }).pipe(
          Effect.provide(
            installerLayer({
              tarball: tarballForManifestJson(
                JSON.stringify({
                  ...manifest(),
                  capabilities: ["unknown"],
                }),
              ),
            }),
          ),
        ),
      ),
    ),
    Effect.andThen(
      Effect.scoped(
        Effect.gen(function* () {
          const installer = yield* PluginInstaller;
          yield* seedSource;

          const webOnlyCapability = yield* Effect.result(
            installer.beginInstall({ sourceId, pluginId, version: "1.0.0" }),
          );
          assert.isTrue(Result.isFailure(webOnlyCapability));
          if (Result.isFailure(webOnlyCapability)) {
            assert.equal(webOnlyCapability.failure.code, "manifest-invalid");
          }
        }).pipe(
          Effect.provide(
            installerLayer({
              tarball: tar([
                {
                  name: "manifest.json",
                  body: textEncoder.encode(
                    JSON.stringify({
                      ...manifest(),
                      capabilities: ["agents"],
                      entries: { web: "web/index.js" },
                    }),
                  ),
                },
                { name: "web/index.js", body: textEncoder.encode("export default {};") },
              ]),
            }),
          ),
        ),
      ),
    ),
    Effect.andThen(
      Effect.scoped(
        Effect.gen(function* () {
          const installer = yield* PluginInstaller;
          const store = yield* PluginLockfileStore;
          yield* seedSource;
          yield* store.updatePlugin(PluginId.make("test"), () =>
            Effect.succeed({
              version: "1.0.0",
              sha256: "old",
              sourceId,
              enabled: true,
              state: "active",
              activation: { activatingSince: null, crashCount: 0 },
              installedAt: "2026-07-03T00:00:00.000Z",
              lastError: null,
            }),
          );

          const prefixCollision = yield* Effect.result(
            installer.beginInstall({ sourceId, pluginId, version: "1.0.0" }),
          );
          assert.isTrue(Result.isFailure(prefixCollision));
          if (Result.isFailure(prefixCollision)) {
            assert.equal(prefixCollision.failure.code, "manifest-invalid");
          }
        }).pipe(Effect.provide(installerLayer({ tarball: tarballForManifest() }))),
      ),
    ),
  ),
);

it("plugin id collision follows the DB table prefix, not the raw id", () => {
  // Same prefix / one a prefix of the other → collide.
  assert.isTrue(PluginInstallerModule.pluginTablePrefixesCollide("test", "test"));
  assert.isTrue(PluginInstallerModule.pluginTablePrefixesCollide("test", "test-plugin"));
  assert.isTrue(PluginInstallerModule.pluginTablePrefixesCollide("a", "a-b"));
  // Distinct ids whose prefixes are NOT prefixes of each other → no collision.
  assert.isFalse(PluginInstallerModule.pluginTablePrefixesCollide("chat", "chatbot"));
  assert.isFalse(PluginInstallerModule.pluginTablePrefixesCollide("board", "boards"));
  assert.isFalse(PluginInstallerModule.pluginTablePrefixesCollide("a", "b"));
});

it.effect("PluginInstaller begin-confirm updates the lockfile and hot-activates", () => {
  const activated: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      const store = yield* PluginLockfileStore;
      yield* seedSource;

      const staged = yield* installer.beginInstall({ sourceId, pluginId, version: "1.0.0" });
      assert.equal(staged.capabilityDescriptions.agents, "Run AI agents");
      const result = yield* installer.confirmInstall(staged.stageToken);
      const lockfile = yield* store.readLockfile;

      assert.equal(result.plugin.id, pluginId);
      assert.equal(lockfile.plugins[pluginId]?.state, "active");
      assert.deepEqual(activated, [pluginId]);
    }).pipe(Effect.provide(installerLayer({ tarball: tarballForManifest(), activated }))),
  );
});

it.effect("PluginInstaller abort and expired tokens clean staging", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* seedSource;

      const staged = yield* installer.beginInstall({ sourceId, pluginId, version: "1.0.0" });
      yield* installer.abortInstall(staged.stageToken);
      assert.isFalse(yield* fs.exists(path.join(config.pluginsDir, ".staging", staged.stageToken)));

      const expired = yield* installer.beginInstall({ sourceId, pluginId, version: "1.0.0" });
      yield* TestClock.adjust("16 minutes");
      const result = yield* Effect.result(installer.confirmInstall(expired.stageToken));

      assert.isTrue(Result.isFailure(result));
      assert.isFalse(
        yield* fs.exists(path.join(config.pluginsDir, ".staging", expired.stageToken)),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(installerLayer({ tarball: tarballForManifest() }), NodeServices.layer),
      ),
    ),
  ),
);

it.effect("PluginInstaller stages upgrades and uninstall marks pending remove", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      const store = yield* PluginLockfileStore;
      yield* seedSource;
      yield* store.updatePlugin(pluginId, () =>
        Effect.succeed({
          version: "0.9.0",
          sha256: "old",
          sourceId,
          enabled: true,
          state: "active",
          activation: { activatingSince: null, crashCount: 0 },
          installedAt: "2026-07-03T00:00:00.000Z",
          lastError: null,
        }),
      );

      const staged = yield* installer.beginUpgrade({ pluginId, version: "1.0.0" });
      yield* installer.confirmUpgrade(staged.stageToken);
      let lockfile = yield* store.readLockfile;
      assert.equal(lockfile.plugins[pluginId]?.state, "pending-upgrade");
      assert.equal(lockfile.plugins[pluginId]?.staged?.version, "1.0.0");

      yield* installer.uninstall({ pluginId, removeData: false });
      lockfile = yield* store.readLockfile;
      assert.equal(lockfile.plugins[pluginId]?.state, "pending-remove");
    }).pipe(Effect.provide(installerLayer({ tarball: tarballForManifest() }))),
  ),
);
