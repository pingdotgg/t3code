// @effect-diagnostics nodeBuiltinImport:off - a crash is saved while the process exits, which
// needs synchronous writes the FileSystem service does not offer.
import * as NodeFS from "node:fs";

import type { PluginId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

export class PluginConfigError extends Schema.TaggedError<PluginConfigError>()(
  "PluginConfigError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not update ${this.path}. If it was edited by hand, fix or delete it.`;
  }
}

// Unknown keys survive a rewrite, so a newer build's additions outlive a toggle by an older one.
const PluginsConfigFile = Schema.StructWithRest(
  Schema.Struct({
    enabled: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
    devPaths: Schema.optionalKey(Schema.Array(Schema.String)),
    /** Why each plugin stopped the server, kept until the user turns it on again or reloads it. */
    crashed: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    /**
     * Plugins whose server code is loading or activating. One still here at the next start ended
     * the server in a way the failure guard can't see, such as `process.exit`.
     */
    starting: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type PluginsConfigFile = typeof PluginsConfigFile.Type;
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginsConfigFile));
const encodeConfig = Schema.encodeEffect(fromJsonStringPretty(PluginsConfigFile));
const decodeConfigSync = Schema.decodeUnknownSync(Schema.fromJsonString(PluginsConfigFile));
const encodeConfigSync = Schema.encodeSync(fromJsonStringPretty(PluginsConfigFile));

const STOPPED_WHILE_STARTING =
  "T3 Code stopped while this plugin was starting, such as from process.exit, running out of memory or a loop that never ended.";

export const withoutCrash = (current: PluginsConfigFile, pluginId: PluginId): PluginsConfigFile => {
  if (current.crashed?.[pluginId] === undefined) return current;
  const { [pluginId]: _cleared, ...crashed } = current.crashed;
  return { ...current, crashed };
};

export const makePluginsConfig = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(config.stateDir, "plugins.json");
  const current = yield* Ref.make<PluginsConfigFile>({});
  // Plugins mark their own starts from separate fibers, and each write rewrites the whole file.
  const writeLock = yield* Semaphore.make(1);

  const read = Effect.gen(function* () {
    const exists = yield* fs.exists(configPath);
    if (!exists) {
      const emptyConfig: PluginsConfigFile = {};
      return emptyConfig;
    }
    const raw = yield* fs.readFileString(configPath);
    return yield* decodeConfig(raw);
  }).pipe(Effect.mapError((cause) => new PluginConfigError({ path: configPath, cause })));

  const write = Effect.fn("PluginHost.writeConfig")(function* (
    update: (current: PluginsConfigFile) => PluginsConfigFile,
  ) {
    const next = update(yield* read);
    const contents = yield* encodeConfig(next).pipe(
      Effect.mapError((cause) => new PluginConfigError({ path: configPath, cause })),
    );
    yield* writeFileStringAtomically({ filePath: configPath, contents: `${contents}\n` }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new PluginConfigError({ path: configPath, cause })),
    );
    yield* Ref.set(current, next);
  }, writeLock.withPermits(1));

  const emptyConfig: PluginsConfigFile = {};
  return {
    /** plugins.json as last read or written. */
    current: Ref.get(current),
    /** Reads the file again and keeps it. Startup tolerates an unreadable file; a reload reports it. */
    reread: (lenient: boolean) =>
      (lenient
        ? read.pipe(
            Effect.catchTags({
              PluginConfigError: (error) =>
                Effect.logWarning("ignoring unreadable plugins.json", { path: error.path }).pipe(
                  Effect.as(emptyConfig),
                ),
            }),
          )
        : read
      ).pipe(Effect.tap((next) => Ref.set(current, next))),
    write,
    /** Also forgets that the plugin crashed the server: the user chose what happens next. */
    writeEnabled: (pluginId: PluginId, enabled: boolean) =>
      write((current) => ({
        ...withoutCrash(current, pluginId),
        enabled: { ...current.enabled, [pluginId]: enabled },
      })),
    /**
     * Forgets the switch and crash of every plugin not in `found`, writing only if there are any.
     * A switch left on by a folder deleted by hand would start the next folder with its id unseen.
     */
    forgetMissing: (found: ReadonlySet<string>) => {
      const keep = <V>(entries: Readonly<Record<string, V>>) =>
        Object.fromEntries(Object.entries(entries).filter(([id]) => found.has(id)));
      const missing = (config: PluginsConfigFile) =>
        [...Object.keys(config.enabled ?? {}), ...Object.keys(config.crashed ?? {})].some(
          (id) => !found.has(id),
        );
      return Ref.get(current).pipe(
        Effect.flatMap((last) =>
          missing(last)
            ? write((latest) => ({
                ...latest,
                ...(latest.enabled === undefined ? {} : { enabled: keep(latest.enabled) }),
                ...(latest.crashed === undefined ? {} : { crashed: keep(latest.crashed) }),
              }))
            : Effect.void,
        ),
      );
    },
    markStarting: (pluginId: PluginId, starting: boolean) =>
      write((last) => {
        const { starting: marked = [], ...rest } = last;
        const others = marked.filter((id) => id !== pluginId);
        const next = starting ? [...others, pluginId] : others;
        return next.length === 0 ? rest : { ...rest, starting: next };
      }),
    /** At startup, records every plugin a start left marked as one that stopped the server. */
    recoverStarting: read.pipe(
      Effect.flatMap((latest) =>
        latest.starting === undefined
          ? Effect.void
          : write(({ starting: marked = [], ...rest }) => ({
              ...rest,
              enabled: { ...rest.enabled, ...Object.fromEntries(marked.map((id) => [id, false])) },
              crashed: {
                ...rest.crashed,
                ...Object.fromEntries(marked.map((id) => [id, STOPPED_WHILE_STARTING])),
              },
            })),
      ),
    ),
    clearCrash: (pluginId: PluginId) =>
      read.pipe(
        Effect.flatMap((latest) =>
          latest.crashed?.[pluginId] === undefined
            ? Effect.void
            : write((last) => withoutCrash(last, pluginId)),
        ),
      ),
    /**
     * Saves that the plugin crashed the server and turns it off, so the next start lists it as
     * failed with its switch off. Synchronous, because Node exits right after; it throws if the
     * write fails.
     */
    recordCrash: (pluginId: PluginId, message: string) => {
      // From disk, like `write`, unless it can't be read.
      let last = Ref.getUnsafe(current);
      try {
        last = decodeConfigSync(NodeFS.readFileSync(configPath, "utf8"));
      } catch {
        // Such as a file edited by hand into invalid JSON.
      }
      // The guard knows what stopped the server, so no plugin starting then is blamed next time.
      const { starting: _starting, ...rest } = last;
      const next = {
        ...rest,
        enabled: { ...last.enabled, [pluginId]: false },
        crashed: { ...last.crashed, [pluginId]: message },
      };
      const temporary = `${configPath}.crash-${process.pid}.tmp`;
      NodeFS.writeFileSync(temporary, `${encodeConfigSync(next)}\n`);
      NodeFS.renameSync(temporary, configPath);
    },
  };
});
