// @effect-diagnostics nodeBuiltinImport:off - The synchronous package-tree fingerprint is shared with the immutable native module loader.
import * as NodeCrypto from "node:crypto";
import {
  BUILTIN_PLUGIN_MANIFESTS,
  PluginEntryPath,
  PluginId,
  PluginManifest,
  PluginRegistryError,
  PluginRegistrySnapshot,
  type PluginRegistryInstallInput,
  type PluginRegistryInstallResult,
  type PluginRegistryListInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { builtinServiceLayer } from "./PluginKernel.ts";

export class PluginCatalog extends Context.Service<
  PluginCatalog,
  {
    readonly approvals: () => Effect.Effect<Readonly<Record<string, string>>, PluginRegistryError>;
    readonly remember: (id: string, sha256: string) => Effect.Effect<void, PluginRegistryError>;
    readonly list: (
      input?: PluginRegistryListInput,
    ) => Effect.Effect<PluginRegistrySnapshot, PluginRegistryError>;
    readonly fingerprint: (input: {
      readonly sourceDirectory: string;
    }) => Effect.Effect<{ readonly sha256: string }, PluginRegistryError>;
    readonly install: (
      input: PluginRegistryInstallInput,
    ) => Effect.Effect<PluginRegistryInstallResult, PluginRegistryError>;
  }
>()("t3/plugins/PluginCatalog") {}

const MAX_FILES = 2000;
const MAX_BYTES = 16 * 1024 * 1024;
const builtinIds = new Set(BUILTIN_PLUGIN_MANIFESTS.map((manifest) => manifest.id));
const isPluginRegistryError = Schema.is(PluginRegistryError);
const decodeEntryPath = Schema.decodeUnknownEffect(PluginEntryPath);
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(PluginManifest));
const decodeRegistry = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginRegistrySnapshot));
const decodePreferences = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean)),
);
const wrapError =
  (operation: PluginRegistryError["operation"], detail: string, id?: string) => (cause: unknown) =>
    isPluginRegistryError(cause)
      ? cause
      : new PluginRegistryError({ operation, detail, ...(id ? { id } : {}), cause });

