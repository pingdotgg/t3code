import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  PluginId,
  PluginManifest,
  type PluginManifest as PluginManifestType,
} from "@t3tools/contracts/plugin";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import * as ServerConfig from "../config.ts";
import { pluginVersionDir } from "./PluginPaths.ts";
import { PRESERVE_DATA_MARKER } from "./PluginInstaller.ts";
import { PluginHttpClientTransportService } from "./capabilities/HttpClientCapability.ts";
import { OutboundUrlError, OutboundUrlLookup } from "./OutboundUrlValidator.ts";
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

// A response whose body stream never emits and never closes: the capped read
// suspends forever, standing in for a byte-drip / stalled endpoint that stays
// under the byte cap but would otherwise hold an install open indefinitely.
const neverEndingResponse = () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start() {
        // never enqueue, never close
      },
    }),
  );

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

const marketplaceJson = (sha: string, versions: ReadonlyArray<string> = ["1.0.0"]) => ({
  plugins: [
    {
      id: pluginId,
      name: "Test Plugin",
      description: "Adds tests.",
      capabilities: ["agents" as const],
      versions: versions.map((version) => ({
        version,
        tarball: tarballUrl,
        sha256: sha,
        hostApi: "^1.0.0",
        publishedAt: "2026-07-03T00:00:00.000Z",
      })),
    },
  ],
});

interface InstallerLayerInput {
  readonly tarball: Uint8Array;
  readonly marketplaceSha?: string;
  readonly marketplaceVersions?: ReadonlyArray<string>;
  readonly activated?: Array<string>;
  readonly deactivated?: Array<string>;
  /** Host → pinned address returned by the stub DNS lookup. */
  readonly hosts?: Record<string, string>;
  /** URL → response override, checked before the default marketplace/tarball routes. */
  readonly responses?: Record<string, () => Response>;
  /** Receives every URL the stub transport is asked to fetch. */
  readonly transportLog?: Array<string>;
}

function installerDeps(
  input: InstallerLayerInput,
  platform: typeof NodeServices.layer = NodeServices.layer,
) {
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-installer-" }).pipe(
    Layer.provide(platform),
  );
  const marketplace = marketplaceJson(
    input.marketplaceSha ?? sha256(input.tarball),
    input.marketplaceVersions,
  );
  const marketplaceBody = encodeMarketplaceJson(marketplace);
  const hosts = input.hosts ?? { "market.test": "93.184.216.34" };
  const lookup = Layer.succeed(OutboundUrlLookup, (host: string) => {
    const address = hosts[host];
    return address === undefined
      ? Effect.fail(new OutboundUrlError({ reason: `unexpected lookup ${host}` }))
      : Effect.succeed([{ address, family: 4 as const }]);
  });
  const transport = Layer.succeed(PluginHttpClientTransportService, (request) => {
    const url = request.url.toString();
    input.transportLog?.push(url);
    const respond = (response: Response) =>
      Effect.succeed(HttpClientResponse.fromWeb(HttpClientRequest.get(url), response));
    const override = input.responses?.[url];
    if (override) return respond(override());
    if (url === "https://market.test/marketplace.json") {
      return respond(
        new Response(marketplaceBody, { headers: { "content-type": "application/json" } }),
      );
    }
    if (url === tarballUrl) {
      return respond(new Response(input.tarball));
    }
    return respond(new Response("", { status: 404 }));
  });
  const host = Layer.succeed(
    PluginHost,
    PluginHost.of({
      start: Effect.void,
      activatePlugin: (id) =>
        Effect.sync(() => {
          input.activated?.push(id);
        }),
      deactivatePlugin: (id) =>
        Effect.sync(() => {
          input.deactivated?.push(id);
        }),
      // Mirrors the real ordering: persist runs first, then the host action. The
      // real implementation additionally holds the per-plugin activation lock
      // across both halves — that atomicity is covered in PluginHost.test.ts.
      setPluginEnabled: (id, enabled, persist) =>
        Effect.gen(function* () {
          yield* persist;
          if (enabled) {
            input.activated?.push(id);
          } else {
            input.deactivated?.push(id);
          }
        }),
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
          hasStyles: false,
          lastError: null,
        },
      ]),
    }),
  );
  return PluginMarketplaceModule.layer.pipe(
    Layer.provideMerge(PluginLockfileStoreLayer.layer),
    Layer.provideMerge(host),
    Layer.provideMerge(catalog),
    Layer.provideMerge(lookup),
    Layer.provideMerge(transport),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(config),
    Layer.provideMerge(platform),
  );
}

