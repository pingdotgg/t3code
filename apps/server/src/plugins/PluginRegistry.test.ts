import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PLUGIN_SOURCE_PLUGINS_DIR,
  PluginCommandName,
  PluginId,
  PluginSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  PLUGIN_ROUTE_PREFIX,
  addSource,
  createPlugin,
  deletePlugin,
  issuePluginViewUrl,
  invokePlugin,
  listPluginsRpc,
  removeSource,
  resolvePluginAsset,
  setPluginEnabled,
} from "./PluginRegistry.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-plugin-registry-test-",
});
const testLayer = Layer.mergeAll(
  configLayer,
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));
const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
const encodeUnknownJson = Schema.encodeSync(UnknownJsonString);
const decodeUnknownJson = Schema.decodeUnknownSync(UnknownJsonString);
const SOURCES_DIR_NAME = ".sources";

/** Writes a minimal valid plugin package at an arbitrary absolute directory. */
const seedPluginPackage = (
  directory: string,
  plugin: { readonly id: string; readonly name: string },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.join(directory, "dist"), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(directory, "t3-plugin.json"),
      encodeUnknownJson({
        schemaVersion: 1,
        id: plugin.id,
        name: plugin.name,
        commands: [{ name: "home", title: "Home", entry: "dist/home.html" }],
      }),
    );
    yield* fileSystem.writeFileString(
      path.join(directory, "dist", "home.html"),
      "<!doctype html><title>source plugin</title>",
    );
    return directory;
  });

/**
 * Builds a source repository on disk exactly as a clone would look, so tests
 * never hit the network.
 */
