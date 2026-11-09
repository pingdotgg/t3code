import {
  type PluginId,
  PluginManifest,
  type PluginState,
  type PluginUploadFile,
} from "@t3tools/contracts";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import type { DiscoveredPlugin } from "./pluginDiscovery.ts";
import type { PluginNotFoundError } from "./PluginHost.ts";
import { type PluginConfigError, type PluginsConfigFile, withoutCrash } from "./pluginsConfig.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";

// `reason` is shown to the user as is, so it says what to fix.
export class PluginInstallError extends Schema.TaggedError<PluginInstallError>()(
  "PluginInstallError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * The host builds it and hands it the lifecycle lock, the plugin list and plugins.json, so the host
 * keeps discovery, activation and state, and a new install source only changes this file.
 */
export class PluginInstaller extends Context.Service<
  PluginInstaller,
  {
    /**
     * Installs a plugin folder a client sent as files into the plugins folder. A new plugin is
     * turned off; a replaced one keeps its switch and restarts if on. It is staged first and
     * swapped in with a rename, so a failed install leaves the previous version.
     */
    readonly installFiles: (
      files: ReadonlyArray<PluginUploadFile>,
    ) => Effect.Effect<PluginState, PluginInstallError | PluginNotFoundError | PluginConfigError>;
    /**
     * Loads the plugin in `folder`, an absolute path on the server, where it is, turned off like an
     * install. Refuses a folder without a manifest this server can run, and an id already listed.
     */
    readonly link: (
      folder: string,
    ) => Effect.Effect<PluginState, PluginInstallError | PluginNotFoundError | PluginConfigError>;
    /**
     * Stops a plugin and deletes its folder, settings, secrets and storage; a linked folder is
     * only forgotten. Refuses an id more than one folder has, whose data the other folders use.
     */
    readonly uninstall: (
      pluginId: PluginId,
    ) => Effect.Effect<void, PluginInstallError | PluginNotFoundError | PluginConfigError>;
  }
>()("t3/plugins/PluginInstaller") {}

export interface PluginInstallerHost {
  /**
   * Runs `body` under the lifecycle lock in the host's scope, so a caller that disconnects only
   * stops waiting and never leaves a plugin half replaced.
   */
  readonly lifecycle: <A, E>(body: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  readonly plugins: Effect.Effect<ReadonlyArray<DiscoveredPlugin>>;
  readonly pluginOf: (pluginId: PluginId) => Effect.Effect<DiscoveredPlugin, PluginNotFoundError>;
  /** Stops a plugin; the caller sets what comes next. Only under `lifecycle`. */
  readonly stop: (pluginId: PluginId) => Effect.Effect<void>;
  /** Rescans the plugin folders without restarting anything. Only under `lifecycle`. */
  readonly rescan: Effect.Effect<void, PluginConfigError>;
  /** Rescans the plugin folders and restarts the plugin, waiting until it has started. */
  readonly reload: (
    pluginId: PluginId,
  ) => Effect.Effect<PluginState, PluginNotFoundError | PluginConfigError>;
  /** plugins.json as last read or written. */
  readonly config: Effect.Effect<PluginsConfigFile>;
  readonly writeConfig: (
    update: (current: PluginsConfigFile) => PluginsConfigFile,
  ) => Effect.Effect<void, PluginConfigError>;
}

type InstallOrigin = { readonly files: ReadonlyArray<PluginUploadFile> };

const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));

const installFailed = (reason: string) => (cause: unknown) =>
  new PluginInstallError({ reason, cause });

const isDuplicate = (
  plugin: DiscoveredPlugin,
): plugin is Extract<DiscoveredPlugin, { readonly failure: unknown }> =>
  "failure" in plugin && plugin.failure.stage === "duplicate";