function installerLayer(input: InstallerLayerInput, platform?: typeof NodeServices.layer) {
  return PluginInstallerModule.layer.pipe(Layer.provideMerge(installerDeps(input, platform)));
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

it("compareSemver orders versions by semver precedence and ignores build metadata", () => {
  const cmp = PluginInstallerModule.compareSemver;
  // A release outranks its prereleases.
  assert.isAbove(cmp("1.0.0", "1.0.0-rc.1"), 0);
  assert.isBelow(cmp("1.0.0-rc.1", "1.0.0"), 0);
  // Numeric prerelease identifiers compare numerically, not lexically.
  assert.isBelow(cmp("1.0.0-rc.2", "1.0.0-rc.10"), 0);
  // The full precedence chain from semver.org §11.
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];
  for (let index = 0; index < ordered.length - 1; index++) {
    assert.isBelow(cmp(ordered[index]!, ordered[index + 1]!), 0);
    assert.isAbove(cmp(ordered[index + 1]!, ordered[index]!), 0);
  }
  // Build metadata does not affect precedence.
  assert.equal(cmp("1.0.0+build1", "1.0.0+build2"), 0);
  // Plain x.y.z core comparison (as the minAppVersion checks rely on) is intact.
  assert.isAbove(cmp("1.2.0", "1.0.0"), 0);
  assert.isAbove(cmp("2.0.0", "1.9.9"), 0);
  // A descending sort (as checkUpdates uses) picks the true latest of a
  // prerelease set.
  const latest = [
    { version: "1.0.0-rc.2" },
    { version: "1.0.0" },
    { version: "1.0.0-rc.10" },
    { version: "0.9.9" },
  ].toSorted((left, right) => cmp(right.version, left.version))[0];
  assert.equal(latest?.version, "1.0.0");
});

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

it.effect("PluginInstaller describes filesystem and httpClient consent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      yield* seedSource;

      const staged = yield* installer.beginInstall({ sourceId, pluginId, version: "1.0.0" });

      assert.equal(
        staged.capabilityDescriptions.filesystem,
        "Read and write files in your project workspace and in worktrees this plugin creates",
      );
      assert.equal(
        staged.capabilityDescriptions.httpClient,
        "Make requests to public external HTTPS services",
      );
    }).pipe(
      Effect.provide(
        installerLayer({
          tarball: tarballForManifest(manifest({ capabilities: ["filesystem", "httpClient"] })),
        }),
      ),
    ),
  ),
);

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

it.effect("PluginInstaller stages upgrades and uninstall marks pending remove", () => {
  const deactivated: Array<string> = [];
  return Effect.scoped(
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
      // uninstall must tear down the live runtime immediately, not wait for a
      // server restart to apply pending-remove.
      assert.deepEqual(deactivated, [pluginId]);
    }).pipe(Effect.provide(installerLayer({ tarball: tarballForManifest(), deactivated }))),
  );
});

it.effect("PluginInstaller confirmUpgrade loses to an in-flight uninstall", () => {
  const deactivated: Array<string> = [];
  return Effect.scoped(
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

      // Stage an upgrade, THEN uninstall (persists pending-remove). Confirming the
      // now-stale upgrade token must lose to the in-flight uninstall rather than
      // reviving the plugin and moving new files while teardown is running.
      const staged = yield* installer.beginUpgrade({ pluginId, version: "1.0.0" });
      yield* installer.uninstall({ pluginId, removeData: false });
      assert.equal((yield* store.readLockfile).plugins[pluginId]?.state, "pending-remove");

      const result = yield* Effect.result(installer.confirmUpgrade(staged.stageToken));
      assert.isTrue(Result.isFailure(result));
      // State stays pending-remove: the rejected confirm did not overwrite it.
      assert.equal((yield* store.readLockfile).plugins[pluginId]?.state, "pending-remove");
    }).pipe(Effect.provide(installerLayer({ tarball: tarballForManifest(), deactivated }))),
  );
});

