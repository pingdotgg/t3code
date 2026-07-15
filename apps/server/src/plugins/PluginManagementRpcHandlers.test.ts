import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts/plugin";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { fingerprintSettingsSchema } from "@t3tools/contracts/pluginSettings";
import { runMigrations } from "../persistence/Migrations.ts";

import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { PluginHttpClientTransportService } from "./capabilities/HttpClientCapability.ts";
import { OutboundUrlLookup } from "./OutboundUrlValidator.ts";
import { PluginInstaller } from "./PluginInstaller.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { PluginLockfileStore } from "./PluginLockfileStore.ts";
import * as PluginRuntimeRegistryLayer from "./PluginRuntimeRegistry.ts";
import * as PluginSettingsStoreLayer from "./PluginSettingsStore.ts";
import * as PluginLockfileStoreLayer from "./PluginLockfileStore.ts";
import { PluginManagementRpcHandlers } from "./PluginManagementRpcHandlers.ts";
import * as PluginManagementRpcHandlersModule from "./PluginManagementRpcHandlers.ts";
import * as PluginMarketplace from "./PluginMarketplace.ts";

const pluginId = PluginId.make("test-plugin");

const TestOutboundDepsLive = Layer.mergeAll(
  Layer.succeed(OutboundUrlLookup, () =>
    Effect.succeed([{ address: "93.184.216.34", family: 4 as const }]),
  ),
  Layer.succeed(PluginHttpClientTransportService, (request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        HttpClientRequest.get(request.url.toString()),
        new Response("{}", { status: 404 }),
      ),
    ),
  ),
);

const InstallerMockLive = Layer.succeed(
  PluginInstaller,
  PluginInstaller.of({
    beginInstall: () => Effect.die("not used"),
    confirmInstall: () => Effect.die("not used"),
    abortInstall: () => Effect.void,
    setEnabled: () => Effect.void,
    uninstall: () => Effect.void,
    beginUpgrade: () => Effect.die("not used"),
    confirmUpgrade: () => Effect.die("not used"),
    checkUpdates: Effect.succeed({ updates: [] }),
  }),
);

const managementTest = it.layer(
  PluginManagementRpcHandlersModule.layer.pipe(
    Layer.provideMerge(PluginLockfileStoreLayer.layer),
    Layer.provideMerge(PluginRuntimeRegistryLayer.layer),
    Layer.provideMerge(PluginSettingsStoreLayer.layer),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(PluginMarketplace.layer),
    Layer.provideMerge(InstallerMockLive),
    Layer.provideMerge(TestOutboundDepsLive),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-management-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

managementTest("PluginManagementRpcHandlers", (it) => {
  it.effect("dedupes added sources by normalized HTTPS URL", () =>
    Effect.gen(function* () {
      const handlers = yield* PluginManagementRpcHandlers;

      const first = yield* handlers.addSource({
        url: "https://example.test/marketplace.json#ignored",
      });
      const second = yield* handlers.addSource({
        url: "https://example.test/marketplace.json",
      });
      const listed = yield* handlers.listSources;

      assert.equal(first.source.id, second.source.id);
      assert.equal(listed.sources.length, 1);
      assert.equal(listed.sources[0]?.url, "https://example.test/marketplace.json");
    }),
  );

  it.effect("dedupes a re-added source against a stored credentialed row", () =>
    Effect.gen(function* () {
      const handlers = yield* PluginManagementRpcHandlers;
      const store = yield* PluginLockfileStore;
      // Simulate a source persisted before credentials were stripped from the
      // stored URL. Re-adding the same marketplace (now credential-stripped)
      // must reuse this row rather than register a second source.
      yield* store.updateSources((sources) =>
        Effect.succeed([
          ...sources,
          {
            id: "src-legacy",
            url: "https://user:secret@example.test/legacy-marketplace.json",
            addedAt: "2026-07-03T00:00:00.000Z",
          },
        ]),
      );

      const added = yield* handlers.addSource({
        url: "https://user:secret@example.test/legacy-marketplace.json",
      });
      const listed = yield* handlers.listSources;

      assert.equal(added.source.id, "src-legacy");
      assert.equal(
        listed.sources.filter((entry) => entry.url.includes("legacy-marketplace.json")).length,
        1,
      );
      // The stored (previously credentialed) URL is rewritten to its
      // credential-stripped canonical form so it stops leaking via listSources,
      // while the opaque legacy sourceId is preserved.
      assert.equal(added.source.url, "https://example.test/legacy-marketplace.json");
      const legacyEntry = listed.sources.find((entry) => entry.id === "src-legacy");
      assert.equal(legacyEntry?.url, "https://example.test/legacy-marketplace.json");
      assert.isFalse(legacyEntry?.url.includes("secret"));
    }),
  );

  it.effect("rejects non-HTTPS sources", () =>
    Effect.gen(function* () {
      const handlers = yield* PluginManagementRpcHandlers;

      const result = yield* Effect.result(handlers.addSource({ url: "http://example.test" }));

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.code, "invalid-source");
    }),
  );

  it.effect("prevents removing a source used by an installed plugin", () =>
    Effect.gen(function* () {
      const handlers = yield* PluginManagementRpcHandlers;
      const store = yield* PluginLockfileStore;
      const source = yield* handlers.addSource({ url: "https://example.test/marketplace.json" });
      yield* store.updatePlugin(pluginId, () =>
        Effect.succeed({
          version: "1.0.0",
          sha256: "sha",
          sourceId: source.source.id,
          enabled: true,
          state: "active",
          activation: { activatingSince: null, crashCount: 0 },
          installedAt: "2026-07-03T00:00:00.000Z",
          lastError: null,
        }),
      );

      const result = yield* Effect.result(handlers.removeSource({ sourceId: source.source.id }));

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.code, "invalid-source");
    }),
  );

  it.effect("removes an unused source and reports missing sources", () =>
    Effect.gen(function* () {
      const handlers = yield* PluginManagementRpcHandlers;
      // Unique URL so no plugin installed by a sibling test references it.
      const source = yield* handlers.addSource({
        url: "https://example.test/removable-marketplace.json",
      });

      yield* handlers.removeSource({ sourceId: source.source.id });
      const listed = yield* handlers.listSources;
      assert.isFalse(listed.sources.some((entry) => entry.id === source.source.id));

      const missing = yield* Effect.result(handlers.removeSource({ sourceId: "src-missing" }));
      assert.isTrue(Result.isFailure(missing));
      if (Result.isFailure(missing)) assert.equal(missing.failure.code, "source-not-found");
    }),
  );
});

