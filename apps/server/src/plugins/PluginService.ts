import { HttpServerRequest, HttpServerResponse } from "effect/http";
// @effect-diagnostics nodeBuiltinImport:off - Generation copies and native ESM import are the local plugin loader boundary.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  BUILTIN_PLUGIN_MANIFESTS,
  PluginError,
  PluginId,
  PluginManifest,
  type PluginInvokeInput,
  type PluginAuthoringGuideInput,
  type PluginAuthoringGuide,
  type PluginListInput,
  type PluginReloadInput,
  type PluginSetEnabledInput,
  type PluginSnapshot,
  PluginStatus,
  PluginRegistryError,
  type PluginRegistryInstallInput,
  type PluginRegistryInstallResult,
  type PluginRegistryListInput,
  type PluginRegistrySnapshot,
  type PluginRegistryEntry,
  OrchestrationV2DomainEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import { executePlugin as execute, runBuiltinPluginWrappers } from "./pluginBoundary.ts";
import {
  ProviderDriverCatalog,
  validateProviderDriverContributions,
  type ProviderDriverContribution,
} from "../provider/ProviderDriverCatalog.ts";
import { PluginCatalog, fingerprintPluginFiles } from "./PluginCatalog.ts";
import { createPluginAuthoringGuide } from "./PluginAuthoring.ts";
import { EventSinkV2, type EventSinkV2Shape } from "../orchestration-v2/EventSink.ts";
import { startPluginEventSubscriptions, type PluginEventSubscription } from "./PluginEvents.ts";
import { compilePluginEntries } from "@t3tools/shared/pluginCompiler";
import {
  installPluginRuntime,
  pluginEffectModules,
  pluginModuleExports,
  pluginWebModuleExports,
  PLUGIN_WEB_RUNTIME_KEY,
} from "@t3tools/shared/pluginRuntime";
import {
  BUILT_IN_PROVIDER_PLUGIN_DEFINITIONS,
  type BuiltInDriversEnv,
} from "../provider/builtInDrivers.ts";
import type {
  PluginCommand,
  ServerPluginHost as SdkServerPluginHost,
  ServerPluginDefinition as SdkServerPluginDefinition,
} from "@t3tools/plugin-sdk/server";
export type { PluginCommand } from "@t3tools/plugin-sdk/server";
import { COMPILED_SERVER_BUILTINS, getCompiledServerBuiltin } from "./builtin/catalog.ts";
import {
  builtinServiceLayer,
  PluginKernel,
  type PluginServiceContribution,
} from "./PluginKernel.ts";

const compileCommand = <Input, Output>(command: PluginCommand<Input, Output>) => ({
  // Invocation decodes the input before crossing this erased generation boundary.
  run: (input: unknown): unknown => command.run(input as Input),
  decodeInput: command.input ? Schema.decodeUnknownEffect(command.input) : undefined,
  encodeOutput: command.output ? Schema.encodeUnknownEffect(command.output) : undefined,
});
const isPluginId = Schema.is(PluginId);
const isThreadId = Schema.is(ThreadId);
const eventTypes = new Set(
  OrchestrationV2DomainEvent.members.flatMap((member) => {
    const type = member.fields.type;
    return "literals" in type ? type.literals : [type.literal];
  }),
);
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(PluginManifest));
const encodeStatuses = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(PluginStatus)));
const PreferencesJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean));
const decodePreferences = Schema.decodeUnknownEffect(PreferencesJson);
const encodePreferences = Schema.encodeEffect(PreferencesJson);

/** Builtins and source plugins share the public host contract. */
export type ServerPluginHost = SdkServerPluginHost<BuiltInDriversEnv>;
export type ServerPluginDefinition = SdkServerPluginDefinition<ServerPluginHost>;

export interface PluginServiceShape {
  readonly startEvents: (eventSink: EventSinkV2Shape) => Effect.Effect<void, PluginError>;
  readonly handleHttp: (
    id: string,
    method: string,
    path: string,
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, PluginError, Scope.Scope>;
  readonly list: (input?: PluginListInput) => Effect.Effect<PluginSnapshot>;
  readonly authoringGuide: (
    input?: PluginAuthoringGuideInput,
  ) => Effect.Effect<PluginAuthoringGuide>;
  readonly registryList: (
    input?: PluginRegistryListInput,
  ) => Effect.Effect<PluginRegistrySnapshot, PluginRegistryError>;
  readonly registryInstall: <E = never>(
    input: PluginRegistryInstallInput,
    authorize?: Effect.Effect<void, E>,
  ) => Effect.Effect<PluginRegistryInstallResult, PluginRegistryError | PluginError | E>;
  readonly setEnabled: <E = never>(
    input: PluginSetEnabledInput,
    authorize?: Effect.Effect<void, E>,
  ) => Effect.Effect<PluginSnapshot, PluginError | E>;
  readonly reload: <E = never>(
    input?: PluginReloadInput,
    authorize?: Effect.Effect<void, E>,
  ) => Effect.Effect<PluginSnapshot, PluginError | E>;
  readonly invoke: <E = never>(
    input: PluginInvokeInput,
    authorize?: Effect.Effect<void, E>,
  ) => Effect.Effect<{ readonly output: unknown }, PluginError | E>;
  readonly subscribe: (input?: PluginListInput) => Stream.Stream<PluginSnapshot>;
  readonly interceptBuiltin: <A, E, R>(
    pluginId: string,
    method: string,
    input: unknown,
    next: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly resolveAsset: (
    id: string,
    revision: number,
    token: string,
    relativePath: string,
  ) => Effect.Effect<string | undefined, PluginError>;
}

export class PluginService extends Context.Service<PluginService, PluginServiceShape>()(
  "t3/plugins/PluginService",
) {}

interface Generation {
  readonly status: PluginStatus;
  readonly serverEntry?: string;
  readonly eventSubscriptions: ReadonlyArray<PluginEventSubscription>;
  eventsStarted: boolean;
  readonly scope: Scope.Closeable;
  readonly commands: ReadonlyMap<string, ReturnType<typeof compileCommand>>;
  readonly httpHandlers: ReadonlyMap<string, Parameters<ServerPluginHost["http"]["register"]>[2]>;
  readonly directory?: string;
  readonly fingerprint: string;
  readonly token: string;
  readonly wrappers: ReadonlyMap<string, Parameters<ServerPluginHost["commands"]["wrap"]>[2]>;
  inFlight: number;
  retiring: boolean;
  readonly providers: ReadonlyArray<ProviderDriverContribution["driver"]>;
  unregisterProviders?: Effect.Effect<void>;
  readonly services: ReadonlyArray<PluginServiceContribution>;
  unregisterServices?: Effect.Effect<void>;
  readonly assetLifetime: { retained: boolean; closed: boolean };
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const attempt = <A>(operation: () => Promise<A>, id?: string) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => new PluginError({ message: message(cause), ...(id ? { id } : {}) }),
  });

const relativeEntry = (root: string, entry: string) => {
  if (entry.includes("\\") || entry.includes("\0") || NodePath.isAbsolute(entry)) {
    throw new Error("Plugin entries must be relative paths inside the plugin directory.");
  }
  const resolved = NodePath.resolve(root, entry);
  if (resolved === root || !resolved.startsWith(`${root}${NodePath.sep}`)) {
    throw new Error("Plugin entry escapes its directory.");
  }
  return resolved;
};

const MAX_PLUGIN_ENTRIES = 2000;
const MAX_PLUGIN_BYTES = 16 * 1024 * 1024;
const MAX_PLUGIN_MANIFEST_BYTES = 256 * 1024;
/** These implementations remain replaceable, but the host needs them to manage and recover plugins. */
const REQUIRED_HOST_PLUGINS = new Set([
  "t3.persistence",
  "t3.auth",
  "t3.http",
  "t3.server",
  "t3.client",
  "t3.desktop",
  "t3.mobile",
]);

/** Bound discovery and reject symlinks before reading a copied generation. */
async function filesIn(root: string): Promise<ReadonlyArray<string>> {
  const files: string[] = [];
  let examined = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = await NodeFSP.opendir(directory);
    for await (const entry of entries) {
      examined += 1;
      if (examined > MAX_PLUGIN_ENTRIES)
        throw new Error("A plugin contains more than 2,000 files or directories.");
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const absolute = NodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Plugin directories cannot contain symlinks.");
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(NodePath.relative(root, absolute));
      else throw new Error("Plugins may contain only regular files and directories.");
    }
  };
  await walk(root);
  return files.sort();
}