it.effect("PluginInstaller uninstall removeData:true clears an earlier preserve marker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      const store = yield* PluginLockfileStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* seedSource;
      const entry = {
        version: "1.0.0",
        sha256: "installed",
        sourceId,
        enabled: true,
        state: "active" as const,
        activation: { activatingSince: null, crashCount: 0 },
        installedAt: "2026-07-03T00:00:00.000Z",
        lastError: null,
      };
      yield* store.updatePlugin(pluginId, () => Effect.succeed(entry));
      // An installed plugin has its dir on disk; the marker is only recorded when it
      // does (writing it otherwise would create a phantom dir for nothing).
      yield* fs.makeDirectory(path.join(config.pluginsDir, pluginId), { recursive: true });

      // First uninstall keeps the data: the marker is written.
      yield* installer.uninstall({ pluginId, removeData: false });
      const markerPath = path.join(config.pluginsDir, pluginId, PRESERVE_DATA_MARKER);
      assert.isTrue(yield* fs.exists(markerPath), "precondition: keep-data marker exists");

      // The user changes their mind and retries asking for deletion. The marker from
      // the earlier request used to survive, so reconcile preserved data the user had
      // just asked to delete — and a reinstall would quietly resurrect it.
      yield* store.updatePlugin(pluginId, () => Effect.succeed(entry));
      yield* installer.uninstall({ pluginId, removeData: true });
      assert.isFalse(
        yield* fs.exists(markerPath),
        "the LATEST request must win: removeData true clears the preserve marker",
      );
    }).pipe(Effect.provide(installerLayer({ tarball: tarballForManifest() }))),
  ),
);

it.effect("PluginInstaller rejects upgrading to the already-installed version", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      const store = yield* PluginLockfileStore;
      yield* seedSource;
      yield* store.updatePlugin(pluginId, () =>
        Effect.succeed({
          version: "1.0.0",
          sha256: "existing",
          sourceId,
          enabled: true,
          state: "active",
          activation: { activatingSince: null, crashCount: 0 },
          installedAt: "2026-07-03T00:00:00.000Z",
          lastError: null,
        }),
      );

      // A same-version upgrade must be rejected in beginUpgrade, before any
      // staging, so moveStagingToVersionDir can never remove the live version
      // dir out from under the running plugin.
      const result = yield* Effect.result(installer.beginUpgrade({ pluginId, version: "1.0.0" }));

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.code, "manifest-invalid");
    }).pipe(Effect.provide(installerLayer({ tarball: tarballForManifest() }))),
  ),
);

it.effect(
  "PluginInstaller rejects tarball redirects to blocked hosts without following them",
  () => {
    const transportLog: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const installer = yield* PluginInstaller;
        yield* seedSource;

        const result = yield* Effect.result(
          installer.beginInstall({ sourceId, pluginId, version: "1.0.0" }),
        );

        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.equal(result.failure.code, "download-failed");
          assert.include(result.failure.message, "not allowed");
        }
        // The redirect target must never be fetched: the guard validates the
        // Location (and its resolved addresses) before issuing any request.
        assert.deepEqual(
          transportLog.filter((url) => url.startsWith("https://internal.market.test")),
          [],
        );
      }).pipe(
        Effect.provide(
          installerLayer({
            tarball: tarballForManifest(),
            hosts: {
              "market.test": "93.184.216.34",
              "internal.market.test": "10.0.0.5",
            },
            responses: {
              [tarballUrl]: () =>
                new Response(null, {
                  status: 302,
                  headers: { location: "https://internal.market.test/latest/meta-data" },
                }),
            },
            transportLog,
          }),
        ),
      ),
    );
  },
);

