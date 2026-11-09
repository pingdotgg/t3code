// @effect-diagnostics preferSchemaOverJson:off - like the tests, it writes manifests as plain JSON.
// The plugin host with its real stores and MCP tool registry, for its tests and the tests of the
// modules it builds.
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  type PluginState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as ServerConfig from "../config.ts";
import * as PluginHost from "./PluginHost.ts";
import * as PluginMcpTools from "./PluginMcpTools.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";

export const fixturesDir = new URL("../../../../packages/plugin-sdk/fixtures/", import.meta.url)
  .pathname;

export const layerConfig = () =>
  Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-host-test-" }));

// Every list of theme folders the host published, for the web files case.
export const publishedThemeDirectories: Array<ReadonlyArray<string>> = [];
const layerThemes = Layer.mock(EnvironmentTheme.EnvironmentThemeService)({
  setPluginThemeDirectories: (directories) =>
    Effect.sync(() => {
      publishedThemeDirectories.push(directories);
    }),
});

/**
 * `themes` replaces the recording theme service, such as to hold a publish where it calls it, and
 * `settings` replaces methods of the settings store, such as to hold a save.
 */
export const layerHost = (
  themes = layerThemes,
  settings: (
    store: PluginSettingsStore.PluginSettingsStore["Service"],
  ) => Partial<PluginSettingsStore.PluginSettingsStore["Service"]> = () => ({}),
) =>
  Layer.fresh(
    PluginHost.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.effect(
            PluginSettingsStore.PluginSettingsStore,
            PluginSettingsStore.PluginSettingsStore.use((store) =>
              Effect.succeed({ ...store, ...settings(store) }),
            ),
          ).pipe(Layer.provide(PluginSettingsStore.layer)),
          PluginStorage.layer,
        ),
      ),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(themes),
      Layer.provideMerge(PluginMcpTools.layer),
    ),
  );

/** The real file system with some of its methods replaced, for the host's layer. */
export const layerFileSystemWith = (
  replace: (fs: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>,
) =>
  Layer.effect(
    FileSystem.FileSystem,
    FileSystem.FileSystem.use((fs) => Effect.succeed({ ...fs, ...replace(fs) })),
  );

export const writeFile = Effect.fn(function* (filePath: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, contents);
});

export const writePluginsConfig = Effect.fn(function* (config: {
  readonly enabled?: Record<string, boolean>;
  readonly devPaths?: ReadonlyArray<string>;
  readonly starting?: ReadonlyArray<string>;
}) {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  // @effect-diagnostics-next-line globalJsonInEffect:off -- test input, always serializable.
  yield* writeFile(`${stateDir}/plugins.json`, JSON.stringify(config));
});

/** A plugin written for one test, under `<stateDir>/plugins/<id>`. */
export const writeInstalledPlugin = Effect.fn(function* (id: string, serverSource: string) {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const rootDir = `${stateDir}/plugins/${id}`;
  yield* writeFile(
    `${rootDir}/t3-plugin.json`,
    // @effect-diagnostics-next-line globalJsonInEffect:off -- test input, always serializable.
    JSON.stringify({
      id,
      name: id,
      version: "0.1.0",
      engines: { t3: ">=0.1.0" },
      server: "./server.cjs",
    }),
  );
  yield* writeFile(`${rootDir}/server.cjs`, serverSource);
  return rootDir;
});

export const stateOf = (states: ReadonlyArray<PluginState>, id: string) =>
  states.find((state) => state.id === id);

/** The plugin lists a client that manages plugins gets, the current one first. */
export const streamStates = (host: PluginHost.PluginHost["Service"]) =>
  host
    .streamForClient([AuthOrchestrationReadScope, AuthSettingsWriteScope])
    .pipe(Stream.map(({ plugins }) => plugins));

export const listStates = (host: PluginHost.PluginHost["Service"]) =>
  streamStates(host).pipe(Stream.runHead, Effect.map(Option.getOrThrow));

/** Resolves with the first list where every listed plugin has its expected status. */
export const waitForStatuses = (
  host: PluginHost.PluginHost["Service"],
  expected: Readonly<Record<string, PluginState["status"]>>,
) =>
  streamStates(host).pipe(
    Stream.filter((states) =>
      Object.entries(expected).every(([id, status]) => stateOf(states, id)?.status === status),
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