async function readPluginFile(filename: string, maxBytes: number): Promise<Buffer> {
  const handle = await NodeFSP.open(
    filename,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Plugins may contain only regular files.");
    if (info.size > maxBytes) throw new Error("The plugin file exceeds its package size limit.");
    // One extra byte detects growth without allocating an unbounded readFile buffer.
    const buffer = Buffer.alloc(info.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const chunk = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw new Error("The plugin changed while its files were being copied. Reload it again.");
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const definition = (value: unknown): ServerPluginDefinition => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("activate" in value) ||
    typeof value.activate !== "function"
  ) {
    throw new Error(
      "A server entry must export activate(host) or a default object with activate(host).",
    );
  }
  return value as ServerPluginDefinition;
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const secureRandom = yield* SecureRandom.SecureRandom;
  const providerCatalog = yield* ProviderDriverCatalog;
  const kernel = yield* PluginKernel;
  const catalog = yield* PluginCatalog;
  const root = NodePath.join(config.stateDir, "plugins");
  const cache = NodePath.join(config.stateDir, "plugin-generations");
  const statePath = NodePath.join(config.stateDir, "plugins-state.json");
  yield* attempt(async () => {
    await NodeFSP.mkdir(root, { recursive: true });
    await NodeFSP.mkdir(cache, { recursive: true });
  });
  const preferenceText = yield* attempt(async () => {
    try {
      return await NodeFSP.readFile(statePath, "utf8");
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
        return "{}";
      throw cause;
    }
  });
  const preferences = yield* decodePreferences(preferenceText).pipe(
    Effect.catch((cause) =>
      Effect.logWarning(
        "Plugin preferences are invalid; local plugins remain disabled",
        cause,
      ).pipe(Effect.as({})),
    ),
  );
  const enabled = yield* Ref.make<Readonly<Record<string, boolean>>>(preferences);
  yield* providerCatalog.setEnabled((yield* Ref.get(enabled))["t3.providers"] !== false);
  const setBuiltinEnabled = Effect.fn("PluginService.setBuiltinEnabled")(function* (
    id: string,
    value: boolean,
  ) {
    // Stop admission before resources retire; restore it after factories restart.
    if (id === "t3.providers" && !value) yield* providerCatalog.setEnabled(false);
    yield* kernel.setEnabled(id, value);
    if (id === "t3.providers" && value) yield* providerCatalog.setEnabled(true);
  });
  const generations = yield* Ref.make<ReadonlyMap<string, Generation>>(new Map());
  const statuses = yield* Ref.make<ReadonlyMap<string, PluginStatus>>(new Map());
  const revision = yield* Ref.make(0);
  const changes = yield* PubSub.unbounded<PluginSnapshot>();
  const lock = yield* Semaphore.make(1);
  const parentScope = yield* Scope.Scope;
  const retired = new Set<Generation>();
  const generationScopes = new Set<Scope.Closeable>();
  const assetHistory = new Map<string, Array<{ generation: Generation; expiresAt: number }>>();
  let eventSink: EventSinkV2Shape | undefined;
  let nextGeneration = yield* Clock.currentTimeMillis;
  let wrapperIndex = new Map<
    string,
    ReadonlyArray<{
      generation: Generation;
      wrap: Parameters<ServerPluginHost["commands"]["wrap"]>[2];
    }>
  >();
  const indexWrappers = (current: ReadonlyMap<string, Generation>) => {
    const next = new Map<
      string,
      Array<{ generation: Generation; wrap: Parameters<ServerPluginHost["commands"]["wrap"]>[2] }>
    >();
    for (const generation of current.values()) {
      if (!generation.status.enabled) continue;
      for (const [key, wrap] of generation.wrappers) {
        const entries = next.get(key) ?? [];
        entries.push({ generation, wrap });
        next.set(key, entries);
      }
    }
    wrapperIndex = next;
  };

  const list = Effect.fn("PluginService.list")(function* (input: PluginListInput = {}) {
    const query = input.query?.trim().toLowerCase();
    const plugins = [...(yield* Ref.get(statuses)).values()].filter(
      (plugin) =>
        !query ||
        `${plugin.manifest.id} ${plugin.manifest.name} ${plugin.manifest.description ?? ""}`
          .toLowerCase()
          .includes(query),
    );
    return { revision: yield* Ref.get(revision), plugins };
  });
  const publish = Effect.gen(function* () {
    yield* Ref.update(revision, (value) => value + 1);
    yield* PubSub.publish(changes, yield* list());
  });
  const close = (generation: Generation) =>
    Scope.close(generation.scope, Exit.void).pipe(Effect.ignore);
  const dropAssets = Effect.fn("PluginService.dropAssets")(function* (generation: Generation) {
    generation.assetLifetime.retained = false;
    if (generation.directory && generation.assetLifetime.closed) {
      yield* attempt(() =>
        NodeFSP.rm(generation.directory!, { recursive: true, force: true }),
      ).pipe(Effect.ignore);
    }
  });
  const pruneAssets = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [id, entries] of assetHistory) {
      const keep = entries.filter((entry) => entry.expiresAt > now);
      assetHistory.set(id, keep);
      for (const entry of entries) if (!keep.includes(entry)) yield* dropAssets(entry.generation);
      if (keep.length === 0) assetHistory.delete(id);
    }
  });
  const revokeAssets = Effect.fn("PluginService.revokeAssets")(function* (id: string) {
    const entries = assetHistory.get(id) ?? [];
    assetHistory.delete(id);
    for (const entry of entries) yield* dropAssets(entry.generation);
  });
  const retire = Effect.fn("PluginService.retire")(function* (generation: Generation) {
    generation.retiring = true;
    if (generation.unregisterProviders) yield* generation.unregisterProviders;
    if (generation.unregisterServices) yield* generation.unregisterServices;
    const replacement = (yield* Ref.get(generations)).get(generation.status.manifest.id);
    if (
      generation.directory &&
      generation.status.enabled &&
      (generation.status.manifest.entries?.web || generation.status.manifest.entries?.mobile) &&
      replacement?.status.enabled
    ) {
      generation.assetLifetime.retained = true;
      const entries = [
        ...(assetHistory.get(generation.status.manifest.id) ?? []),
        { generation, expiresAt: (yield* Clock.currentTimeMillis) + 5 * 60_000 },
      ];
      assetHistory.set(generation.status.manifest.id, entries.slice(-2));
      for (const expired of entries.slice(0, -2)) yield* dropAssets(expired.generation);
      yield* pruneAssets;
    } else yield* revokeAssets(generation.status.manifest.id);
    if (generation.inFlight === 0) yield* close(generation);
    else retired.add(generation);
  });
  const releaseGeneration = Effect.fn("PluginService.releaseGeneration")(function* (
    generation: Generation,
    deferClose: boolean,
  ) {
    generation.inFlight -= 1;
    if (retired.has(generation) && generation.inFlight === 0) {
      retired.delete(generation);
      // Event handlers run under this scope, so their final release closes it from outside.
      if (deferClose) yield* close(generation).pipe(Effect.forkIn(parentScope));
      else yield* close(generation);
    }
  });
  const release = (generation: Generation) => releaseGeneration(generation, false);
  const startGenerationEvents = Effect.fn("PluginService.startGenerationEvents")(function* (
    generation: Generation,
    afterSequence?: number,
  ) {
    if (!eventSink || generation.eventsStarted || !generation.status.enabled || generation.retiring)
      return;
    yield* startPluginEventSubscriptions({
      id: generation.status.manifest.id,
      eventSink,
      scope: generation.scope,
      ...(afterSequence === undefined ? {} : { afterSequence }),
      subscriptions: generation.eventSubscriptions.map((subscription) => ({
        filter: subscription.filter,
        cursor: subscription.cursor,
        handler: (event) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              if (generation.retiring) return false;
              generation.inFlight += 1;
              subscription.cursor.afterSequence = event.sequence;
              return true;
            }),
            (admitted) => (admitted ? execute(() => subscription.handler(event)) : Effect.void),
            (admitted) => (admitted ? releaseGeneration(generation, true) : Effect.void),
          ),
      })),
    });
    generation.eventsStarted = true;
  });
  yield* Scope.addFinalizer(
    parentScope,
    Effect.gen(function* () {
      const current = yield* Ref.get(generations);
      // Contributions retain their module generation until their own scopes finish draining.
      for (const generation of new Set([...current.values(), ...retired])) {
        if (generation.unregisterProviders) yield* generation.unregisterProviders;
        if (generation.unregisterServices) yield* generation.unregisterServices;
      }
      const scopesToClose = Array.from(generationScopes);
      for (const scope of scopesToClose) yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
      const previousAssets = [...assetHistory.values()].flatMap((entries) =>
        entries.map((entry) => entry.generation),
      );
      for (const generation of new Set([...current.values(), ...retired, ...previousAssets])) {
        yield* close(generation);
        yield* dropAssets(generation);
      }
      assetHistory.clear();
      yield* PubSub.shutdown(changes);
    }),
  );

  const build = Effect.fn("PluginService.build")(function* (
    manifest: PluginManifest,
    source: "builtin" | "local",
    sourceDirectory?: string,
    reviewed?: PluginRegistryEntry,
    approvedSha256?: string,
  ) {
    const id = manifest.id;
    const isEnabled = (yield* Ref.get(enabled))[id] ?? source === "builtin";
    const generationRevision = ++nextGeneration;
    const scope = yield* Scope.make();
    generationScopes.add(scope);
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        generationScopes.delete(scope);
      }),
    );
    const commands = new Map<string, ReturnType<typeof compileCommand>>();
    const httpHandlers = new Map<string, Parameters<ServerPluginHost["http"]["register"]>[2]>();
    const wrappers = new Map<string, Parameters<ServerPluginHost["commands"]["wrap"]>[2]>();
    const token = yield* secureRandom.uuidV4();
    const providers: Array<ProviderDriverContribution["driver"]> = [];
    const services: PluginServiceContribution[] = [];
    const eventSubscriptions: PluginEventSubscription[] = [];
    let registering = true;
    let disposalStarted = false;
    const cleanup: Array<() => void | Promise<void>> = [];
    const runLateCleanup = Effect.runForkWith(yield* Effect.context<never>());
    const disposeCallback = (dispose: () => void | Promise<void>) =>
      attempt(async () => {
        await dispose();
      }, id).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Plugin cleanup failed", { id, detail: cause.message }),
        ),
      );
    const assetLifetime = { retained: false, closed: false };
    const serverRuntimeKey = `t3.plugin-runtime.server.${token}`;
    let removeRuntime: (() => void) | undefined;
    let directory: string | undefined;
    let fingerprint = `${manifest.version}:${isEnabled}`;
    let verifiedSource: PluginStatus["source"] = source;
    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* () {
        disposalStarted = true;
        registering = false;
        yield* Effect.gen(function* () {
          for (const dispose of cleanup.splice(0).toReversed()) yield* disposeCallback(dispose);
        }).pipe(
          Effect.interruptible,
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.logWarning("Plugin cleanup exceeded 10 seconds", { id }),
          }),
        );
        assetLifetime.closed = true;
        removeRuntime?.();
        if (directory && !assetLifetime.retained)
          yield* attempt(() => NodeFSP.rm(directory!, { recursive: true, force: true }), id).pipe(
            Effect.ignore,
          );
      }),
    );
    const loaded = yield* Effect.gen(function* () {
      let contentSha256: string | undefined;
      let copiedFiles: Array<{ path: string; bytes: Buffer }> = [];
      if (sourceDirectory) {
        const files = yield* attempt(() => filesIn(sourceDirectory), id);
        copiedFiles = yield* attempt(async () => {
          const copied: Array<{ path: string; bytes: Buffer }> = [];
          let totalBytes = 0;
          for (const file of files) {
            const filename = relativeEntry(sourceDirectory, file);
            const remainingBytes = MAX_PLUGIN_BYTES - totalBytes;
            const bytes = await readPluginFile(
              filename,
              file === "plugin.json"
                ? Math.min(MAX_PLUGIN_MANIFEST_BYTES, remainingBytes)
                : remainingBytes,
            );
            totalBytes += bytes.byteLength;
            copied.push({ path: file, bytes });
          }
          return copied;
        }, id);
        const copiedManifest = copiedFiles.find((file) => file.path === "plugin.json");
        if (!copiedManifest)
          return yield* new PluginError({
            id,
            message: "The captured plugin tree is missing its manifest.",
          });
        const captured = yield* decodeManifest(new TextDecoder().decode(copiedManifest.bytes)).pipe(
          Effect.mapError((cause) => new PluginError({ id, message: cause.message })),
        );
        const manifestText = yield* encodeManifest(manifest).pipe(Effect.orDie);
        if ((yield* encodeManifest(captured).pipe(Effect.orDie)) !== manifestText)
          return yield* new PluginError({
            id,
            message: "The plugin manifest changed during reload. Save again or reload it.",
          });
        const treeFingerprint = fingerprintPluginFiles(
          copiedFiles.map((file) => ({
            relativePath: file.path.split(NodePath.sep).join("/"),
            bytes: file.bytes,
          })),
        );
        contentSha256 = treeFingerprint;
        if (
          (approvedSha256 && approvedSha256 !== treeFingerprint) ||
          (reviewed &&
            ((yield* encodeManifest(reviewed.manifest).pipe(Effect.orDie)) !== manifestText ||
              treeFingerprint !== reviewed.sha256))
        )
          return yield* new PluginError({
            id,
            message:
              "The installed plugin no longer matches its reviewed contents. Restore the approved package before enabling it.",
          });
        if (approvedSha256) verifiedSource = "registry";
        if (
          reviewed &&
          (yield* encodeManifest(reviewed.manifest).pipe(Effect.orDie)) === manifestText &&
          treeFingerprint === reviewed.sha256
        )
          verifiedSource = "registry";
        if (verifiedSource === "registry" && !approvedSha256)
          yield* catalog
            .remember(id, treeFingerprint)
            .pipe(Effect.mapError((cause) => new PluginError({ id, message: cause.message })));
        fingerprint = `${treeFingerprint}:${isEnabled}:${verifiedSource}`;
      }
      const existing = (yield* Ref.get(generations)).get(id);
      if (existing?.fingerprint === fingerprint) return existing;
      if (sourceDirectory) {
        directory = NodePath.join(cache, `${id}-${generationRevision}`);
        yield* attempt(async () => {
          await NodeFSP.mkdir(directory!, { recursive: true });
          for (const file of copiedFiles) {
            const target = relativeEntry(directory!, file.path);
            await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
            await NodeFSP.writeFile(target, file.bytes);
          }
          for (const entry of Object.values(manifest.entries ?? {}))
            await NodeFSP.access(relativeEntry(directory!, entry));
        }, id);
      }
      let entries = manifest.entries ?? {};
      if (directory && isEnabled && (entries.web || entries.server)) {
        const compiled = yield* Effect.tryPromise({
          try: (signal) =>
            compilePluginEntries({
              directory: directory!,
              entries,
              signal,
              hostRuntimeKeys: { server: serverRuntimeKey, web: PLUGIN_WEB_RUNTIME_KEY },
              hostModules: {
                server: pluginModuleExports(pluginEffectModules),
                web: pluginWebModuleExports,
              },
            }),
          catch: (cause) => new PluginError({ id, message: message(cause) }),
        });
        entries = compiled.entries;
        // Registry approval covers the source tree; device approval also covers emitted web code.
        const compiledWeb = compiled.compiledFiles.filter((file) => file.surface === "web");
        if (compiledWeb.length)
          contentSha256 = fingerprintPluginFiles([
            ...copiedFiles.map((file) => ({
              relativePath: file.path.split(NodePath.sep).join("/"),
              bytes: file.bytes,
            })),
            ...compiledWeb.map((file) => ({ relativePath: "\0compiled:web", bytes: file.bytes })),
          ]);
        removeRuntime = installPluginRuntime(serverRuntimeKey, pluginEffectModules);
      }
      const host: ServerPluginHost = {
        id,
        Effect,
        Schema,
        Stream,
        Scope,
        events: {
          on: (filter, handler) => {
            if (!registering) throw new Error("Event handlers register during activation.");
            if (!manifest.permissions?.includes("server:events"))
              throw new Error("Event subscriptions require server:events permission.");
            if (
              typeof handler !== "function" ||
              !filter ||
              typeof filter !== "object" ||
              (filter.eventType !== undefined && !eventTypes.has(filter.eventType)) ||
              (filter.threadId !== undefined && !isThreadId(filter.threadId))
            )
              throw new Error("Event subscriptions require a valid event filter and handler.");
            if (eventSubscriptions.length >= 128)
              throw new Error("A plugin can register at most 128 event subscriptions.");
            eventSubscriptions.push({ filter: { ...filter }, handler, cursor: {} });
          },
        },
        http: {
          Response: HttpServerResponse,
          register: (method, path, run) => {
            if (!registering) throw new Error("HTTP handlers must register during activation.");
            if (!manifest.permissions?.includes("server:http"))
              throw new Error("HTTP handlers require server:http permission.");
            if (
              !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(method) ||
              !/^\/[a-zA-Z0-9_./-]*$/.test(path) ||
              path.split("/").includes("..") ||
              typeof run !== "function"
            )
              throw new Error("Invalid plugin HTTP handler.");
            const key = method + " " + path;
            if (httpHandlers.has(key)) throw new Error("Duplicate plugin HTTP handler.");
            httpHandlers.set(key, run);
          },
        },
        services: {
          list: kernel.list,
          get: kernel.get,
          getBuiltin: kernel.getBuiltin,
          register: (key, factory) => {
            if (!registering) throw new Error("Plugin services must register during activation.");
            if (!manifest.permissions?.includes("server:services"))
              throw new Error("Registering services requires server:services permission.");
            if (!key.startsWith(`${id}.`) && !key.startsWith(`${id}/`))
              throw new Error("New plugin services must use their owner's namespace.");
            if (typeof factory !== "function")
              throw new Error("Plugin services require a scoped factory.");
            services.push({ kind: "register", key, factory });
          },
          replace: (key, factory) => {
            if (!registering) throw new Error("Plugin services must register during activation.");
            if (!manifest.permissions?.includes("server:services"))
              throw new Error("Replacing services requires server:services permission.");
            if (typeof factory !== "function")
              throw new Error("Service replacements require a scoped factory.");
            services.push({ kind: "replace", key, factory });
          },
          wrap: (key, member, run) => {
            if (!registering) throw new Error("Plugin services must register during activation.");
            if (!manifest.permissions?.includes("server:services"))
              throw new Error("Wrapping services requires server:services permission.");
            if (typeof run !== "function") throw new Error("Service wrappers must be functions.");
            services.push({ kind: "wrap", key, member, run });
          },
        },
        commands: {
          register: (name, command) => {
            if (!registering) throw new Error("Plugin commands must register during activation.");
            if (
              !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(name) ||
              commands.has(name) ||
              typeof command.run !== "function"
            ) {
              throw new Error(`Invalid or duplicate plugin command '${name}'.`);
            }
            commands.set(name, compileCommand(command));
          },
          wrap: (pluginId, method, run) => {
            if (!registering) throw new Error("Plugin wrappers must register during activation.");
            if (!manifest.permissions?.includes("server:commands"))
              throw new Error("Wrapping builtin commands requires server:commands permission.");
            if (!BUILTIN_PLUGIN_MANIFESTS.some((builtin) => builtin.id === pluginId))
              throw new Error("Unknown builtin plugin.");
            const key = `${pluginId}:${method}`;
            if (wrappers.has(key)) throw new Error(`Duplicate builtin wrapper '${key}'.`);
            wrappers.set(key, run);
          },
        },
        onDispose: (dispose) => {
          if (typeof dispose !== "function")
            throw new Error("A plugin disposer must be a function.");
          if (!disposalStarted) cleanup.push(dispose);
          else
            runLateCleanup(
              disposeCallback(dispose).pipe(
                Effect.timeoutOrElse({
                  duration: "10 seconds",
                  orElse: () => Effect.logWarning("Plugin cleanup exceeded 10 seconds", { id }),
                }),
              ),
            );
        },
        providers: {
          getBuiltin: (driverKind) =>
            BUILT_IN_PROVIDER_PLUGIN_DEFINITIONS.find(
              (provider) => provider.driver.driverKind === driverKind,
            )?.driver,
          register: (driver) => {
            if (!registering) throw new Error("Plugin providers must register during activation.");
            if (source !== "builtin" && !manifest.permissions?.includes("server:providers"))
              throw new Error("Registering a provider requires server:providers permission.");
            if (
              !driver ||
              typeof driver.create !== "function" ||
              typeof driver.driverKind !== "string" ||
              !Schema.isSchema(driver.configSchema)
            )
              throw new Error("Invalid provider driver.");
            if (providers.some((existing) => existing.driverKind === driver.driverKind))
              throw new Error("Duplicate provider driver.");
            providers.push(driver);
          },
        },
      };
      // Compiled builtins and external modules activate through the same host.
      if (isEnabled) {
        const hasServerModule = sourceDirectory && entries.server;
        const plugin = hasServerModule
          ? yield* attempt(async () => {
              const module: unknown = await import(
                NodeURL.pathToFileURL(relativeEntry(directory!, entries.server!)).href
              );
              return definition(
                typeof module === "object" && module !== null && "default" in module
                  ? module.default
                  : module,
              );
            }, id)
          : source === "builtin"
            ? getCompiledServerBuiltin(id)
            : undefined;
        if (source === "builtin" && !plugin)
          return yield* new PluginError({
            id,
            message: "Builtin plugin has no compiled definition.",
          });
        yield* execute(() => {
          if (!hasServerModule) {
            host.commands.register("manifest", { run: () => manifest });
            host.commands.register("services", {
              run: () => kernel.list("host").filter((service) => service.pluginId === id),
            });
          }
          return plugin?.activate?.(host);
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () =>
              Effect.fail(
                new PluginError({ id, message: "Plugin activation exceeded 10 seconds." }),
              ),
          }),
        );
        yield* execute(() =>
          validateProviderDriverContributions(providers.map((driver) => ({ driver }))),
        );
      }
      registering = false;
      const clientModuleUrl =
        directory && entries.web && isEnabled
          ? `/api/plugins/assets/${encodeURIComponent(id)}/${generationRevision}/${token}/${entries.web.split("/").map(encodeURIComponent).join("/")}`
          : undefined;
      const mobileModuleUrl =
        directory && manifest.entries?.mobile && isEnabled
          ? `/api/plugins/assets/${encodeURIComponent(id)}/${generationRevision}/${token}/${manifest.entries.mobile.split("/").map(encodeURIComponent).join("/")}`
          : undefined;
      const generation: Generation = {
        status: {
          manifest,
          source: verifiedSource,
          enabled: isEnabled,
          status: isEnabled ? "active" : "disabled",
          revision: generationRevision,
          ...(contentSha256 ? { contentSha256 } : {}),
          ...(verifiedSource === "local" && sourceDirectory
            ? { localDevelopmentDirectory: sourceDirectory }
            : {}),
          ...(clientModuleUrl ? { clientModuleUrl } : {}),
          ...(mobileModuleUrl ? { mobileModuleUrl } : {}),
        },
        scope,
        eventSubscriptions,
        eventsStarted: false,
        ...(entries.server ? { serverEntry: entries.server } : {}),
        commands,
        httpHandlers,
        ...(directory ? { directory } : {}),
        fingerprint,
        token,
        wrappers,
        inFlight: 0,
        retiring: false,
        providers,
        services,
        assetLifetime,
      };
      return generation;
    }).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(
            new PluginError({ id, message: "Plugin capture and loading exceeded 30 seconds." }),
          ),
      }),
      Effect.result,
    );
    if (loaded._tag === "Failure") {
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
      return yield* loaded.failure;
    }
    if (loaded.success.scope !== scope) yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
    return loaded.success;
  });

  const reloadUnlocked = Effect.fn("PluginService.reloadUnlocked")(function* (
    input: PluginReloadInput = {},
  ) {
    const reviewed = yield* catalog
      .list()
      .pipe(Effect.mapError((cause) => new PluginError({ message: cause.message })));
    const approvals = yield* catalog
      .approvals()
      .pipe(Effect.mapError((cause) => new PluginError({ message: cause.message })));
    const before = yield* Ref.get(generations);
    const previousStatuses = yield* Ref.get(statuses);
    const next = new Map(before);
    const nextStatuses = new Map(previousStatuses);
    const candidates: Array<{
      manifest: PluginManifest;
      source: "builtin" | "local";
      directory: string | undefined;
    }> = COMPILED_SERVER_BUILTINS.map(({ manifest }) => ({
      manifest,
      source: "builtin",
      directory: undefined,
    }));
    const seen = new Set(candidates.map(({ manifest }) => manifest.id as string));
    const folders = yield* attempt(() => NodeFSP.readdir(root, { withFileTypes: true }));
    for (const folder of folders) {
      if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
      const directory = NodePath.join(root, folder.name);
      const result = yield* Effect.gen(function* () {
        const text = yield* attempt(
          async () =>
            (
              await readPluginFile(
                NodePath.join(directory, "plugin.json"),
                MAX_PLUGIN_MANIFEST_BYTES,
              )
            ).toString("utf8"),
          folder.name,
        );
        const manifest = yield* decodeManifest(text).pipe(
          Effect.mapError((cause) => new PluginError({ id: folder.name, message: cause.message })),
        );
        if (manifest.id !== folder.name)
          return yield* new PluginError({
            id: folder.name,
            message: "The plugin directory must match its manifest id.",
          });
        if (seen.has(manifest.id))
          return yield* new PluginError({
            id: folder.name,
            message: `Plugin '${manifest.id}' conflicts with another installed plugin.`,
          });
        return manifest;
      }).pipe(Effect.result);
      if (result._tag === "Failure") {
        const previous = previousStatuses.get(folder.name);
        if (previous && (!input.id || input.id === folder.name)) {
          nextStatuses.set(folder.name, { ...previous, error: result.failure.message });
          seen.add(folder.name);
        } else if (!input.id || input.id === folder.name) {
          if (isPluginId(folder.name)) {
            seen.add(folder.name);
            nextStatuses.set(folder.name, {
              manifest: { id: folder.name, name: folder.name, version: "invalid", apiVersion: 1 },
              source: "local",
              enabled: false,
              status: "error",
              revision: 0,
              error: result.failure.message,
            });
          }
        }
        yield* Effect.logWarning("Plugin manifest could not be loaded", {
          directory,
          detail: result.failure.message,
        });
        continue;
      }
      seen.add(result.success.id);
      candidates.push({ manifest: result.success, source: "local", directory });
    }
    if (input.id && !seen.has(input.id))
      return yield* new PluginError({ id: input.id, message: "Plugin was not found." });
    for (const candidate of candidates) {
      if (input.id && candidate.manifest.id !== input.id) continue;
      const result = yield* build(
        candidate.manifest,
        candidate.source,
        candidate.directory,
        reviewed.entries.find((entry) => entry.manifest.id === candidate.manifest.id),
        approvals[candidate.manifest.id],
      ).pipe(Effect.result);
      if (result._tag === "Failure") {
        const previous = previousStatuses.get(candidate.manifest.id);
        nextStatuses.set(
          candidate.manifest.id,
          previous
            ? { ...previous, error: result.failure.message }
            : {
                manifest: candidate.manifest,
                source: candidate.source,
                enabled:
                  (yield* Ref.get(enabled))[candidate.manifest.id] ??
                  candidate.source === "builtin",
                status: "error",
                revision: 0,
                error: result.failure.message,
              },
        );
        continue;
      }
      next.set(candidate.manifest.id, result.success);
      if (before.get(candidate.manifest.id) !== result.success) {
        const generation = result.success;
        const registered = yield* kernel
          .stage(
            candidate.manifest.id,
            generation.services,
            Effect.sync(() => {
              if (generation.retiring)
                throw new Error("This service plugin generation has retired.");
              generation.inFlight += 1;
              return release(generation);
            }),
          )
          .pipe(Effect.result);
        if (registered._tag === "Failure") {
          yield* close(generation);
          const previous = previousStatuses.get(candidate.manifest.id);
          if (before.has(candidate.manifest.id))
            next.set(candidate.manifest.id, before.get(candidate.manifest.id)!);
          else next.delete(candidate.manifest.id);
          nextStatuses.set(
            candidate.manifest.id,
            previous
              ? { ...previous, error: registered.failure.message }
              : { ...generation.status, status: "error", error: registered.failure.message },
          );
          continue;
        }
        generation.unregisterServices = registered.success;
        if (candidate.source === "builtin")
          yield* setBuiltinEnabled(candidate.manifest.id, generation.status.enabled).pipe(
            Effect.mapError(
              (cause) => new PluginError({ id: candidate.manifest.id, message: cause.message }),
            ),
          );
      }
      if (
        before.get(candidate.manifest.id) !== result.success &&
        (candidate.source !== "builtin" ||
          BUILT_IN_PROVIDER_PLUGIN_DEFINITIONS.some(
            (provider) => provider.id === candidate.manifest.id,
          ))
      ) {
        const generation = result.success;
        generation.unregisterProviders = yield* providerCatalog.register(
          candidate.manifest.id,
          generation.providers.map((driver) => ({
            driver,
            retain: Effect.sync(() => {
              if (generation.retiring)
                throw new Error("This provider plugin generation has retired.");
              generation.inFlight += 1;
              return release(generation);
            }),
          })),
        );
      }
      nextStatuses.set(candidate.manifest.id, result.success.status);
    }
    if (!input.id) {
      for (const id of next.keys())
        if (!seen.has(id)) {
          next.delete(id);
          nextStatuses.delete(id);
        }
      for (const id of nextStatuses.keys()) if (!seen.has(id)) nextStatuses.delete(id);
    }
    // Capture the replacement boundary before old cleanup can wait on plugin resources.
    const hasEventReplacement = [...before].some(
      ([id, generation]) => next.get(id) !== generation && generation.eventSubscriptions.length > 0,
    );
    const handoffSink = eventSink;
    const eventBoundary =
      handoffSink && hasEventReplacement
        ? yield* Effect.suspend(() => handoffSink.latestSequence()).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Plugin event handoff source is unavailable", { cause }).pipe(
                Effect.as(undefined),
              ),
            ),
          )
        : undefined;
    for (const [id, generation] of before) {
      const replacement = next.get(id);
      if (replacement === generation) continue;
      generation.retiring = true;
      // Continue unchanged filters in registration order from their last admitted event.
      // A committed boundary alone would skip events queued behind a running handler.
      const previousSubscriptions = new Map<string, PluginEventSubscription[]>();
      const filterKey = ({ filter }: PluginEventSubscription) =>
        JSON.stringify([filter.eventType ?? null, filter.threadId ?? null]);
      for (const subscription of generation.eventSubscriptions) {
        const key = filterKey(subscription);
        const matches = previousSubscriptions.get(key) ?? [];
        matches.push(subscription);
        previousSubscriptions.set(key, matches);
      }
      for (const subscription of replacement?.eventSubscriptions ?? []) {
        const previous = previousSubscriptions.get(filterKey(subscription))?.shift();
        if (previous?.cursor.afterSequence !== undefined)
          subscription.cursor.afterSequence = previous.cursor.afterSequence;
      }
    }
    yield* Ref.set(generations, next);
    indexWrappers(next);
    yield* Ref.set(statuses, nextStatuses);
    for (const [id, generation] of before)
      if (next.get(id) !== generation) yield* retire(generation);
    for (const generation of next.values())
      yield* startGenerationEvents(generation, eventBoundary).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Plugin event startup failed", {
            id: generation.status.manifest.id,
            cause,
          }),
        ),
      );
    const previousEncoded = yield* encodeStatuses([...previousStatuses.values()]).pipe(
      Effect.orDie,
    );
    const nextEncoded = yield* encodeStatuses([...nextStatuses.values()]).pipe(Effect.orDie);
    if (previousEncoded !== nextEncoded) yield* publish;
    return yield* list();
  });
  const reload = <E = never>(
    input: PluginReloadInput = {},
    authorize: Effect.Effect<void, E> = Effect.void,
  ) => lock.withPermits(1)(authorize.pipe(Effect.andThen(reloadUnlocked(input))));
  const persistEnabled = Effect.fn("PluginService.persistEnabled")(function* (
    next: Readonly<Record<string, boolean>>,
    id: string,
  ) {
    const contents = yield* encodePreferences(next).pipe(
      Effect.mapError((cause) => new PluginError({ id, message: cause.message })),
    );
    yield* attempt(async () => {
      const temp = `${statePath}.${process.pid}.tmp`;
      try {
        await NodeFSP.writeFile(temp, contents);
        await NodeFSP.rename(temp, statePath);
      } finally {
        await NodeFSP.rm(temp, { force: true });
      }
    }, id);
    yield* Ref.set(enabled, next);
  });
  const setEnabled = <E = never>(
    input: PluginSetEnabledInput,
    authorize: Effect.Effect<void, E> = Effect.void,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        yield* authorize;
        if (!input.enabled && REQUIRED_HOST_PLUGINS.has(input.id))
          return yield* new PluginError({
            id: input.id,
            message:
              "This host plugin is required for plugin management. Replace its services instead of disabling it.",
          });
        if (!(yield* Ref.get(statuses)).has(input.id))
          return yield* new PluginError({ id: input.id, message: "Plugin was not found." });
        const previous = yield* Ref.get(enabled);
        const next = { ...previous, [input.id]: input.enabled };
        yield* persistEnabled(next, input.id);
        yield* setBuiltinEnabled(input.id, input.enabled).pipe(
          Effect.catch((cause) =>
            persistEnabled(previous, input.id).pipe(
              Effect.andThen(
                input.id === "t3.providers"
                  ? providerCatalog.setEnabled(previous[input.id] !== false)
                  : Effect.void,
              ),
              Effect.andThen(
                Effect.fail(new PluginError({ id: input.id, message: cause.message })),
              ),
            ),
          ),
        );
        if (!input.enabled) {
          const current = new Map(yield* Ref.get(generations));
          const generation = current.get(input.id);
          if (generation) {
            current.delete(input.id);
            yield* Ref.set(generations, current);
            indexWrappers(current);
            yield* retire(generation);
          } else yield* revokeAssets(input.id);
          yield* Ref.update(statuses, (current) => {
            const updated = new Map(current);
            const previous = updated.get(input.id)!;
            const { clientModuleUrl: _omit, mobileModuleUrl: _omitMobile, ...rest } = previous;
            updated.set(input.id, { ...rest, enabled: false, status: "disabled" });
            return updated;
          });
          yield* publish;
          return yield* list();
        }
        return yield* reloadUnlocked({ id: input.id });
      }),
    );

  yield* reload();
  let watcher = yield* attempt(async () => NodeFS.watch(root, { recursive: true }));
  yield* Effect.addFinalizer(() => Effect.sync(() => watcher.close()));
  let rearmWatcher = () => {};
  const watchedChanges = Stream.callback<void>((queue) =>
    Effect.gen(function* () {
      const changed = () => {
        Queue.offerUnsafe(queue, undefined);
      };
      const failed = () => {
        Queue.offerUnsafe(queue, undefined);
      };
      watcher.on("change", changed);
      watcher.on("error", failed);
      rearmWatcher = () => {
        // Node's recursive watcher can retain the old inode after an editor's atomic save.
        const next = NodeFS.watch(root, { recursive: true });
        next.on("change", changed);
        next.on("error", failed);
        watcher.off("change", changed);
        watcher.off("error", failed);
        watcher.close();
        watcher = next;
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          watcher.off("change", changed);
          watcher.off("error", failed);
        }),
      );
    }),
  );
  yield* watchedChanges.pipe(
    Stream.debounce("150 millis"),
    Stream.runForEach(() =>
      attempt(async () => rearmWatcher()).pipe(
        Effect.andThen(reload()),
        Effect.catch((cause) => Effect.logWarning("Plugin reload failed", cause)),
      ),
    ),
    Effect.forkScoped,
  );

  const interceptBuiltin = <A, E, R>(
    pluginId: string,
    method: string,
    input: unknown,
    next: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const key = `${pluginId}:${method}`;
      if (!wrapperIndex.has(key)) return next;
      return Effect.gen(function* () {
        const context = yield* Effect.context<R>();
        const original = next.pipe(Effect.provideContext(context));
        return yield* Effect.acquireUseRelease(
          // No reload lock: one synchronous step leases the committed index, and reloads swap
          // the index before retiring the generations it dropped.
          Effect.sync(() => {
            const selected = wrapperIndex.get(key) ?? [];
            for (const { generation } of selected) {
              generation.inFlight += 1;
            }
            return selected;
          }),
          (selected) =>
            runBuiltinPluginWrappers(
              selected.map(({ wrap }) => wrap),
              input,
              original,
              (cause) =>
                Effect.logWarning("Plugin command wrapper failed", { pluginId, method, cause }),
            ),
          (selected) =>
            Effect.forEach(selected, ({ generation }) => release(generation), { discard: true }),
        );
      });
    });

  return PluginService.of({
    startEvents: Effect.fn("PluginService.startEvents")((sink: EventSinkV2Shape) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          eventSink = sink;
          for (const generation of (yield* Ref.get(generations)).values())
            yield* startGenerationEvents(generation).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Plugin event startup failed", {
                  id: generation.status.manifest.id,
                  cause,
                }),
              ),
            );
        }),
      ),
    ),
    handleHttp: Effect.fn("PluginService.handleHttp")(function* (
      id: string,
      method: string,
      path: string,
      request: HttpServerRequest.HttpServerRequest,
    ) {
      // The transport closes the request scope after writing or cancelling the body.
      const { handler } = yield* Effect.acquireRelease(
        // Lease the committed generation in one synchronous step instead of waiting for a reload.
        Effect.suspend(() => {
          const generation = Ref.getUnsafe(generations).get(id);
          if (!generation?.status.enabled)
            return Effect.fail(new PluginError({ id, message: "Plugin is not active." }));
          const handler = generation.httpHandlers.get(method + " " + path);
          if (!handler)
            return Effect.fail(
              new PluginError({
                id,
                message: "Plugin HTTP handler was not found.",
              }),
            );
          generation.inFlight += 1;
          return Effect.succeed({ generation, handler });
        }),
        ({ generation }) => release(generation),
      );
      const response = yield* execute(() => handler(request));
      if (!HttpServerResponse.isHttpServerResponse(response))
        return yield* new PluginError({
          id,
          message: "Plugin HTTP handlers must return a host Response.",
        });
      return response;
    }),
    list,
    authoringGuide: Effect.fn("PluginService.authoringGuide")(
      (input: PluginAuthoringGuideInput = {}) =>
        Effect.sync(() => createPluginAuthoringGuide(input, root, kernel.list())),
    ),
    registryList: Effect.fn("PluginService.registryList")((input?: PluginRegistryListInput) =>
      catalog.list(input),
    ),
    registryInstall: Effect.fn("PluginService.registryInstall")(function* <E = never>(
      input: PluginRegistryInstallInput,
      authorize: Effect.Effect<void, E> = Effect.void,
    ) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          yield* authorize;
          if ((yield* Ref.get(statuses)).has(input.id))
            return yield* new PluginError({
              id: input.id,
              message: "This plugin is already installed.",
            });
          yield* persistEnabled({ ...(yield* Ref.get(enabled)), [input.id]: false }, input.id);
          const installed = yield* catalog.install(input);
          yield* reloadUnlocked({ id: input.id });
          return installed;
        }),
      );
    }),
    reload,
    setEnabled,
    subscribe: (input = {}) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(list(input)),
            Stream.fromSubscription(queue).pipe(
              Stream.map((snapshot) => {
                const query = input.query?.trim().toLowerCase();
                return query
                  ? {
                      ...snapshot,
                      plugins: snapshot.plugins.filter((plugin) =>
                        `${plugin.manifest.id} ${plugin.manifest.name} ${plugin.manifest.description ?? ""}`
                          .toLowerCase()
                          .includes(query),
                      ),
                    }
                  : snapshot;
              }),
            ),
          );
        }),
      ),
    invoke: Effect.fn("PluginService.invoke")(function* <E = never>(
      input: PluginInvokeInput,
      authorize: Effect.Effect<void, E> = Effect.void,
    ) {
      yield* authorize;
      return yield* Effect.acquireUseRelease(
        // Lease the committed generation in one synchronous step instead of waiting for a reload.
        Effect.suspend(() => {
          const generation = Ref.getUnsafe(generations).get(input.id);
          if (!generation?.status.enabled)
            return Effect.fail(new PluginError({ id: input.id, message: "Plugin is not active." }));
          generation.inFlight += 1;
          return Effect.succeed(generation);
        }),
        (generation) =>
          Effect.gen(function* () {
            const command = generation.commands.get(input.method);
            if (!command)
              return yield* new PluginError({
                id: input.id,
                message: `Plugin command '${input.method}' was not found.`,
              });
            const decoded = command.decodeInput
              ? yield* command
                  .decodeInput(input.input)
                  .pipe(
                    Effect.mapError(
                      (cause) => new PluginError({ id: input.id, message: message(cause) }),
                    ),
                  )
              : input.input;
            const output = yield* execute(() => command.run(decoded));
            const encoded = command.encodeOutput
              ? yield* command
                  .encodeOutput(output)
                  .pipe(
                    Effect.mapError(
                      (cause) => new PluginError({ id: input.id, message: message(cause) }),
                    ),
                  )
              : output;
            return { output: encoded };
          }),
        release,
      );
    }),
    interceptBuiltin,
    resolveAsset: Effect.fn("PluginService.resolveAsset")(function* (
      id: string,
      assetRevision: number,
      token: string,
      relativePath: string,
    ) {
      yield* pruneAssets;
      const active = (yield* Ref.get(generations)).get(id);
      if (!active?.status.enabled) return undefined;
      const generation =
        active.status.revision === assetRevision
          ? active
          : assetHistory
              .get(id)
              ?.find((entry) => entry.generation.status.revision === assetRevision)?.generation;
      if (
        !generation?.status.enabled ||
        generation.status.revision !== assetRevision ||
        generation.token !== token ||
        !generation.directory
      )
        return undefined;
      return yield* attempt(async () => {
        const path = relativeEntry(generation.directory!, relativePath);
        const serverEntry = generation.status.manifest.entries?.server;
        if (
          NodePath.basename(path) === "plugin.json" ||
          (generation.serverEntry &&
            path === relativeEntry(generation.directory!, generation.serverEntry)) ||
          (serverEntry && path === relativeEntry(generation.directory!, serverEntry))
        )
          return undefined;
        return (await NodeFSP.stat(path)).isFile() ? path : undefined;
      }, id).pipe(Effect.orElseSucceed(() => undefined));
    }),
  });
});

export const layer = builtinServiceLayer("t3.server")(PluginService, make);

/** Event delivery starts after application services exist, avoiding a loader/bootstrap cycle. */
export const eventsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const plugins = yield* PluginService;
    const sink = yield* EventSinkV2;
    yield* plugins.startEvents(sink);
  }),
);