it.effect("PluginInstaller follows tarball redirects to allowed hosts", () => {
  const tarball = tarballForManifest();
  return Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      yield* seedSource;

      const staged = yield* installer.beginInstall({ sourceId, pluginId, version: "1.0.0" });

      assert.equal(staged.manifest.id, pluginId);
    }).pipe(
      Effect.provide(
        installerLayer({
          tarball,
          hosts: {
            "market.test": "93.184.216.34",
            "cdn.market.test": "203.0.114.7",
          },
          responses: {
            [tarballUrl]: () =>
              new Response(null, {
                status: 302,
                headers: { location: "https://cdn.market.test/test-plugin-1.0.0.tgz" },
              }),
            "https://cdn.market.test/test-plugin-1.0.0.tgz": () => new Response(tarball),
          },
        }),
      ),
    ),
  );
});

it.effect("PluginInstaller confirmInstall re-checks id collisions under the lockfile writer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      const store = yield* PluginLockfileStore;
      yield* seedSource;

      const staged = yield* installer.beginInstall({ sourceId, pluginId, version: "1.0.0" });
      // Simulate a concurrent install committing an entry between this flow's
      // begin (which validated against a lockfile snapshot) and its confirm.
      yield* store.updatePlugin(pluginId, () =>
        Effect.succeed({
          version: "2.0.0",
          sha256: "concurrent",
          sourceId,
          enabled: true,
          state: "active" as const,
          activation: { activatingSince: null, crashCount: 0 },
          installedAt: "2026-07-03T00:00:00.000Z",
          lastError: null,
        }),
      );

      const result = yield* Effect.result(installer.confirmInstall(staged.stageToken));

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.code, "manifest-invalid");
      // The concurrently-committed entry must be left untouched.
      const lockfile = yield* store.readLockfile;
      assert.equal(lockfile.plugins[pluginId]?.version, "2.0.0");
      assert.equal(lockfile.plugins[pluginId]?.sha256, "concurrent");
    }).pipe(Effect.provide(installerLayer({ tarball: tarballForManifest() }))),
  ),
);

it.effect("PluginInstaller confirmInstall cannot clobber a concurrent same-version install", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      const store = yield* PluginLockfileStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* seedSource;

      const staged = yield* installer.beginInstall({ sourceId, pluginId, version: "1.0.0" });

      // A concurrent install of the SAME id+version wins the race: its entry is in
      // the lockfile and its files occupy the version directory. The sentinel stands
      // in for those files.
      const versionDir = pluginVersionDir(config.pluginsDir, pluginId, "1.0.0", path.join);
      yield* fs.makeDirectory(versionDir, { recursive: true });
      yield* fs.writeFileString(path.join(versionDir, "winner.txt"), "committed by the winner");
      yield* store.updatePlugin(pluginId, () =>
        Effect.succeed({
          version: "1.0.0",
          sha256: "winner-sha",
          sourceId,
          enabled: true,
          state: "active" as const,
          activation: { activatingSince: null, crashCount: 0 },
          installedAt: "2026-07-03T00:00:00.000Z",
          lastError: null,
        }),
      );

      const result = yield* Effect.result(installer.confirmInstall(staged.stageToken));

      assert.isTrue(Result.isFailure(result), "the losing confirm must fail the collision check");
      // The half the lockfile assertion cannot see: before the destructive move ran
      // under the lockfile writer, the loser REPLACED the winner's committed files
      // with its own rejected archive and only then failed — leaving disk contents
      // that no longer matched the sha256 the lockfile records. The winner's files
      // must survive the loser losing.
      assert.isTrue(
        yield* fs.exists(path.join(versionDir, "winner.txt")),
        "the losing confirm must not have touched the winner's version directory",
      );
      const lockfile = yield* store.readLockfile;
      assert.equal(lockfile.plugins[pluginId]?.sha256, "winner-sha");
    }).pipe(Effect.provide(installerLayer({ tarball: tarballForManifest() }))),
  ),
);

it.effect("PluginInstaller fails typed, not as a defect, when the plugin is missing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      yield* seedSource;

      // `installedEntry` used to THROW inside an Effect body — a defect that bypassed
      // every mapError. Effect.result only captures typed failures, so before the fix
      // this test DIED instead of returning a Failure.
      const result = yield* Effect.result(
        installer.setEnabled({ pluginId: PluginId.make("never-installed"), enabled: true }),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.code, "plugin-not-found");
    }).pipe(Effect.provide(installerLayer({ tarball: tarballForManifest() }))),
  ),
);

