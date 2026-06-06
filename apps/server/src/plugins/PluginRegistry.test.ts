import {
  PluginCommandName,
  PluginId,
  PluginKeybindingCommandName,
  PluginRouteId,
  PluginUiPlacementId,
  type PluginCatalogEntry,
  type PluginManifest,
} from "@t3tools/contracts";
import type {
  FailedPluginDiscovery,
  FailedServerPlugin,
  LoadedServerPlugin,
} from "@t3tools/plugin-api/package";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { pluginClientAssetUrl } from "./PluginAssets.ts";
import { PluginRegistry, PluginRegistryLive } from "./PluginRegistry.ts";

const layer = it.layer(PluginRegistryLive);

const pluginId = PluginId.make("t3.registry-test");
const routeId = PluginRouteId.make("main");
const placementId = PluginUiPlacementId.make("main-sidebar");
const command = PluginCommandName.make("registry.echo");
const clientCommand = PluginKeybindingCommandName.make("registryClient");
type ManifestCatalogEntry = Extract<PluginCatalogEntry, { readonly manifest: unknown }>;
type DiscoveryCatalogEntry = Extract<PluginCatalogEntry, { readonly discovery: unknown }>;
const neverComplete = Effect.promise<never>(() => new Promise<never>(() => {}));

const beginTestActivation = (registry: PluginRegistry["Service"], plugin: LoadedServerPlugin) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    return yield* registry.beginActivation(plugin, scope);
  });

function hasManifestCatalogEntry(entry: PluginCatalogEntry): entry is ManifestCatalogEntry {
  return "manifest" in entry;
}

function hasDiscoveryCatalogEntry(entry: PluginCatalogEntry): entry is DiscoveryCatalogEntry {
  return "discovery" in entry;
}

function requireManifestCatalogEntry(entry: PluginCatalogEntry | undefined): ManifestCatalogEntry {
  assert.isDefined(entry);
  if (!hasManifestCatalogEntry(entry)) {
    throw new Error("Expected a manifest-backed plugin catalog entry.");
  }
  return entry;
}

const manifest: PluginManifest = {
  id: pluginId,
  name: "Registry Test",
  version: "0.1.0",
  routes: [{ id: routeId, label: "Registry Test", surface: "app" }],
  ui: {
    placements: [
      {
        id: placementId,
        position: "sidebar.primary",
        label: "Registry Test",
        routeId,
      },
    ],
  },
  commands: [
    { name: command, target: "server", label: "Echo" },
    { name: clientCommand, target: "client", label: "Client Action", keybinding: true },
  ],
};

const loadedPlugin: LoadedServerPlugin = {
  manifest,
  descriptor: {
    pluginId,
    packageName: "@t3tools/plugin-registry-test",
    packageVersion: "0.1.0",
    packageRoot: "/tmp/t3-registry-test",
    apiVersion: "0.0.24",
    manifestPath: "/tmp/t3-registry-test/manifest.json",
    serverEntryPath: "/tmp/t3-registry-test/server.js",
    clientEntryPath: "/tmp/t3-registry-test/client.iife.js",
  },
  serverPlugin: {
    manifest,
    activate: () => Effect.void,
  },
};

const failedPlugin: FailedServerPlugin = {
  descriptor: {
    ...loadedPlugin.descriptor,
    pluginId: PluginId.make("t3.failed-registry-test"),
    packageName: "@t3tools/plugin-failed-registry-test",
    packageRoot: "/tmp/t3-failed-registry-test",
  },
  manifest: {
    ...manifest,
    id: PluginId.make("t3.failed-registry-test"),
    name: "Failed Registry Test",
  },
};

const failedDiscovery: FailedPluginDiscovery = {
  discovery: {
    pluginId: PluginId.make("t3.failed-discovery-registry-test"),
    packageName: "@t3tools/plugin-failed-discovery-registry-test",
    packageVersion: "0.1.0",
    packageRoot: "/tmp/t3-failed-discovery-registry-test",
  },
};

const packageRootOnlyFailedDiscovery: FailedPluginDiscovery = {
  discovery: {
    packageRoot: loadedPlugin.descriptor.packageRoot,
  },
};

