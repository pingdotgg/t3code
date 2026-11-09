import {
  PluginId,
  PluginManifest,
  type PluginFailure,
  type PluginSource,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { settingsSchemaProblem } from "./PluginSettingsStore.ts";

const PLUGIN_MANIFEST_FILE = "t3-plugin.json";

// Discovery runs at startup and on every reload, so a plugins folder full of unrelated
// directories or an oversized manifest must not stall the server.
const MAX_PLUGIN_DIRECTORIES = 64;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_FAILURE_MESSAGE_CHARS = 500;
const MAX_UNKNOWN_KEYS = 16;
const MAX_UNKNOWN_KEY_CHARS = 64;

const decodeManifest = Schema.decodeUnknownExit(Schema.fromJsonString(PluginManifest));
const decodeLooseId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: PluginId })),
);
const isPluginId = Schema.is(PluginId);
const decodeManifestKeys = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);
const KNOWN_MANIFEST_KEYS: ReadonlySet<string> = new Set(Object.keys(PluginManifest.fields));

// Decoding drops keys it doesn't know, so a newer manifest still loads; the row names them instead.
const unknownKeysOf = (raw: string) => {
  const keys = decodeManifestKeys(raw);
  return keys._tag === "None"
    ? []
    : Object.keys(keys.value)
        .filter((key) => !KNOWN_MANIFEST_KEYS.has(key))
        .slice(0, MAX_UNKNOWN_KEYS)
        .map((key) => key.slice(0, MAX_UNKNOWN_KEY_CHARS));
};

const causeMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

interface PluginLocation {
  readonly id: PluginId;
  readonly rootDir: string;
  /** The folder as listed, before links resolve. Installed ones are inside the plugins folder. */
  readonly folder: string;
  readonly source: PluginSource;
}

export type DiscoveredPlugin = PluginLocation &
  (
    | { readonly manifest: PluginManifest; readonly unknownKeys?: ReadonlyArray<string> }
    | { readonly failure: PluginFailure }
  );

const failed = (location: PluginLocation, failure: PluginFailure): DiscoveredPlugin => ({
  ...location,
  failure: { ...failure, message: failure.message.slice(0, MAX_FAILURE_MESSAGE_CHARS) },
});

const isGone = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

/**
 * Lists installed plugins (`<pluginsDir>/<any folder>/t3-plugin.json`), then dev plugins
 * (`devPaths`). An id more than one folder has is listed once, as failed. `complete` is false when
 * a folder could not be read, such as a link into a drive that isn't mounted, so a plugin missing
 * from the list may still be there.
 */
