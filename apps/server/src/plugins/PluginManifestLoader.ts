import {
  PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_FILE,
  PluginManifest,
  type PluginCapabilityName,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Capabilities this server implements. A plugin declaring any other is not loaded. */
const SUPPORTED_PLUGIN_CAPABILITIES: ReadonlySet<PluginCapabilityName> = new Set();

const MAX_MANIFEST_BYTES = 64 * 1024;

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));

class PluginManifestError extends Schema.TaggedError<PluginManifestError>()("PluginManifestError", {
  directory: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `Cannot load the plugin in ${this.directory}: ${this.reason}`;
  }
}

/** A validated plugin directory: what the supervisor needs to run it. */
export interface PluginRegistration {
  readonly manifest: PluginManifest;
  /** Real path of the plugin directory, used as the child's working directory. */
  readonly directory: string;
  /** Real path of the entry module, inside `directory`. */
  readonly entryPath: string;
}

/**
 * Reads and validates `t3-plugin.json` in `directory`. The entry must resolve,
 * after symlinks, to a file inside the directory, and the manifest must target
 * this server's plugin API version with only supported capabilities.
 */
export const loadPluginDirectory = Effect.fn("PluginManifestLoader.loadPluginDirectory")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (reason: string) => new PluginManifestError({ directory, reason });

  const realDirectory = yield* fs
    .realPath(directory)
    .pipe(Effect.mapError(() => fail("the directory does not exist.")));
  const manifestPath = path.join(realDirectory, PLUGIN_MANIFEST_FILE);
  const info = yield* fs
    .stat(manifestPath)
    .pipe(Effect.mapError(() => fail(`${PLUGIN_MANIFEST_FILE} is missing.`)));
  if (info.type !== "File" || Number(info.size) > MAX_MANIFEST_BYTES)
    return yield* fail(`${PLUGIN_MANIFEST_FILE} must be a file of at most 64 KiB.`);
  const raw = yield* fs
    .readFileString(manifestPath)
    .pipe(Effect.mapError(() => fail(`${PLUGIN_MANIFEST_FILE} is not readable.`)));
  const manifest = yield* decodeManifest(raw).pipe(
    Effect.mapError((error) => fail(`${PLUGIN_MANIFEST_FILE} is invalid: ${error.message}`)),
  );

  if (manifest.apiVersion !== PLUGIN_API_VERSION)
    return yield* fail(
      `it targets plugin API version ${manifest.apiVersion}; this server implements version ${PLUGIN_API_VERSION}.`,
    );
  const unsupported = manifest.capabilities.filter(
    (capability) => !SUPPORTED_PLUGIN_CAPABILITIES.has(capability),
  );
  if (unsupported.length > 0)
    return yield* fail(`this server does not support ${unsupported.join(", ")}.`);

  const entryPath = yield* fs
    .realPath(path.resolve(realDirectory, manifest.entry))
    .pipe(Effect.mapError(() => fail(`the entry ${manifest.entry} does not exist.`)));
  const relative = path.relative(realDirectory, entryPath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return yield* fail(`the entry ${manifest.entry} resolves outside the plugin directory.`);
  if (!/\.m?js$/.test(entryPath))
    return yield* fail(`the entry ${manifest.entry} must be a .js or .mjs file.`);
  const entryInfo = yield* fs
    .stat(entryPath)
    .pipe(Effect.mapError(() => fail(`the entry ${manifest.entry} is not readable.`)));
  if (entryInfo.type !== "File") return yield* fail(`the entry ${manifest.entry} is not a file.`);

  return { manifest, directory: realDirectory, entryPath } satisfies PluginRegistration;
});
