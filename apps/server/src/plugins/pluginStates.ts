import {
  type AuthEnvironmentScope,
  AuthSettingsWriteScope,
  type PluginFailure,
  type PluginManifest,
  type PluginListResult,
  type PluginState,
  type PluginStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as EnvironmentTheme from "../environmentTheme.ts";
import type { PluginActivation } from "./PluginApi.ts";
import type { DiscoveredPlugin } from "./pluginDiscovery.ts";
import type { PluginFailures } from "./pluginFailures.ts";
import type { PluginsConfigFile } from "./pluginsConfig.ts";
import type { PluginWebFolders } from "./pluginWebFiles.ts";

export interface PluginRecord {
  readonly plugin: DiscoveredPlugin;
  readonly status: PluginStatus;
  readonly failure?: PluginFailure;
  readonly activation?: PluginActivation;
  readonly revision?: number;
  readonly webRevision?: string;
  readonly styles?: PluginState["styles"];
  readonly webFiles?: PluginWebFolders;
}

export const manifestOf = (plugin: DiscoveredPlugin): PluginManifest | undefined =>
  "manifest" in plugin ? plugin.manifest : undefined;

// Folders on the server are for clients that manage plugins; read access can be a guest's.
const withoutServerPaths = (state: PluginState): PluginState => {
  const { folder: _folder, ...shown } = state;
  return shown;
};
const managesPlugins = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  scopes.includes(AuthSettingsWriteScope);

const toState = (
  record: PluginRecord,
  config: PluginsConfigFile,
  serverFailure: string | undefined,
): PluginState => {
  const manifest = manifestOf(record.plugin);
  const { id } = record.plugin;
  return {
    id: record.plugin.id,
    name: manifest?.name ?? record.plugin.id,
    ...(manifest === undefined
      ? {}
      : {
          version: manifest.version,
          ...(manifest.description === undefined ? {} : { description: manifest.description }),
        }),
    permissions: manifest?.permissions ?? [],
    source: record.plugin.source,
    folder: record.plugin.folder,
    enabled: config.enabled?.[id] === true,
    status: record.status,
    ...(record.failure === undefined ? {} : { failure: record.failure }),
    ...(record.revision === undefined ? {} : { revision: record.revision }),
    ...(record.webRevision === undefined ? {} : { webRevision: record.webRevision }),
    ...(record.styles === undefined || record.styles.length === 0 ? {} : { styles: record.styles }),
    hasServer: manifest?.server !== undefined,
    hasWeb: manifest?.web !== undefined,
    hasSettings: manifest?.settingsSchema !== undefined,
    ...(serverFailure === undefined ? {} : { serverFailure }),
    ...("unknownKeys" in record.plugin && record.plugin.unknownKeys !== undefined
      ? { unknownManifestKeys: record.plugin.unknownKeys }
      : {}),
  };
};

/**
 * Builds the plugin list clients see from the host's records, plugins.json and the failures, and
 * publishes it after each change, with the theme folders of plugins that are on when those change.
 */
export const makePluginStates = Effect.fn("PluginStates.make")(function* (input: {
  readonly records: Ref.Ref<ReadonlyArray<PluginRecord>>;
  readonly config: Effect.Effect<PluginsConfigFile>;
  readonly failures: PluginFailures;
}) {
  const { records, failures } = input;
  const environmentThemes = yield* EnvironmentTheme.EnvironmentThemeService;
  const path = yield* Path.Path;
  const changes = yield* PubSub.sliding<ReadonlyArray<PluginState>>(1);
  const publishLock = yield* Semaphore.make(1);

  const statesOf = Effect.fn("PluginHost.statesOf")(function* (all: ReadonlyArray<PluginRecord>) {
    const config = yield* input.config;
    const failureOf = yield* failures.current;
    return all.map((record) =>
      toState(record, config, failureOf(record.plugin.id, record.revision)),
    );
  });
  const current = Ref.get(records).pipe(Effect.flatMap(statesOf));
  // What the last publish sent, starting from the empty list clients get before any. Settings
  // rescans on every visit, and a list sent again would make every client stream rebuild what it
  // already shows.
  let published: ReadonlyArray<PluginState> = [];
  // The copies whose theme folders the theme service last got, which reads every folder each time.
  // A reload discovers its plugin afresh, so the new copy's themes are read again.
  let themed: ReadonlyArray<DiscoveredPlugin> = [];
  // Reading and publishing under one lock, so a slower fiber cannot publish an older list last.
  const publishUnderLock = publishLock.withPermits(1)(
    Effect.gen(function* () {
      const all = yield* Ref.get(records);
      const states = yield* statesOf(all);
      if (Equal.equals(states, published)) return;
      // Every enabled plugin that has not failed, so a starting or restarting one keeps its themes:
      // windows would otherwise paint T3's colors, forget the saved theme, then switch back.
      const copies = all.flatMap((record, index) => {
        const state = states[index];
        return state?.enabled === true && state.status !== "failed" ? [record.plugin] : [];
      });
      if (copies.length !== themed.length || copies.some((copy, index) => copy !== themed[index])) {
        yield* environmentThemes.setPluginThemeDirectories(
          copies.map((copy) => path.join(copy.rootDir, "themes")),
        );
        themed = copies;
      }
      yield* PubSub.publish(changes, states);
      published = states;
    }),
  );

  const stream = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      const snapshot = yield* current;
      return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription));
    }),
  );
  const forClient =
    (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
    (plugins: ReadonlyArray<PluginState>): PluginListResult => ({
      plugins: managesPlugins(scopes) ? plugins : plugins.map(withoutServerPaths),
    });

  return {
    current,
    /**
     * Sends the list if it changed. A stop that interrupts a starting plugin mid-publish cannot
     * leave it unsent.
     */
    publish: Effect.uninterruptible(publishUnderLock),
    streamForClient: (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
      stream.pipe(Stream.map(forClient(scopes))),
  };
});