export const discoverPlugins = Effect.fn("PluginDiscovery.discover")(function* (input: {
  readonly pluginsDir: string;
  readonly devPaths: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  let complete = true;
  const unreadable = (folder: string, error: PlatformError.PlatformError) => {
    complete = false;
    return `Could not read the folder "${path.basename(folder)}" (${error.reason._tag}). It keeps its switch; reload once the folder is back.`;
  };

  // The helpers below run for every plugin folder inside the discovery span.
  const readManifest = Effect.fnUntraced(function* (rootDir: string) {
    const manifestPath = path.join(rootDir, PLUGIN_MANIFEST_FILE);
    const info = yield* fs.stat(manifestPath).pipe(Effect.result);
    if (info._tag === "Failure") {
      return isGone(info.failure)
        ? ({ _tag: "Missing" } as const)
        : ({ _tag: "Unreadable", message: unreadable(rootDir, info.failure) } as const);
    }
    if (info.success.type !== "File") return { _tag: "Missing" } as const;
    if (Number(info.success.size) > MAX_MANIFEST_BYTES) {
      return { _tag: "TooLarge" } as const;
    }
    const raw = yield* fs.readFileString(manifestPath).pipe(Effect.result);
    if (raw._tag === "Success") return { _tag: "Read", raw: raw.success } as const;
    return isGone(raw.failure)
      ? ({ _tag: "Missing" } as const)
      : ({ _tag: "Unreadable", message: unreadable(rootDir, raw.failure) } as const);
  });

  // Node caches modules by real path, so reload can only find a plugin's modules by its real root.
  const inspect = Effect.fnUntraced(function* (
    location: string,
    source: PluginSource,
    fallbackId: PluginId | undefined,
  ) {
    const rootDir = yield* fs.realPath(location).pipe(Effect.orElseSucceed(() => location));
    const manifest = yield* readManifest(rootDir);
    if (manifest._tag !== "Read") {
      if (fallbackId === undefined) return undefined;
      return failed(
        { id: fallbackId, rootDir, folder: location, source },
        {
          stage: "discovery",
          message:
            manifest._tag === "Missing"
              ? `No ${PLUGIN_MANIFEST_FILE} in the plugin folder.`
              : manifest._tag === "Unreadable"
                ? manifest.message
                : `${PLUGIN_MANIFEST_FILE} is larger than ${MAX_MANIFEST_BYTES} bytes.`,
        },
      );
    }
    const decoded = decodeManifest(manifest.raw);
    if (decoded._tag === "Success") {
      const copy = { id: decoded.value.id, rootDir, folder: location, source };
      const { settingsSchema } = decoded.value;
      const schemaProblem =
        settingsSchema === undefined ? undefined : settingsSchemaProblem(settingsSchema);
      const unknownKeys = unknownKeysOf(manifest.raw);
      return schemaProblem === undefined
        ? { ...copy, manifest: decoded.value, ...(unknownKeys.length === 0 ? {} : { unknownKeys }) }
        : failed(copy, {
            stage: "manifest",
            message: `T3 Code cannot validate its settingsSchema: ${schemaProblem}`,
          });
    }
    const looseId = decodeLooseId(manifest.raw);
    const id = looseId._tag === "Some" ? looseId.value.id : fallbackId;
    if (id === undefined) return undefined;
    return failed(
      { id, rootDir, folder: location, source },
      {
        stage: "manifest",
        message: `Invalid ${PLUGIN_MANIFEST_FILE}: ${causeMessage(decoded.cause)}`,
      },
    );
  });

  interface Copies {
    readonly first: DiscoveredPlugin;
    readonly others: Array<DiscoveredPlugin>;
  }
  const copiesById = new Map<PluginId, Copies>();
  const add = (plugin: DiscoveredPlugin) => {
    const copies = copiesById.get(plugin.id);
    if (copies === undefined) copiesById.set(plugin.id, { first: plugin, others: [] });
    else copies.others.push(plugin);
  };
  // Settings, storage and the switch belong to the id, so no copy runs until one is left. Folder
  // names only: clients that cannot manage plugins see failures but not paths.
  const listOnce = ({ first, others }: Copies): DiscoveredPlugin => {
    if (others.length === 0) return first;
    const names = [first, ...others].map(
      (copy) =>
        `"${path.basename(copy.folder)}" (${copy.source === "dev" ? "linked" : "installed"})`,
    );
    const { id, rootDir, folder, source } = first;
    return failed(
      { id, rootDir, folder, source },
      {
        stage: "duplicate",
        message: `The folders ${names.slice(0, -1).join(", ")} and ${names.at(-1)} ${others.length === 1 ? "both" : "all"} have the id ${id}. Delete ${others.length === 1 ? "one" : "all but one"} of them, then reload.`,
      },
    );
  };
  let examined = 0;
  const underLimit = Effect.fnUntraced(function* (location: string) {
    examined += 1;
    if (examined <= MAX_PLUGIN_DIRECTORIES) return true;
    yield* Effect.logWarning("ignoring plugin folders past the limit", {
      path: location,
      limit: MAX_PLUGIN_DIRECTORIES,
    });
    return false;
  });

  const entries = yield* fs.readDirectory(input.pluginsDir).pipe(
    Effect.catchTags({
      PlatformError: (error) => {
        if (isGone(error)) return Effect.succeed([]);
        complete = false;
        return Effect.logWarning("could not read the plugins folder", {
          path: input.pluginsDir,
          reason: error.reason._tag,
        }).pipe(Effect.as([]));
      },
    }),
  );
  // People copy plugin folders in by hand, so the manifest names the plugin, not the folder.
  for (const entry of entries.toSorted()) {
    if (entry.startsWith(".")) continue;
    const folder = path.join(input.pluginsDir, entry);
    const info = yield* fs.stat(folder).pipe(Effect.result);
    if (info._tag === "Success" && info.success.type !== "Directory") continue;
    if (!(yield* underLimit(input.pluginsDir))) break;
    const fallbackId = isPluginId(entry) ? entry : undefined;
    let plugin: DiscoveredPlugin | undefined;
    if (info._tag === "Success") {
      plugin = yield* inspect(folder, "installed", fallbackId);
    } else {
      // Listed but unreadable, such as a link into a drive that isn't mounted, so not gone.
      const message = unreadable(folder, info.failure);
      plugin =
        fallbackId === undefined
          ? undefined
          : failed(
              { id: fallbackId, rootDir: folder, folder, source: "installed" },
              { stage: "discovery", message },
            );
    }
    if (plugin === undefined) {
      yield* Effect.logWarning("ignoring plugin folder without a plugin id", { path: folder });
      continue;
    }
    add(plugin);
  }

  for (const devPath of input.devPaths) {
    const rootDir = path.resolve(devPath);
    if (!(yield* underLimit(rootDir))) break;
    const basename = path.basename(rootDir);
    const plugin = yield* inspect(rootDir, "dev", isPluginId(basename) ? basename : undefined);
    if (plugin === undefined) {
      yield* Effect.logWarning("ignoring dev plugin path without a usable plugin id", {
        path: rootDir,
      });
      continue;
    }
    add(plugin);
  }

  return { plugins: [...copiesById.values()].map(listOnce), complete };
});