export function fingerprintPluginFiles(
  files: readonly { readonly relativePath: string; readonly bytes: Uint8Array }[],
): string {
  const hash = NodeCrypto.createHash("sha256").update("t3-plugin-tree-v1\0");
  for (const file of [...files].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  )) {
    const filename = new TextEncoder().encode(file.relativePath);
    hash
      .update(`${filename.byteLength}\0`)
      .update(filename)
      .update(`${file.bytes.byteLength}\0`)
      .update(file.bytes);
  }
  return hash.digest("hex");
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  yield* fs
    .makeDirectory(config.stateDir, { recursive: true })
    .pipe(Effect.mapError(wrapError("read", "Could not create the plugin catalog directory.")));
  const stateRoot = yield* fs
    .realPath(config.stateDir)
    .pipe(Effect.mapError(wrapError("read", "Could not locate the plugin catalog directory.")));
  const catalogPath = path.join(stateRoot, "plugin-registry.json");
  const pluginsRoot = path.join(stateRoot, "plugins");
  const approvalsPath = path.join(stateRoot, "plugins-installed.json");
  const ApprovalMap = Schema.fromJsonString(
    Schema.Record(PluginId, Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  );
  const encodeApprovals = Schema.encodeEffect(ApprovalMap);
  const approvals = Effect.fn("PluginCatalog.approvals")(
    function* () {
      if (!(yield* fs.exists(approvalsPath))) return {};
      yield* checkedPath(stateRoot, approvalsPath);
      const info = yield* fs.stat(approvalsPath);
      if (info.type !== "File" || info.size > 1024n * 1024n)
        return yield* new PluginRegistryError({
          operation: "read",
          detail: "The installed plugin approval file is invalid.",
        });
      return yield* fs
        .readFileString(approvalsPath)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ApprovalMap)));
    },
    Effect.mapError(wrapError("read", "Could not read installed plugin approvals.")),
  );
  const remember = Effect.fn("PluginCatalog.remember")(
    function* (id: string, sha256: string) {
      const existing = yield* approvals();
      if (existing[id] === sha256) return;
      const contents = yield* encodeApprovals({ ...existing, [id]: sha256 });
      const temporary = `${approvalsPath}.${process.pid}.tmp`;
      yield* Effect.ensuring(
        fs
          .writeFileString(temporary, contents)
          .pipe(Effect.andThen(fs.rename(temporary, approvalsPath))),
        fs.remove(temporary, { force: true }).pipe(Effect.ignore),
      );
    },
    (effect, id) =>
      effect.pipe(
        Effect.mapError(wrapError("install", "Could not save installed plugin approval.", id)),
      ),
  );

  const contained = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative.length > 0 &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };

  const checkedPath = Effect.fn("PluginCatalog.checkedPath")(function* (
    root: string,
    candidate: string,
  ) {
    if (!contained(root, candidate))
      return yield* new PluginRegistryError({
        operation: "read",
        detail: "Plugin catalog paths must stay inside their source directory.",
      });
    const canonical = yield* fs.realPath(candidate);
    if (canonical !== candidate)
      return yield* new PluginRegistryError({
        operation: "read",
        detail: "Plugin catalog paths cannot contain symlinks.",
      });
    return canonical;
  });

  const readCatalog = Effect.fn("PluginCatalog.readCatalog")(
    function* () {
      if (!(yield* fs.exists(catalogPath))) return { entries: [] };
      yield* checkedPath(stateRoot, catalogPath);
      const info = yield* fs.stat(catalogPath);
      if (info.type !== "File" || info.size > 1024n * 1024n)
        return yield* new PluginRegistryError({
          operation: "read",
          detail: "The plugin catalog must be a JSON file smaller than 1 MiB.",
        });
      const snapshot = yield* fs.readFileString(catalogPath).pipe(Effect.flatMap(decodeRegistry));
      const ids = new Set<string>();
      for (const entry of snapshot.entries) {
        if (ids.has(entry.manifest.id) || builtinIds.has(entry.manifest.id))
          return yield* new PluginRegistryError({
            operation: "read",
            id: entry.manifest.id,
            detail:
              "Catalog plugin ids must be unique and cannot replace bundled plugin identities.",
          });
        ids.add(entry.manifest.id);
      }
      return snapshot;
    },
    Effect.mapError(wrapError("read", "Could not read the reviewed plugin catalog.")),
  );

  const readTree = Effect.fn("PluginCatalog.readTree")(
    function* (sourceDirectory: string) {
      yield* decodeEntryPath(sourceDirectory);
      const root = path.resolve(stateRoot, sourceDirectory);
      yield* checkedPath(stateRoot, root);
      if ((yield* fs.stat(root)).type !== "Directory")
        return yield* new PluginRegistryError({
          operation: "fingerprint",
          detail: "A catalog plugin source must be a directory.",
        });
      const files: { relativePath: string; bytes: Uint8Array }[] = [];
      let totalBytes = 0;
      let examined = 0;
      const walk = Effect.fn("PluginCatalog.walk")(function* (
        directory: string,
      ): Effect.fn.Return<void, PluginRegistryError | PlatformError.PlatformError> {
        for (const name of (yield* fs.readDirectory(directory)).toSorted()) {
          examined += 1;
          if (examined > MAX_FILES)
            return yield* new PluginRegistryError({
              operation: "fingerprint",
              detail: "A catalog plugin contains too many files or directories.",
            });
          const filename = path.resolve(directory, name);
          yield* checkedPath(root, filename);
          const info = yield* fs.stat(filename);
          if (info.type === "Directory") yield* walk(filename);
          else if (info.type === "File") {
            totalBytes += Number(info.size);
            if (totalBytes > MAX_BYTES)
              return yield* new PluginRegistryError({
                operation: "fingerprint",
                detail: "A catalog plugin exceeds the 16 MiB package limit.",
              });
            const bytes = yield* fs.readFile(filename);
            yield* checkedPath(root, filename);
            if (bytes.byteLength !== Number(info.size))
              return yield* new PluginRegistryError({
                operation: "fingerprint",
                detail: "The catalog plugin changed while being read.",
              });
            files.push({
              relativePath: path.relative(root, filename).split(path.sep).join("/"),
              bytes,
            });
          } else
            return yield* new PluginRegistryError({
              operation: "fingerprint",
              detail: "Catalog plugins may contain only regular files and directories.",
            });
        }
      });
      yield* walk(root);
      return { files, sha256: fingerprintPluginFiles(files) };
    },
    Effect.mapError(wrapError("fingerprint", "Could not verify the catalog plugin source tree.")),
  );

  const list = Effect.fn("PluginCatalog.list")(function* (input: PluginRegistryListInput = {}) {
    const snapshot = yield* readCatalog();
    const query = input.query?.trim().toLocaleLowerCase();
    return query
      ? {
          entries: snapshot.entries.filter((entry) =>
            [
              entry.manifest.id,
              entry.manifest.name,
              entry.manifest.description ?? "",
              entry.publisher.name,
              entry.review.summary ?? "",
            ].some((value) => value.toLocaleLowerCase().includes(query)),
          ),
        }
      : snapshot;
  });

  const install = Effect.fn("PluginCatalog.install")(
    function* (input: PluginRegistryInstallInput) {
      const snapshot = yield* readCatalog();
      const entry = snapshot.entries.find((candidate) => candidate.manifest.id === input.id);
      if (!entry)
        return yield* new PluginRegistryError({
          operation: "install",
          id: input.id,
          detail: "This plugin is not in the host's reviewed catalog.",
        });
      const tree = yield* readTree(entry.sourceDirectory);
      if (tree.sha256 !== entry.sha256)
        return yield* new PluginRegistryError({
          operation: "install",
          id: input.id,
          detail: "The plugin source no longer matches its reviewed SHA-256 fingerprint.",
        });
      const manifestFile = tree.files.find((file) => file.relativePath === "plugin.json");
      if (!manifestFile)
        return yield* new PluginRegistryError({
          operation: "install",
          id: input.id,
          detail: "The reviewed source is missing plugin.json.",
        });
      const manifest = yield* decodeManifest(new TextDecoder().decode(manifestFile.bytes));
      if ((yield* encodeManifest(manifest)) !== (yield* encodeManifest(entry.manifest)))
        return yield* new PluginRegistryError({
          operation: "install",
          id: input.id,
          detail: "The source manifest differs from the reviewed catalog manifest.",
        });
      for (const entrypoint of Object.values(manifest.entries ?? {})) {
        const normalized = entrypoint ? path.normalize(entrypoint).split(path.sep).join("/") : null;
        if (normalized && !tree.files.some((file) => file.relativePath === normalized))
          return yield* new PluginRegistryError({
            operation: "install",
            id: input.id,
            detail: "A reviewed plugin entrypoint is missing from the source tree.",
          });
      }
      yield* fs.makeDirectory(pluginsRoot, { recursive: true });
      yield* checkedPath(stateRoot, pluginsRoot);
      const destination = path.join(pluginsRoot, input.id);
      if (yield* fs.exists(destination))
        return yield* new PluginRegistryError({
          operation: "install",
          id: input.id,
          detail:
            "This plugin is already installed; catalog installs do not overwrite local plugins.",
        });
      const preferencePath = path.join(stateRoot, "plugins-state.json");
      if (yield* fs.exists(preferencePath)) {
        yield* checkedPath(stateRoot, preferencePath);
        const preferences = yield* fs
          .readFileString(preferencePath)
          .pipe(Effect.flatMap(decodePreferences));
        if (preferences[input.id])
          return yield* new PluginRegistryError({
            operation: "install",
            id: input.id,
            detail: "Disable the plugin's saved preference before installing it from the catalog.",
          });
      }
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const stage = yield* Effect.acquireRelease(
            fs.makeTempDirectory({ directory: stateRoot, prefix: ".plugin-install-" }),
            (directory) =>
              fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
          );
          for (const file of tree.files) {
            const target = path.join(stage, ...file.relativePath.split("/"));
            yield* fs.makeDirectory(path.dirname(target), { recursive: true });
            yield* fs.writeFile(target, file.bytes, { flag: "wx" });
          }
          yield* checkedPath(stateRoot, pluginsRoot);
          if (yield* fs.exists(destination))
            return yield* new PluginRegistryError({
              operation: "install",
              id: input.id,
              detail: "The plugin destination appeared during installation.",
            });
          yield* fs.rename(stage, destination);
          yield* remember(input.id, entry.sha256);
          return { manifest, directory: destination, enabled: false as const };
        }),
      );
    },
    Effect.mapError(wrapError("install", "Could not install the reviewed plugin.")),
  );

  return PluginCatalog.of({
    approvals,
    remember: Effect.fn("PluginCatalog.remember")((id: string, sha256: string) =>
      lock.withPermits(1)(remember(id, sha256)),
    ),
    list,
    fingerprint: Effect.fn("PluginCatalog.fingerprint")(
      (input: { readonly sourceDirectory: string }) =>
        readTree(input.sourceDirectory).pipe(Effect.map(({ sha256 }) => ({ sha256 }))),
    ),
    install: Effect.fn("PluginCatalog.install")((input: PluginRegistryInstallInput) =>
      lock.withPermits(1)(install(input)),
    ),
  });
});

export const layer = builtinServiceLayer("t3.server")(PluginCatalog, make);