it.effect("PluginInstaller checkUpdates does not offer prereleases to stable installs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      const store = yield* PluginLockfileStore;
      yield* seedSource;
      yield* store.updatePlugin(pluginId, () =>
        Effect.succeed({
          version: "1.0.0",
          sha256: "installed",
          sourceId,
          enabled: true,
          state: "active" as const,
          activation: { activatingSince: null, crashCount: 0 },
          installedAt: "2026-07-03T00:00:00.000Z",
          lastError: null,
        }),
      );

      const { updates } = yield* installer.checkUpdates;

      assert.deepEqual(updates, []);
    }).pipe(
      Effect.provide(
        installerLayer({
          tarball: tarballForManifest(),
          marketplaceVersions: ["1.0.0", "1.1.0-rc.1"],
        }),
      ),
    ),
  ),
);

it.effect("PluginInstaller checkUpdates offers prereleases to prerelease installs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      const store = yield* PluginLockfileStore;
      yield* seedSource;
      yield* store.updatePlugin(pluginId, () =>
        Effect.succeed({
          version: "1.1.0-rc.1",
          sha256: "installed",
          sourceId,
          enabled: true,
          state: "active" as const,
          activation: { activatingSince: null, crashCount: 0 },
          installedAt: "2026-07-03T00:00:00.000Z",
          lastError: null,
        }),
      );

      const { updates } = yield* installer.checkUpdates;

      assert.equal(updates.length, 1);
      assert.equal(updates[0]?.latestVersion, "1.1.0-rc.2");
    }).pipe(
      Effect.provide(
        installerLayer({
          tarball: tarballForManifest(),
          marketplaceVersions: ["1.0.0", "1.1.0-rc.1", "1.1.0-rc.2"],
        }),
      ),
    ),
  ),
);

it.effect("PluginInstaller cleanup tolerates staging directories that cannot be removed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* seedSource;

      const staged = yield* installer.beginInstall({ sourceId, pluginId, version: "1.0.0" });
      const stagingDir = path.join(config.pluginsDir, ".staging", staged.stageToken);
      // Strip write permission so the expired dir's entries cannot be
      // unlinked, then trigger cleanupExpired via a fresh beginInstall: the
      // stuck dir must not fail the new staging operation.
      yield* fs.chmod(stagingDir, 0o500);
      yield* TestClock.adjust("16 minutes");
      const result = yield* Effect.result(
        installer.beginInstall({ sourceId, pluginId, version: "1.0.0" }),
      );
      yield* fs.chmod(stagingDir, 0o700).pipe(Effect.ignore);

      assert.isTrue(Result.isSuccess(result));
    }).pipe(Effect.provide(installerLayer({ tarball: tarballForManifest() }))),
  ),
);

it.effect("PluginInstaller startup sweep reaps orphaned staging directories", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // An orphan left by an interrupt between mkdir and the StageRecord being
      // recorded (or by a failed cleanup removal) is unreachable by design —
      // stage records are in-memory only — so construction must reap it.
      const orphan = path.join(config.pluginsDir, ".staging", "orphan");
      yield* fs.makeDirectory(orphan, { recursive: true });

      yield* PluginInstallerModule.make();

      assert.isFalse(yield* fs.exists(orphan));
    }).pipe(Effect.provide(installerDeps({ tarball: tarballForManifest() }))),
  ),
);

it.effect("PluginInstaller cleans staging when decompression fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* seedSource;

      const result = yield* Effect.result(
        installer.beginInstall({ sourceId, pluginId, version: "1.0.0" }),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.code, "extract-failed");

      // The staging dir is created before decompression; a decompress failure
      // (gzip-bomb cap) must clean it up rather than orphan it under .staging.
      const stagingRoot = path.join(config.pluginsDir, ".staging");
      const exists = yield* fs.exists(stagingRoot).pipe(Effect.orElseSucceed(() => false));
      const entries = exists ? yield* fs.readDirectory(stagingRoot) : [];
      assert.deepEqual(entries, []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          installerLayer({
            tarball: NodeZlib.gzipSync(
              tarballForManifestJson(encodeManifestJson(manifest()), [
                { name: "assets/repeated.bin", body: new Uint8Array(1024 * 1024) },
              ]),
            ),
          }),
          NodeServices.layer,
        ),
      ),
    ),
  ),
);