layer("PluginRegistry", (it) => {
  it.effect("maps active plugin metadata into catalog entries and validates command I/O", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;

      const activation = yield* beginTestActivation(registry, loadedPlugin);
      yield* activation.setPlacementBadgeProvider(placementId, () => Effect.succeed(2));
      yield* activation.registerCommand(command, {
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        handler: (input) => Effect.succeed({ text: input.text.toUpperCase() }),
      });
      yield* activation.commitActive;

      const catalog = yield* registry.listCatalog;
      assert.equal(catalog.length, 1);
      const entry = requireManifestCatalogEntry(catalog[0]);
      assert.equal(entry.manifest.id, pluginId);
      assert.equal(entry.manifest.ui.placements[0]?.badgeCount, 2);
      assert.equal(entry.assets.client, pluginClientAssetUrl(pluginId));

      const output = yield* registry.invoke(pluginId, command, {
        text: "ok",
      });
      assert.deepEqual(output, { text: "OK" });

      const invalidInput = yield* Effect.result(registry.invoke(pluginId, command, { text: 12 }));
      assert.equal(invalidInput._tag, "Failure");
      if (invalidInput._tag === "Failure") {
        assert.equal(invalidInput.failure._tag, "PluginRpcError");
        assert.equal(invalidInput.failure.command, command);
      }
    }),
  );

  it.effect("clears command and badge contributions when a plugin fails", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;

      const activation = yield* beginTestActivation(registry, loadedPlugin);
      yield* activation.setPlacementBadgeProvider(placementId, () => Effect.succeed(7));
      yield* activation.registerCommand(command, {
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        handler: (input) => Effect.succeed({ text: input.text }),
      });
      yield* activation.commitActive;

      yield* registry.registerFailedPlugin(loadedPlugin, "activation failed");

      const catalog = yield* registry.listCatalog;
      const entry = requireManifestCatalogEntry(catalog[0]);
      assert.equal(entry.status.status, "failed");
      assert.isUndefined(entry.manifest.ui.placements[0]?.badgeCount);

      const invokeResult = yield* Effect.result(registry.invoke(pluginId, command, { text: "ok" }));
      assert.equal(invokeResult._tag, "Failure");
    }),
  );

  it.effect("interrupts in-flight command invocations when the activation scope closes", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      const scope = yield* Scope.make("sequential");
      const started = yield* Deferred.make<void>();
      const activation = yield* registry.beginActivation(loadedPlugin, scope);
      yield* activation.registerCommand(command, {
        input: Schema.Struct({}),
        output: Schema.Struct({ ok: Schema.Boolean }),
        handler: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(neverComplete)),
      });
      yield* activation.commitActive;

      const fiber = yield* registry.invoke(pluginId, command, {}).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Scope.close(scope, Exit.void);
      const exit = yield* Fiber.await(fiber);

      assert.isTrue(Exit.hasInterrupts(exit));
    }),
  );

  it.effect("interrupts in-flight command invocations when the caller is interrupted", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const activation = yield* beginTestActivation(registry, loadedPlugin);
      yield* activation.registerCommand(command, {
        input: Schema.Struct({}),
        output: Schema.Struct({ ok: Schema.Boolean }),
        handler: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(neverComplete),
            Effect.ensuring(Deferred.succeed(interrupted, undefined)),
          ),
      });
      yield* activation.commitActive;

      const fiber = yield* registry.invoke(pluginId, command, {}).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(interrupted);
    }),
  );

  it.effect("maps failed discovery metadata into catalog entries", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;

      yield* registry.registerFailedPlugin(failedPlugin, "Server entry could not be imported.");

      const catalog = yield* registry.listCatalog;
      const entry = catalog
        .filter(hasManifestCatalogEntry)
        .find((candidate) => candidate.manifest.id === failedPlugin.manifest.id);
      assert.equal(entry?.status.status, "failed");
      assert.include(entry?.status.diagnostics?.[0] ?? "", "could not be imported");
      assert.equal(entry?.assets.client, pluginClientAssetUrl(failedPlugin.manifest.id));
    }),
  );

  it.effect("maps failed package discovery into catalog entries without manifest assets", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;

      yield* registry.registerFailedDiscovery(
        failedDiscovery,
        "Plugin manifest could not be read.",
      );

      const catalog = yield* registry.listCatalog;
      const entry = catalog
        .filter(hasDiscoveryCatalogEntry)
        .find((candidate) => candidate.discovery.pluginId === failedDiscovery.discovery.pluginId);
      assert.isDefined(entry);
      assert.equal(entry.status.status, "failed");
      assert.include(entry.status.diagnostics?.[0] ?? "", "could not be read");
      assert.deepEqual(entry.discovery, failedDiscovery.discovery);
    }),
  );

  it.effect("keeps same-id discovery failures separate by package root", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      const sharedPluginId = PluginId.make("t3.same-id-discovery-test");
      const firstPackageRoot = "/tmp/t3-same-id-discovery-first";
      const secondPackageRoot = "/tmp/t3-same-id-discovery-second";

      yield* registry.registerFailedDiscovery(
        { discovery: { pluginId: sharedPluginId, packageRoot: firstPackageRoot } },
        "First manifest failed.",
      );
      yield* registry.registerFailedDiscovery(
        { discovery: { pluginId: sharedPluginId, packageRoot: secondPackageRoot } },
        "Second manifest failed.",
      );

      const catalog = yield* registry.listCatalog;
      const entries = catalog
        .filter(hasDiscoveryCatalogEntry)
        .filter((entry) => entry.discovery.pluginId === sharedPluginId);
      assert.sameMembers(
        entries.map((entry) => entry.discovery.packageRoot),
        [firstPackageRoot, secondPackageRoot],
      );
    }),
  );

  it.effect("clears package-root discovery failures when the package later registers", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;

      yield* registry.registerFailedDiscovery(
        packageRootOnlyFailedDiscovery,
        "Plugin package.json could not be read.",
      );
      const activation = yield* beginTestActivation(registry, loadedPlugin);
      yield* activation.commitActive;

      const catalog = yield* registry.listCatalog;
      assert.isUndefined(
        catalog
          .filter(hasDiscoveryCatalogEntry)
          .find((entry) => entry.discovery.packageRoot === loadedPlugin.descriptor.packageRoot),
      );
      assert.isDefined(
        catalog.filter(hasManifestCatalogEntry).find((entry) => entry.manifest.id === pluginId),
      );
    }),
  );

  it.effect(
    "clears same-plugin-id discovery failures when a manifest-backed package registers",
    () =>
      Effect.gen(function* () {
        const registry = yield* PluginRegistry;

        yield* registry.registerFailedDiscovery(
          { discovery: { pluginId, packageRoot: "/tmp/t3-registry-test-old-root" } },
          "Old root failed.",
        );
        yield* registry.registerFailedDiscovery(
          { discovery: { pluginId, packageRoot: "/tmp/t3-registry-test-new-root" } },
          "New root failed.",
        );
        const activation = yield* beginTestActivation(registry, loadedPlugin);
        yield* activation.commitActive;

        const catalog = yield* registry.listCatalog;
        assert.isEmpty(
          catalog
            .filter(hasDiscoveryCatalogEntry)
            .filter((entry) => entry.discovery.pluginId === pluginId),
        );
        assert.isDefined(
          catalog.filter(hasManifestCatalogEntry).find((entry) => entry.manifest.id === pluginId),
        );
      }),
  );

  it.effect("clears manifest catalog records when package-root discovery later fails", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;

      const activation = yield* beginTestActivation(registry, loadedPlugin);
      yield* activation.commitActive;
      const displacedPluginIds = yield* registry.registerFailedDiscovery(
        packageRootOnlyFailedDiscovery,
        "Plugin package.json could not be read.",
      );

      const catalog = yield* registry.listCatalog;
      assert.deepEqual(displacedPluginIds, [pluginId]);
      assert.isUndefined(
        catalog.filter(hasManifestCatalogEntry).find((entry) => entry.manifest.id === pluginId),
      );
      assert.isDefined(
        catalog
          .filter(hasDiscoveryCatalogEntry)
          .find((entry) => entry.discovery.packageRoot === loadedPlugin.descriptor.packageRoot),
      );
    }),
  );

  it.effect("rejects non-server manifest commands at registration and invocation", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      const scopedPluginId = PluginId.make("t3.registry-client-command-test");
      const scopedClientCommand = PluginKeybindingCommandName.make("registryClientOnly");
      const scopedManifest: PluginManifest = {
        ...manifest,
        id: scopedPluginId,
        commands: [
          {
            name: scopedClientCommand,
            target: "client",
            label: "Client Action",
            keybinding: true,
          },
        ],
      };
      const scopedLoadedPlugin: LoadedServerPlugin = {
        ...loadedPlugin,
        manifest: scopedManifest,
        descriptor: {
          ...loadedPlugin.descriptor,
          pluginId: scopedPluginId,
        },
        serverPlugin: {
          manifest: scopedManifest,
          activate: () => Effect.void,
        },
      };

      const activation = yield* beginTestActivation(registry, scopedLoadedPlugin);

      const registrationResult = yield* Effect.result(
        activation.registerCommand(scopedClientCommand, {
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          handler: () => Effect.succeed({ ok: true }),
        }),
      );
      assert.equal(registrationResult._tag, "Failure");

      yield* activation.commitActive;

      const invokeResult = yield* Effect.result(
        registry.invoke(scopedPluginId, scopedClientCommand, {}),
      );
      assert.equal(invokeResult._tag, "Failure");
      if (invokeResult._tag === "Failure") {
        assert.include(invokeResult.failure.message, "not declared as a server command");
      }
    }),
  );

  it.effect("normalizes invalid badge provider counts out of catalog entries", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;

      const activation = yield* beginTestActivation(registry, loadedPlugin);
      yield* activation.setPlacementBadgeProvider(placementId, () =>
        Effect.succeed(Number.POSITIVE_INFINITY),
      );
      yield* activation.commitActive;

      const catalog = yield* registry.listCatalog;

      const entry = requireManifestCatalogEntry(catalog[0]);
      assert.isUndefined(entry.manifest.ui.placements[0]?.badgeCount);
    }),
  );

  it.effect("rejects badge providers for undeclared placements", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      const activation = yield* beginTestActivation(registry, loadedPlugin);

      const result = yield* Effect.result(
        activation.setPlacementBadgeProvider(PluginUiPlacementId.make("missing"), () =>
          Effect.succeed(1),
        ),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.include(result.failure.message, "not declared");
      }
    }),
  );
});