const seedSource = (options: {
  readonly sourceId: string;
  readonly gitUrl?: string;
  readonly gitConfigOrigin?: string;
  readonly plugins?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sourcesRoot = path.join(config.pluginsDir, SOURCES_DIR_NAME);
    const directory = path.join(sourcesRoot, options.sourceId);
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    if (options.gitUrl !== undefined) {
      const metadataDirectory = path.join(sourcesRoot, ".metadata");
      yield* fileSystem.makeDirectory(metadataDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(metadataDirectory, `${options.sourceId}.json`),
        encodeUnknownJson({ gitUrl: options.gitUrl }),
      );
    }
    if (options.gitConfigOrigin !== undefined) {
      yield* fileSystem.makeDirectory(path.join(directory, ".git"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(directory, ".git", "config"),
        `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${options.gitConfigOrigin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
      );
    }
    for (const plugin of options.plugins ?? []) {
      yield* seedPluginPackage(path.join(directory, PLUGIN_SOURCE_PLUGINS_DIR, plugin.id), plugin);
    }
    return directory;
  });

describe("PluginRegistry", () => {
  it.effect("creates a usable starter and discovers its view command", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const catalog = yield* createPlugin({
        id: PluginId.make("deploy-tools"),
        name: "Deploy tools",
        description: "Internal deployment commands",
      });

      expect(catalog.plugins).toMatchObject([
        {
          id: "deploy-tools",
          name: "Deploy tools",
          enabled: true,
          commands: [{ name: "home", entry: "dist/home.html" }],
        },
      ]);
      expect(catalog.plugins[0]?.sourceId).toBeUndefined();
      expect(catalog.sources).toEqual([]);
      expect(catalog.issues).toEqual([]);
      expect(
        yield* fileSystem.exists(path.join(config.pluginsDir, "deploy-tools", "src/home.tsx")),
      ).toBe(true);
      expect(
        yield* fileSystem.exists(
          path.join(config.pluginsDir, "deploy-tools", "vendor/plugin-sdk/index.tsx"),
        ),
      ).toBe(true);
      const workspace = yield* fileSystem.readFileString(
        path.join(config.pluginsDir, "deploy-tools", "pnpm-workspace.yaml"),
      );
      expect(workspace).toContain("esbuild: true");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("escapes plugin names in generated HTML", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* createPlugin({
        id: PluginId.make("escaped-plugin"),
        name: "Tools </title><script>alert(1)</script>",
      });
      const html = yield* fileSystem.readFileString(
        path.join(config.pluginsDir, "escaped-plugin", "dist/home.html"),
      );
      expect(html).not.toContain("</title><script>alert(1)</script>");
      expect(html).toContain("Tools &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues signed URLs scoped to one plugin directory", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      yield* createPlugin({ id: PluginId.make("signed-plugin"), name: "Signed plugin" });
      const issued = yield* issuePluginViewUrl({
        pluginId: PluginId.make("signed-plugin"),
        commandName: PluginCommandName.make("home"),
      });
      const suffix = issued.relativeUrl.slice(`${PLUGIN_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);
      const expected = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) =>
          fileSystem.realPath(path.join(config.pluginsDir, "signed-plugin", "dist/home.html")),
        ),
      );

      expect(yield* resolvePluginAsset(token, "home.html")).toBe(expected);
      expect(
        yield* resolvePluginAsset(token, "../secrets/asset-access-signing-key.bin"),
      ).toBeNull();
      // The token is scoped to the command entry's directory (dist), so files
      // that live outside it are not reachable even without a traversal segment.
      expect(yield* resolvePluginAsset(token, "package.json")).toBeNull();
      expect(yield* resolvePluginAsset(`${token}tampered`, "home.html")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses to serve assets for a disabled plugin", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("disabled-asset-plugin");
      yield* createPlugin({ id: pluginId, name: "Disabled asset plugin" });
      const issued = yield* issuePluginViewUrl({
        pluginId,
        commandName: PluginCommandName.make("home"),
      });
      const suffix = issued.relativeUrl.slice(`${PLUGIN_ROUTE_PREFIX}/`.length);
      const token = suffix.slice(0, suffix.indexOf("/"));
      expect(yield* resolvePluginAsset(token, "home.html")).not.toBeNull();
      yield* setPluginEnabled({ pluginId, enabled: false });
      expect(yield* resolvePluginAsset(token, "home.html")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("disables and re-enables a plugin without deleting it", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("toggle-plugin");
      yield* createPlugin({ id: pluginId, name: "Toggle plugin" });
      const disabled = yield* setPluginEnabled({ pluginId, enabled: false });
      expect(disabled.plugins[0]?.enabled).toBe(false);
      const enabled = yield* setPluginEnabled({ pluginId, enabled: true });
      expect(enabled.plugins[0]?.enabled).toBe(true);
      expect((yield* listPluginsRpc).issues).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes a plugin directory and drops it from the catalog", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const pluginId = PluginId.make("removable-plugin");
      yield* createPlugin({ id: pluginId, name: "Removable plugin" });
      const directory = path.join(config.pluginsDir, pluginId);
      expect(yield* fileSystem.exists(directory)).toBe(true);

      const catalog = yield* deletePlugin({ pluginId });
      expect(catalog.plugins.map((plugin) => plugin.id)).not.toContain("removable-plugin");
      expect(yield* fileSystem.exists(directory)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects an invalid/traversal plugin id without touching the filesystem", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const pluginId = PluginId.make("kept-plugin");
      yield* createPlugin({ id: pluginId, name: "Kept plugin" });

      const failure = yield* deletePlugin({
        pluginId: "../kept-plugin" as unknown as PluginId,
      }).pipe(Effect.flip);
      expect(failure._tag).toBe("PluginOperationError");
      expect(failure.operation).toBe("delete");
      // The legitimate plugin directory is untouched.
      expect(yield* fileSystem.exists(path.join(config.pluginsDir, pluginId))).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("invokes a declared backend with JSON over stdin", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const pluginId = PluginId.make("backend-plugin");
      yield* createPlugin({ id: pluginId, name: "Backend plugin" });
      const directory = path.join(config.pluginsDir, pluginId);
      yield* fileSystem.writeFileString(
        path.join(directory, "t3-plugin.json"),
        encodeUnknownJson({
          schemaVersion: 1,
          id: pluginId,
          name: "Backend plugin",
          backend: "dist/backend.mjs",
          commands: [{ name: "home", title: "Home", entry: "dist/home.html" }],
        }),
      );
      yield* fileSystem.writeFileString(
        path.join(directory, "dist/backend.mjs"),
        `let text = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { text += chunk; }); process.stdin.on("end", () => { const request = JSON.parse(text); process.stdout.write(JSON.stringify({ action: request.action, value: request.input.value })); });`,
      );

      const result = yield* invokePlugin({
        pluginId,
        action: "echo",
        inputJson: encodeUnknownJson({ value: 42 }),
      });
      expect(decodeUnknownJson(result.outputJson)).toEqual({ action: "echo", value: 42 });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("discovers plugins shipped by a source repository", () =>
    Effect.gen(function* () {
      const directory = yield* seedSource({
        sourceId: "acme",
        gitUrl: "https://example.test/acme/plugins.git",
        plugins: [{ id: "acme-weather", name: "Acme weather" }],
      });
      const catalog = yield* listPluginsRpc;

      expect(catalog.issues).toEqual([]);
      expect(catalog.plugins).toMatchObject([
        { id: "acme-weather", name: "Acme weather", enabled: true, sourceId: "acme" },
      ]);
      expect(catalog.sources).toEqual([
        {
          id: "acme",
          gitUrl: "https://example.test/acme/plugins.git",
          directory,
          pluginIds: ["acme-weather"],
        },
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("serves source plugin assets through the signed plugin root", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* seedSource({
        sourceId: "acme",
        gitUrl: "https://example.test/acme/plugins.git",
        plugins: [{ id: "acme-weather", name: "Acme weather" }],
      });
      const issued = yield* issuePluginViewUrl({
        pluginId: PluginId.make("acme-weather"),
        commandName: PluginCommandName.make("home"),
      });
      const suffix = issued.relativeUrl.slice(`${PLUGIN_ROUTE_PREFIX}/`.length);
      const token = suffix.slice(0, suffix.indexOf("/"));
      const expected = yield* fileSystem.realPath(
        path.join(
          config.pluginsDir,
          SOURCES_DIR_NAME,
          "acme",
          PLUGIN_SOURCE_PLUGINS_DIR,
          "acme-weather",
          "dist/home.html",
        ),
      );

      expect(yield* resolvePluginAsset(token, "home.html")).toBe(expected);
      expect(yield* resolvePluginAsset(token, "../t3-plugin.json")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("toggles a source plugin inside its nested directory", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* seedSource({
        sourceId: "acme",
        gitUrl: "https://example.test/acme/plugins.git",
        plugins: [{ id: "acme-weather", name: "Acme weather" }],
      });
      const pluginId = PluginId.make("acme-weather");
      const marker = path.join(
        config.pluginsDir,
        SOURCES_DIR_NAME,
        "acme",
        PLUGIN_SOURCE_PLUGINS_DIR,
        "acme-weather",
        ".disabled",
      );

      const disabled = yield* setPluginEnabled({ pluginId, enabled: false });
      expect(disabled.plugins[0]?.enabled).toBe(false);
      expect(yield* fileSystem.exists(marker)).toBe(true);

      const enabled = yield* setPluginEnabled({ pluginId, enabled: true });
      expect(enabled.plugins[0]?.enabled).toBe(true);
      expect(yield* fileSystem.exists(marker)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses to delete a plugin owned by a source", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* seedSource({
        sourceId: "acme",
        gitUrl: "https://example.test/acme/plugins.git",
        plugins: [{ id: "acme-weather", name: "Acme weather" }],
      });

      const failure = yield* deletePlugin({ pluginId: PluginId.make("acme-weather") }).pipe(
        Effect.flip,
      );
      expect(failure._tag).toBe("PluginOperationError");
      expect(failure.operation).toBe("delete");
      expect(failure.message).toContain('provided by source "acme"');
      expect(failure.message).toContain("Remove the source instead");
      expect(
        yield* fileSystem.exists(
          path.join(directory, PLUGIN_SOURCE_PLUGINS_DIR, "acme-weather", "t3-plugin.json"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports an id collision without dropping the local plugin", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("shared-id");
      yield* createPlugin({ id: pluginId, name: "Local shared id" });
      yield* seedSource({
        sourceId: "acme",
        gitUrl: "https://example.test/acme/plugins.git",
        plugins: [{ id: "shared-id", name: "Source shared id" }],
      });

      const catalog = yield* listPluginsRpc;
      expect(catalog.plugins).toHaveLength(1);
      expect(catalog.plugins[0]).toMatchObject({ id: "shared-id", name: "Local shared id" });
      expect(catalog.plugins[0]?.sourceId).toBeUndefined();
      expect(catalog.issues).toHaveLength(1);
      expect(catalog.issues[0]?.directory).toBe(
        `${SOURCES_DIR_NAME}/acme/${PLUGIN_SOURCE_PLUGINS_DIR}/shared-id`,
      );
      expect(catalog.issues[0]?.message).toContain("already provided by a local plugin directory");
      expect(catalog.sources[0]?.pluginIds).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports a source without a plugins directory instead of failing the list", () =>
    Effect.gen(function* () {
      yield* seedSource({
        sourceId: "empty-source",
        gitConfigOrigin: "https://example.test/acme/empty.git",
      });

      const catalog = yield* listPluginsRpc;
      expect(catalog.plugins).toEqual([]);
      expect(catalog.issues).toEqual([]);
      expect(catalog.sources).toHaveLength(1);
      // The git remote is recovered from the clone when no metadata was written.
      expect(catalog.sources[0]?.gitUrl).toBe("https://example.test/acme/empty.git");
      expect(catalog.sources[0]?.issue).toContain(
        `No "${PLUGIN_SOURCE_PLUGINS_DIR}" directory in this source repository`,
      );
      expect(catalog.sources[0]?.issue).toContain(
        `${PLUGIN_SOURCE_PLUGINS_DIR}/<id>/t3-plugin.json`,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a traversal source id without touching the filesystem", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* seedSource({
        sourceId: "acme",
        gitUrl: "https://example.test/acme/plugins.git",
        plugins: [{ id: "acme-weather", name: "Acme weather" }],
      });

      for (const sourceId of ["../acme", "..", "acme/../../escape", ".metadata"]) {
        const failure = yield* removeSource({
          sourceId: sourceId as unknown as PluginSourceId,
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("PluginOperationError");
        expect(failure.operation).toBe("remove-source");
        expect(failure.message).toContain("Invalid plugin source id");
      }
      expect(yield* fileSystem.exists(directory)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes a source directory and its plugins", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* seedSource({
        sourceId: "acme",
        gitUrl: "https://example.test/acme/plugins.git",
        plugins: [{ id: "acme-weather", name: "Acme weather" }],
      });

      const catalog = yield* removeSource({ sourceId: PluginSourceId.make("acme") });
      expect(catalog.sources).toEqual([]);
      expect(catalog.plugins).toEqual([]);
      expect(yield* fileSystem.exists(directory)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects an unknown source id", () =>
    Effect.gen(function* () {
      const failure = yield* removeSource({
        sourceId: PluginSourceId.make("missing-source"),
      }).pipe(Effect.flip);
      expect(failure.operation).toBe("remove-source");
      expect(failure.message).toContain('Plugin source "missing-source" was not found');
    }).pipe(Effect.provide(testLayer)),
  );

  // Clone/pull themselves need a remote, so only the validation that runs
  // before git is spawned is covered here.
  it.effect("rejects an unsupported git URL before spawning git", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const failure = yield* addSource({
        gitUrl: "file:///etc/passwd",
      }).pipe(Effect.flip);
      expect(failure.operation).toBe("add-source");
      expect(failure.message).toContain("Unsupported git URL");
      expect(yield* fileSystem.exists(path.join(config.pluginsDir, SOURCES_DIR_NAME))).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("ignores a plugin directory that symlinks outside the plugins directory", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The natural "symlink my checkout in" workflow, pointing out of the tree.
      const outside = yield* seedPluginPackage(path.join(config.baseDir, "checkout", "escaped"), {
        id: "escaped",
        name: "Escaped plugin",
      });
      yield* fileSystem.symlink(outside, path.join(config.pluginsDir, "escaped"));

      const catalog = yield* listPluginsRpc;
      expect(catalog.plugins).toEqual([]);
      expect(catalog.issues).toHaveLength(1);
      expect(catalog.issues[0]?.directory).toBe("escaped");
      expect(catalog.issues[0]?.message).toContain("resolves outside the plugins directory");
      // Discovery and resolution agree: it is never offered as a usable plugin.
      const failure = yield* setPluginEnabled({
        pluginId: PluginId.make("escaped"),
        enabled: false,
      }).pipe(Effect.flip);
      expect(failure.message).toContain('Plugin "escaped" was not found');
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("ignores a source plugin that symlinks outside the plugins directory", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* seedSource({
        sourceId: "acme",
        gitUrl: "https://example.test/acme/plugins.git",
      });
      const outside = yield* seedPluginPackage(path.join(config.baseDir, "checkout", "escaped"), {
        id: "escaped",
        name: "Escaped plugin",
      });
      const pluginsRoot = path.join(directory, PLUGIN_SOURCE_PLUGINS_DIR);
      yield* fileSystem.makeDirectory(pluginsRoot, { recursive: true });
      yield* fileSystem.symlink(outside, path.join(pluginsRoot, "escaped"));

      const catalog = yield* listPluginsRpc;
      expect(catalog.plugins).toEqual([]);
      expect(catalog.issues).toHaveLength(1);
      expect(catalog.issues[0]?.directory).toBe(
        `${SOURCES_DIR_NAME}/acme/${PLUGIN_SOURCE_PLUGINS_DIR}/escaped`,
      );
      expect(catalog.issues[0]?.message).toContain("resolves outside the plugins directory");
      expect(catalog.sources[0]?.pluginIds).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps a plugin symlinked to a target inside the plugins directory usable", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Dot-prefixed parent, so only the symlink itself is discovered.
      const target = yield* seedPluginPackage(
        path.join(config.pluginsDir, ".store", "linked-plugin"),
        { id: "linked-plugin", name: "Linked plugin" },
      );
      yield* fileSystem.symlink(target, path.join(config.pluginsDir, "linked-plugin"));

      const catalog = yield* listPluginsRpc;
      expect(catalog.issues).toEqual([]);
      expect(catalog.plugins).toMatchObject([{ id: "linked-plugin", enabled: true }]);
      // Operations follow the symlink to the canonical directory.
      const disabled = yield* setPluginEnabled({
        pluginId: PluginId.make("linked-plugin"),
        enabled: false,
      });
      expect(disabled.plugins[0]?.enabled).toBe(false);
      expect(yield* fileSystem.exists(path.join(target, ".disabled"))).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("returns an empty catalog when the plugins directory is missing", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* createPlugin({ id: PluginId.make("doomed-plugin"), name: "Doomed plugin" });
      yield* fileSystem.remove(config.pluginsDir, { recursive: true, force: true });

      const catalog = yield* listPluginsRpc;
      expect(catalog.pluginsDirectory).toBe(config.pluginsDir);
      expect(catalog.plugins).toEqual([]);
      expect(catalog.issues).toEqual([]);
      expect(catalog.sources).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses to install a repository that is already a source", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* seedSource({
        sourceId: "plugins",
        gitUrl: "https://example.test/acme/plugins.git",
        plugins: [{ id: "acme-weather", name: "Acme weather" }],
      });

      // Same repository, trailing slash instead of the `.git` suffix.
      const failure = yield* addSource({ gitUrl: "https://example.test/acme/plugins/" }).pipe(
        Effect.flip,
      );
      expect(failure.operation).toBe("add-source");
      expect(failure.message).toBe(
        'This repository is already installed as source "plugins". Use Update to pull new commits.',
      );
      expect(
        yield* fileSystem.exists(path.join(config.pluginsDir, SOURCES_DIR_NAME, "plugins-2")),
      ).toBe(false);
      expect((yield* listPluginsRpc).sources.map((source) => source.id)).toEqual(["plugins"]);
    }).pipe(Effect.provide(testLayer)),
  );

  // it.live: the sweep compares directory mtimes against the clock, which
  // TestClock would pin to the epoch.
  it.live("sweeps a stale clone temporary before the next addSource attempt", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* seedSource({ sourceId: "plugins", gitUrl: "https://example.test/acme/plugins.git" });
      const sourcesRoot = path.join(config.pluginsDir, SOURCES_DIR_NAME);
      const abandoned = path.join(sourcesRoot, ".cloning-plugins-abandoned");
      const inFlight = path.join(sourcesRoot, ".cloning-plugins-in-flight");
      yield* fileSystem.makeDirectory(path.join(abandoned, "partial"), { recursive: true });
      yield* fileSystem.makeDirectory(inFlight, { recursive: true });
      // Numeric utimes arguments are seconds; back-date the leftover a full day.
      const longAgo = ((yield* Clock.currentTimeMillis) - 24 * 60 * 60 * 1000) / 1000;
      yield* fileSystem.utimes(abandoned, longAgo, longAgo);

      // The duplicate rejection lands after the sweep, so git is never spawned.
      yield* addSource({ gitUrl: "https://example.test/acme/plugins.git" }).pipe(Effect.flip);
      expect(yield* fileSystem.exists(abandoned)).toBe(false);
      // A temporary a concurrent clone may still own is left alone.
      expect(yield* fileSystem.exists(inFlight)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );
});