/** The host runs `recoverStaging` before its first discovery. */
export const make = Effect.fn("PluginInstaller.make")(function* (host: PluginInstallerHost) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const settingsStore = yield* PluginSettingsStore.PluginSettingsStore;
  const storage = yield* PluginStorage.PluginStorage;
  const scope = yield* Effect.scope;

  const pluginsDir = path.join(config.stateDir, "plugins");
  const stagingRoot = path.join(config.stateDir, "plugin-staging");

  // An install interrupted mid-swap (a crash) can leave the old version only in staging. Listed
  // while the layer builds, before the server serves requests, so recovery never touches the
  // staging folder of an install that starts after that.
  const leftoverStaging = yield* fs
    .readDirectory(stagingRoot)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const recoverStaging = Effect.gen(function* () {
    for (const entry of leftoverStaging) {
      const previous = path.join(stagingRoot, entry, "previous");
      const manifest = yield* fs
        .readFileString(path.join(previous, "t3-plugin.json"))
        .pipe(Effect.flatMap(decodeManifestJson), Effect.option);
      if (Option.isSome(manifest)) {
        const target = path.join(pluginsDir, manifest.value.id);
        const replaced = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true));
        if (!replaced) {
          yield* fs.makeDirectory(pluginsDir, { recursive: true }).pipe(Effect.ignore);
          yield* fs.rename(previous, target).pipe(Effect.ignore);
        }
      }
      yield* fs
        .remove(path.join(stagingRoot, entry), { recursive: true, force: true })
        .pipe(Effect.ignore);
    }
  }).pipe(Effect.withSpan("PluginInstaller.recoverStaging"));

  // A caller that disconnects stops waiting but cannot interrupt a swap or a staging cleanup.
  const inHostScope = <A, E>(body: Effect.Effect<A, E>) =>
    body.pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join));

  const readSourceManifest = (folder: string) =>
    fs.readFileString(path.join(folder, "t3-plugin.json")).pipe(
      Effect.mapError(installFailed("The folder has no t3-plugin.json.")),
      Effect.flatMap((raw) =>
        decodeManifestJson(raw).pipe(
          Effect.mapError(installFailed("The folder's t3-plugin.json is not a valid manifest.")),
        ),
      ),
    );

  // The upload schema checks that every path stays inside `into`.
  const writeFiles = Effect.fn("PluginInstaller.writeFiles")(function* (
    files: ReadonlyArray<{ readonly path: string; readonly contents: Uint8Array }>,
    into: string,
  ) {
    for (const file of files) {
      const target = path.join(into, ...file.path.split("/"));
      yield* fs
        .makeDirectory(path.dirname(target), { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFile(target, file.contents)),
          Effect.mapError(installFailed(`Could not write ${file.path}.`)),
        );
    }
  });

  /** Why this server cannot run `manifest`, checked before anything is stopped or moved. */
  const refusal = (manifest: PluginManifest) => {
    if (!satisfiesSemverRange(packageJson.version, manifest.engines.t3)) {
      return `${manifest.name} ${manifest.version} needs T3 Code ${manifest.engines.t3}, and this server is ${packageJson.version}.`;
    }
    const schemaProblem =
      manifest.settingsSchema === undefined
        ? undefined
        : PluginSettingsStore.settingsSchemaProblem(manifest.settingsSchema);
    return schemaProblem === undefined
      ? undefined
      : `${manifest.name} ${manifest.version} has a settingsSchema T3 Code cannot validate: ${schemaProblem}`;
  };

  /**
   * Swaps `<stagingDir>/plugin` into the plugins folder under the lifecycle lock and starts it if it
   * is on. The replaced version waits in `<stagingDir>/previous` and goes back if the new one fails
   * to start. `stagingDir` is removed unless it holds a version's only copy, which startup then
   * restores.
   */
  const swapIn = Effect.fn("PluginInstaller.swapIn")(function* (
    manifest: PluginManifest,
    stagingDir: string,
  ) {
    const staged = path.join(stagingDir, "plugin");
    const previous = path.join(stagingDir, "previous");
    let stopped = false;
    let stranded = false;
    yield* Effect.addFinalizer(() => (stranded ? Effect.void : removeStaging(stagingDir)));
    const swapped = yield* host
      .lifecycle(
        // Read under the lock, so another install or a removal cannot change them before the swap.
        Effect.gen(function* () {
          const plugins = yield* host.plugins;
          const existing = plugins.find((plugin) => plugin.id === manifest.id);
          if (existing !== undefined && isDuplicate(existing)) {
            return yield* new PluginInstallError({ reason: existing.failure.message });
          }
          if (existing?.source === "dev") {
            return yield* new PluginInstallError({
              reason: `${manifest.id} is linked from ${existing.folder}. Unlink it first.`,
            });
          }
          const target =
            existing === undefined ? path.join(pluginsDir, manifest.id) : existing.folder;
          // A folder put there by hand holds another plugin, or none, which the swap would delete.
          if (
            existing === undefined &&
            (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true)))
          ) {
            const owner = plugins.find((plugin) => plugin.folder === target);
            return yield* new PluginInstallError({
              reason: `The plugins folder already has a ${manifest.id} folder${owner === undefined ? "" : ` holding ${owner.id}`}. Move it, then install again.`,
            });
          }
          // A new plugin starts off, so none of it runs until the user has seen its row and turned
          // it on. A replaced one keeps its switch.
          const enabled =
            existing !== undefined && (yield* host.config).enabled?.[manifest.id] === true;
          stopped = true;
          yield* host.stop(manifest.id);
          yield* fs
            .makeDirectory(pluginsDir, { recursive: true })
            .pipe(Effect.mapError(installFailed("Could not create the plugins folder.")));
          const hadPrevious = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
          if (hadPrevious) {
            yield* fs
              .rename(target, previous)
              .pipe(Effect.mapError(installFailed("Could not move the installed version aside.")));
          }
          yield* fs.rename(staged, target).pipe(
            Effect.mapError(installFailed("Could not move the new version into place.")),
            Effect.tapError(() =>
              hadPrevious ? fs.rename(previous, target).pipe(Effect.ignore) : Effect.void,
            ),
          );
          yield* host.writeConfig((current) => ({
            ...current,
            enabled: { ...current.enabled, [manifest.id]: enabled },
          }));
          return {
            target,
            hadPrevious,
            replacedVersion:
              existing !== undefined && "manifest" in existing
                ? existing.manifest.version
                : undefined,
          };
        }),
      )
      .pipe(
        // Whatever failed after the stop, the plugin folder holds one version; start it again.
        Effect.onError(() =>
          stopped ? host.reload(manifest.id).pipe(Effect.ignore) : Effect.void,
        ),
      );
    const started = yield* host.reload(manifest.id);
    if (!swapped.hadPrevious || started.status !== "failed") return started;
    yield* host
      .lifecycle(
        Effect.gen(function* () {
          yield* host.stop(manifest.id);
          yield* fs
            .rename(swapped.target, path.join(stagingDir, "failed"))
            .pipe(Effect.mapError(installFailed("Could not move the failed version aside.")));
          yield* fs.rename(previous, swapped.target).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                stranded = true;
              }),
            ),
            Effect.mapError(
              installFailed("Could not put the previous version back. Restart T3 Code to finish."),
            ),
          );
        }),
      )
      .pipe(Effect.ensuring(host.reload(manifest.id).pipe(Effect.ignore)));
    return yield* new PluginInstallError({
      reason: `${manifest.name} ${manifest.version} failed to start, so ${swapped.replacedVersion ?? "the previous version"} is back. It failed with: ${started.failure?.message ?? "an unknown error"}`,
    });
  }, Effect.scoped);

  const stage = Effect.fn("PluginInstaller.stage")(function* (origin: InstallOrigin) {
    const stagingDir = path.join(stagingRoot, yield* random.uuidV4().pipe(Effect.orDie));
    const staged = path.join(stagingDir, "plugin");
    yield* fs
      .makeDirectory(stagingDir, { recursive: true })
      .pipe(Effect.mapError(installFailed("Could not create the staging folder.")));
    return yield* Effect.gen(function* () {
      yield* writeFiles(origin.files, staged);
      return { stagingDir, manifest: yield* readSourceManifest(staged) };
    }).pipe(Effect.tapError(() => removeStaging(stagingDir)));
  });

  const removeStaging = (stagingDir: string) =>
    fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore);

  const installOrigin = Effect.fn("PluginInstaller.installOrigin")(function* (
    origin: InstallOrigin,
  ) {
    const { stagingDir, manifest } = yield* stage(origin);
    const reason = refusal(manifest);
    if (reason !== undefined) {
      yield* removeStaging(stagingDir);
      return yield* new PluginInstallError({ reason });
    }
    return yield* swapIn(manifest, stagingDir);
  });

  // `PluginUploadFiles` bounds the folder's size before it gets here.
  const installFiles: PluginInstaller["Service"]["installFiles"] = Effect.fn(
    "PluginInstaller.installFiles",
  )((files) => inHostScope(installOrigin({ files })));

  const link: PluginInstaller["Service"]["link"] = Effect.fn("PluginInstaller.link")(
    function* (input) {
      // A relative path would resolve against wherever the server happened to start.
      if (!path.isAbsolute(input)) {
        return yield* new PluginInstallError({
          reason: "Give the folder's absolute path on the server.",
        });
      }
      const folder = path.resolve(input);
      const manifest = yield* readSourceManifest(folder);
      const reason = refusal(manifest);
      if (reason !== undefined) return yield* new PluginInstallError({ reason });
      yield* host.lifecycle(
        Effect.gen(function* () {
          const existing = (yield* host.plugins).find((plugin) => plugin.id === manifest.id);
          if (existing !== undefined) {
            return yield* new PluginInstallError({
              reason:
                existing.source === "dev"
                  ? `${manifest.id} is already linked from ${existing.folder}. Unlink it first.`
                  : `${manifest.id} is already installed. Remove it first.`,
            });
          }
          yield* host.writeConfig((current) => ({
            ...current,
            devPaths: [...(current.devPaths ?? []), folder],
            enabled: { ...current.enabled, [manifest.id]: false },
          }));
        }),
      );
      return yield* host.reload(manifest.id);
    },
  );

  const removeFromConfig = (pluginId: PluginId) =>
    host.writeConfig((current) => {
      const { [pluginId]: _removed, ...enabled } = current.enabled ?? {};
      return { ...withoutCrash(current, pluginId), enabled };
    });

  const forgetDevPath = (folder: string) =>
    host.writeConfig((current) => ({
      ...current,
      devPaths: (current.devPaths ?? []).filter((entry) => path.resolve(entry) !== folder),
    }));

  // The folder as listed, not `rootDir`: that is the real path, so a symlinked plugin would delete
  // the user's own folder behind the link. A linked folder is the author's own; only plugins.json
  // forgets it.
  const removeFolder = (plugin: DiscoveredPlugin) =>
    plugin.source === "dev"
      ? forgetDevPath(plugin.folder)
      : fs
          .remove(plugin.folder, { recursive: true, force: true })
          .pipe(Effect.mapError(installFailed(`Could not delete ${plugin.folder}.`)));

  const uninstall: PluginInstaller["Service"]["uninstall"] = Effect.fn("PluginInstaller.uninstall")(
    (pluginId) => {
      let stopped = false;
      return host
        .lifecycle(
          Effect.gen(function* () {
            const plugin = yield* host.pluginOf(pluginId);
            if (isDuplicate(plugin)) {
              return yield* new PluginInstallError({ reason: plugin.failure.message });
            }
            stopped = true;
            yield* host.stop(pluginId);
            yield* removeFolder(plugin);
            yield* removeFromConfig(pluginId);
            yield* host.rescan;
            // Under the lock, or an install that starts meanwhile could lose its new settings.
            yield* settingsStore
              .clear(pluginId)
              .pipe(
                Effect.mapError(installFailed("The plugin is removed, but its settings are not.")),
              );
            yield* storage
              .clear(pluginId)
              .pipe(
                Effect.mapError(installFailed("The plugin is removed, but its storage is not.")),
              );
          }),
        )
        .pipe(
          // As for an install: whatever failed after the stop, what is left starts again if on.
          Effect.onError(() => (stopped ? host.reload(pluginId).pipe(Effect.ignore) : Effect.void)),
        );
    },
  );

  return {
    installer: PluginInstaller.of({ installFiles, link, uninstall }),
    recoverStaging,
  };
});