// Handler-level settings tests. Sol's review found ZERO behavioural tests on this
// path: the store tests feed already-encoded objects straight to the store, so they
// cannot detect deleting the handler's decode/re-encode or its unknown-key stripping.
managementTest("PluginManagementRpcHandlers settings", (it) => {
  const schema = Schema.Struct({
    baseUrl: Schema.String,
    shout: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  });

  const putRuntime = (id: PluginId, settings: { readonly schema: typeof schema } | undefined) =>
    Effect.gen(function* () {
      const registry = yield* PluginRuntimeRegistryLayer.PluginRuntimeRegistry;
      const scope = yield* Scope.make("sequential");
      yield* registry.put(id, {
        manifest: {
          id,
          name: "Fixture",
          version: "1.0.0",
          hostApi: "^1.0.0",
          capabilities: ["settings"],
          entries: { server: "server/index.js" },
        } as never,
        registration: {},
        settings: settings as never,
        readiness: yield* Deferred.make<void>(),
        scope,
      });
    });

  it.effect("reports declared: false for a plugin with no settings schema", () =>
    Effect.gen(function* () {
      const id = PluginId.make("mgmt-nosettings");
      const handlers = yield* PluginManagementRpcHandlers;
      yield* runMigrations({});
      yield* putRuntime(id, undefined);

      const result = yield* handlers.settingsGet({ pluginId: id });
      assert.equal(result.declared, false);
    }),
  );

  // The repair deadlock: a plugin that reads its settings in register() fails
  // activation when the stored row is unreadable, so no runtime is ever put. If the
  // RPC resolved the schema only from live runtimes it would report "no settings
  // declared" and hide the form needed to fix the very values that broke activation.
  it.effect("still reports settings as declared when the plugin failed to activate", () =>
    Effect.gen(function* () {
      const id = PluginId.make("mgmt-neveractivated");
      const handlers = yield* PluginManagementRpcHandlers;
      const settingsStore = yield* PluginSettingsStoreLayer.PluginSettingsStore;
      yield* runMigrations({});

      // Declared at module load; register() then failed, so there is NO runtime.
      yield* settingsStore.noteDeclaredSchema(id, schema as never);

      const result = yield* handlers.settingsGet({ pluginId: id });
      assert.equal(result.declared, true, "the repair form must still be reachable");
    }),
  );

  it.effect(
    "accepts a write for a plugin that failed to activate, so settings can be repaired",
    () =>
      Effect.gen(function* () {
        const id = PluginId.make("mgmt-repair");
        const handlers = yield* PluginManagementRpcHandlers;
        const settingsStore = yield* PluginSettingsStoreLayer.PluginSettingsStore;
        yield* runMigrations({});
        yield* settingsStore.noteDeclaredSchema(id, schema as never);

        const revision = yield* handlers.settingsSet({
          pluginId: id,
          values: { baseUrl: "https://repaired.example" },
          expectedRevision: 0,
        });
        assert.equal(revision.revision, 1, "repair must be possible without a live runtime");
      }),
  );

  it.effect("rejects a write for a plugin that declares no settings", () =>
    Effect.gen(function* () {
      const id = PluginId.make("mgmt-nosettings-write");
      const handlers = yield* PluginManagementRpcHandlers;
      yield* runMigrations({});
      yield* putRuntime(id, undefined);

      const result = yield* Effect.result(
        handlers.settingsSet({ pluginId: id, values: { baseUrl: "x" }, expectedRevision: 0 }),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.code, "settings-not-declared");
    }),
  );

  it.effect("rejects a write whose values do not decode", () =>
    Effect.gen(function* () {
      const id = PluginId.make("mgmt-baddecode");
      const handlers = yield* PluginManagementRpcHandlers;
      yield* runMigrations({});
      yield* putRuntime(id, { schema });

      const result = yield* Effect.result(
        handlers.settingsSet({ pluginId: id, values: { baseUrl: 42 }, expectedRevision: 0 }),
      );
      assert.isTrue(Result.isFailure(result), "the client is not trusted");
      if (Result.isFailure(result)) assert.equal(result.failure.code, "settings-invalid");
    }),
  );

  // The guarantee must be the HOST's: a plugin can annotate its schema with
  // onExcessProperty:"preserve" and carry arbitrary client keys through decode and
  // re-encode. Filtering to declared field keys is what actually stops it.
  it.effect("never persists a key the schema does not declare", () =>
    Effect.gen(function* () {
      const id = PluginId.make("mgmt-unknownkey");
      const handlers = yield* PluginManagementRpcHandlers;
      yield* runMigrations({});
      // MUST use a preserve-annotated schema. A plain Schema.Struct already strips
      // excess properties on decode, so testing with one asserts nothing about the
      // host's stripping — the first version of this test passed with the stripping
      // deleted. `parseOptions` is a schema ANNOTATION, i.e. plugin-controlled,
      // which is exactly why the guarantee cannot live in decode.
      const preserveSchema = Schema.Struct({
        baseUrl: Schema.String,
      }).pipe(Schema.annotate({ parseOptions: { onExcessProperty: "preserve" } }));
      yield* putRuntime(id, { schema: preserveSchema as never });

      yield* handlers.settingsSet({
        pluginId: id,
        values: { baseUrl: "https://example.com", injected: "should-not-persist" },
        expectedRevision: 0,
      });

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly values_json: string }>`
        SELECT values_json FROM plugin_settings WHERE plugin_id = ${id}
      `;
      assert.notInclude(rows[0]!.values_json, "injected");
      assert.notInclude(rows[0]!.values_json, "should-not-persist");
    }),
  );

  it.effect("maps a stale expectedRevision to settings-conflict", () =>
    Effect.gen(function* () {
      const id = PluginId.make("mgmt-conflict");
      const handlers = yield* PluginManagementRpcHandlers;
      yield* runMigrations({});
      yield* putRuntime(id, { schema });

      yield* handlers.settingsSet({
        pluginId: id,
        values: { baseUrl: "first" },
        expectedRevision: 0,
      });
      const stale = yield* Effect.result(
        handlers.settingsSet({ pluginId: id, values: { baseUrl: "stale" }, expectedRevision: 0 }),
      );
      assert.isTrue(Result.isFailure(stale));
      if (Result.isFailure(stale)) assert.equal(stale.failure.code, "settings-conflict");
    }),
  );

  // A row can carry the CURRENT fingerprint and still be invalid; reporting
  // incompatible:false for it tells the form all is well while the plugin's own
  // read fails.
  it.effect("reports incompatible for a current-fingerprint row that does not decode", () =>
    Effect.gen(function* () {
      const id = PluginId.make("mgmt-baddata");
      const handlers = yield* PluginManagementRpcHandlers;
      const store = yield* PluginSettingsStoreLayer.PluginSettingsStore;
      yield* runMigrations({});
      yield* putRuntime(id, { schema });

      yield* store.write({
        pluginId: id,
        values: { baseUrl: 42 },
        schemaFingerprint: fingerprintSettingsSchema(schema as never),
        expectedRevision: 0,
      });

      const result = yield* handlers.settingsGet({ pluginId: id });
      assert.equal(result.incompatible, true);
    }),
  );
});