it.effect(
  "PluginInstaller confirmUpgrade rejects a second confirm while an upgrade is pending",
  () => {
    // Two upgrades staged from the SAME installed version (v1→v2 and v1→v3). Both
    // pass installedEntry — the version never changes during pending-upgrade — so
    // without the guard the second confirm's last-writer-wins overwrite of
    // `staged`/state would orphan the first confirm's already-moved version dir.
    const tarballV2 = tarballForManifest(manifest({ version: "2.0.0" }));
    const tarballV3 = tarballForManifest(manifest({ version: "3.0.0" }));
    const urlV2 = "https://market.test/test-plugin-2.0.0.tgz";
    const urlV3 = "https://market.test/test-plugin-3.0.0.tgz";
    const customMarketplace = {
      plugins: [
        {
          id: pluginId,
          name: "Test Plugin",
          description: "Adds tests.",
          capabilities: ["agents" as const],
          versions: [
            {
              version: "2.0.0",
              tarball: urlV2,
              sha256: sha256(tarballV2),
              hostApi: "^1.0.0",
              publishedAt: "2026-07-03T00:00:00.000Z",
            },
            {
              version: "3.0.0",
              tarball: urlV3,
              sha256: sha256(tarballV3),
              hostApi: "^1.0.0",
              publishedAt: "2026-07-03T00:00:00.000Z",
            },
          ],
        },
      ],
    };
    return Effect.scoped(
      Effect.gen(function* () {
        const installer = yield* PluginInstaller;
        const store = yield* PluginLockfileStore;
        yield* seedSource;
        yield* store.updatePlugin(pluginId, () =>
          Effect.succeed({
            version: "1.0.0",
            sha256: "installed",
            sourceId,
            enabled: true,
            state: "active" as const,
            activation: { activatingSince: null, crashCount: 0 },
            installedAt: "2026-07-03T00:00:00.000Z",
            lastError: null,
          }),
        );

        const stagedV2 = yield* installer.beginUpgrade({ pluginId, version: "2.0.0" });
        const stagedV3 = yield* installer.beginUpgrade({ pluginId, version: "3.0.0" });

        yield* installer.confirmUpgrade(stagedV2.stageToken);
        const second = yield* Effect.result(installer.confirmUpgrade(stagedV3.stageToken));

        assert.isTrue(Result.isFailure(second), "the second confirm must be rejected");
        if (Result.isFailure(second)) assert.equal(second.failure.code, "manifest-invalid");
        // The first confirm's staged version must survive the rejected second confirm.
        const lockfile = yield* store.readLockfile;
        assert.equal(lockfile.plugins[pluginId]?.state, "pending-upgrade");
        assert.equal(lockfile.plugins[pluginId]?.staged?.version, "2.0.0");
      }).pipe(
        Effect.provide(
          installerLayer({
            tarball: tarballForManifest(),
            responses: {
              "https://market.test/marketplace.json": () =>
                new Response(encodeMarketplaceJson(customMarketplace), {
                  headers: { "content-type": "application/json" },
                }),
              [urlV2]: () => new Response(tarballV2),
              [urlV3]: () => new Response(tarballV3),
            },
          }),
        ),
      ),
    );
  },
);

it.effect("PluginInstaller setEnabled(true) rejects a plugin pending removal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      const store = yield* PluginLockfileStore;
      yield* seedSource;
      // Mid-uninstall: the entry is already pending-remove. A late enable must not
      // resurrect it into an active/enabled entry the reconcile still deletes.
      yield* store.updatePlugin(pluginId, () =>
        Effect.succeed({
          version: "1.0.0",
          sha256: "installed",
          sourceId,
          enabled: false,
          state: "pending-remove" as const,
          activation: { activatingSince: null, crashCount: 0 },
          installedAt: "2026-07-03T00:00:00.000Z",
          lastError: null,
        }),
      );

      const result = yield* Effect.result(installer.setEnabled({ pluginId, enabled: true }));

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.code, "manifest-invalid");
      const lockfile = yield* store.readLockfile;
      assert.equal(lockfile.plugins[pluginId]?.state, "pending-remove");
    }).pipe(Effect.provide(installerLayer({ tarball: tarballForManifest() }))),
  ),
);

it.effect(
  "PluginInstaller uninstall and a concurrent setEnabled(true) cannot strand the plugin",
  () => {
    const activated: Array<string> = [];
    const deactivated: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const installer = yield* PluginInstaller;
        const store = yield* PluginLockfileStore;
        yield* seedSource;
        yield* store.updatePlugin(pluginId, () =>
          Effect.succeed({
            version: "1.0.0",
            sha256: "installed",
            sourceId,
            enabled: true,
            state: "active" as const,
            activation: { activatingSince: null, crashCount: 0 },
            installedAt: "2026-07-03T00:00:00.000Z",
            lastError: null,
          }),
        );

        // Routing uninstall's pending-remove write through host.setPluginEnabled
        // makes persist+teardown atomic with any concurrent enable. Whatever the
        // interleaving, the lockfile and the runtime must agree: no active/enabled
        // entry with the runtime already torn down.
        yield* Effect.all(
          [
            Effect.result(installer.uninstall({ pluginId, removeData: true })),
            Effect.result(installer.setEnabled({ pluginId, enabled: true })),
          ],
          { concurrency: "unbounded" },
        );

        const lockfile = yield* store.readLockfile;
        assert.equal(lockfile.plugins[pluginId]?.state, "pending-remove");
        assert.equal(lockfile.plugins[pluginId]?.enabled, false);
        // The uninstall tore the runtime down; a late enable must not have left it
        // resurrected.
        assert.include(deactivated, pluginId);
      }).pipe(
        Effect.provide(installerLayer({ tarball: tarballForManifest(), activated, deactivated })),
      ),
    );
  },
);

it.effect("PluginInstaller confirmInstall rejects a source removed before confirm", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      const store = yield* PluginLockfileStore;
      yield* seedSource;

      const staged = yield* installer.beginInstall({ sourceId, pluginId, version: "1.0.0" });
      // The source is removed in the begin→confirm window. removeSource's in-use
      // check saw no committed plugin (the stage is in-memory only), so it
      // succeeded — leaving this confirm about to commit a dangling sourceId.
      yield* store.updateSources(() => Effect.succeed([]));

      const result = yield* Effect.result(installer.confirmInstall(staged.stageToken));

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.code, "source-not-found");
      // No entry may be written for a source that no longer exists.
      const lockfile = yield* store.readLockfile;
      assert.isUndefined(lockfile.plugins[pluginId]);
    }).pipe(Effect.provide(installerLayer({ tarball: tarballForManifest() }))),
  ),
);

// A mutable holder shared between the test body and a FileSystem wrapper, letting
// the test PARK a confirm exactly inside the move+commit region: once armed, the
// wrapper suspends the rename that puts the lockfile into place (destination ends
// with `plugins.json`) — which only happens AFTER moveStagingToVersionDir has
// already renamed the staging dir onto the version dir — signalling `reached` and
// waiting on `proceed`. So while parked, the files are moved but the lockfile
// entry is not yet written: the exact interruption window FIX 1 must make atomic.
interface RegionLatch {
  armed: boolean;
  reached: Deferred.Deferred<void> | null;
  proceed: Deferred.Deferred<void> | null;
}

const parkAtLockfileCommitFileSystem =
  (latch: RegionLatch) =>
  (base: FileSystem.FileSystem): FileSystem.FileSystem => ({
    ...base,
    rename: (oldPath, newPath) => {
      const reached = latch.reached;
      const proceed = latch.proceed;
      return latch.armed && reached && proceed && newPath.endsWith("plugins.json")
        ? Effect.gen(function* () {
            latch.armed = false;
            yield* Deferred.succeed(reached, void 0);
            yield* Deferred.await(proceed);
            return yield* base.rename(oldPath, newPath);
          })
        : base.rename(oldPath, newPath);
    },
  });

const parkAtLockfileCommitPlatform = (latch: RegionLatch) =>
  Layer.effect(
    FileSystem.FileSystem,
    FileSystem.FileSystem.pipe(Effect.map(parkAtLockfileCommitFileSystem(latch))),
  ).pipe(Layer.provideMerge(NodeServices.layer)) as typeof NodeServices.layer;

it.effect(
  "PluginInstaller confirmInstall commits atomically when interrupted mid move+commit region",
  () => {
    const latch: RegionLatch = { armed: false, reached: null, proceed: null };
    return Effect.scoped(
      Effect.gen(function* () {
        const installer = yield* PluginInstaller;
        const store = yield* PluginLockfileStore;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        yield* seedSource;

        const staged = yield* installer.beginInstall({ sourceId, pluginId, version: "1.0.0" });

        latch.reached = yield* Deferred.make<void>();
        latch.proceed = yield* Deferred.make<void>();
        latch.armed = true;

        const child = yield* Effect.forkChild(installer.confirmInstall(staged.stageToken), {
          startImmediately: true,
        });
        // Wait until the confirm has moved the staging dir onto the version dir and
        // is parked at the lockfile commit — i.e. INSIDE the move+commit region.
        yield* Deferred.await(latch.reached);
        // Request interruption while parked in the region. Send it SYNCHRONOUSLY
        // (before releasing the park) so that, without the fix, it is guaranteed to
        // abort the interruptible park BEFORE the lockfile rename. Effect.uninterruptible
        // (FIX 1) makes the park uninterruptible: the interrupt is recorded as
        // pending and applies only AFTER the region commits. Without it, the
        // interrupt strands the install — version dir on disk, no lockfile entry,
        // and a stage pointing at a staging dir the move already consumed.
        yield* Effect.sync(() => child.interruptUnsafe());
        yield* Deferred.succeed(latch.proceed, void 0);
        yield* Fiber.awaitAll([child]);

        // The region committed atomically despite the interrupt: the lockfile entry
        // is present AND the moved files are in place. (The interrupt still takes
        // effect after the region, so activation is skipped — but the durable
        // install state is intact, i.e. not stranded.)
        const lockfile = yield* store.readLockfile;
        assert.equal(lockfile.plugins[pluginId]?.state, "active");
        assert.equal(lockfile.plugins[pluginId]?.version, "1.0.0");
        assert.equal(lockfile.plugins[pluginId]?.sha256, sha256(tarballForManifest()));
        const versionDir = pluginVersionDir(config.pluginsDir, pluginId, "1.0.0", path.join);
        assert.isTrue(
          yield* fs.exists(path.join(versionDir, "manifest.json")),
          "the moved plugin files must remain in the version directory",
        );
      }).pipe(
        Effect.provide(
          installerLayer({ tarball: tarballForManifest() }, parkAtLockfileCommitPlatform(latch)),
        ),
      ),
    );
  },
);

// A tarball endpoint that answers but then drips (or never sends) the body must
// not hold an install open past the wall-clock deadline. The transport
// `timeoutMs` only bounds socket inactivity, so the pipeline-level
// Effect.timeoutOrElse is what bounds this. Driven under TestClock so the real
// DOWNLOAD_TIMEOUT_MS (120s) constant is exercised deterministically. The clock
// is only advanced once the tarball has actually been requested — by then the
// deadline is armed (timeoutOrElse registers its sleep before the transport
// call) and the preceding marketplace fetch has already completed, so only the
// download deadline is pending.
it.effect("PluginInstaller download times out when the tarball body never completes", () => {
  let signalRequested = () => {};
  const tarballRequested = new Promise<void>((resolve) => {
    signalRequested = resolve;
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const installer = yield* PluginInstaller;
      yield* seedSource;

      const child = yield* Effect.forkChild(
        Effect.result(installer.beginInstall({ sourceId, pluginId, version: "1.0.0" })),
        { startImmediately: true },
      );
      yield* Effect.promise(() => tarballRequested);
      yield* TestClock.adjust("120 seconds");
      const result = yield* Fiber.join(child);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(result.failure.code, "download-failed");
        assert.include(result.failure.message, "time limit");
      }
    }).pipe(
      Effect.provide(
        installerLayer({
          tarball: tarballForManifest(),
          responses: {
            [tarballUrl]: () => {
              signalRequested();
              return neverEndingResponse();
            },
          },
        }),
      ),
    ),
  );
});
