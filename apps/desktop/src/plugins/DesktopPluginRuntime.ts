// @effect-diagnostics nodeBuiltinImport:off -- The trusted local loader owns immutable module snapshots independently of contributed filesystem services.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  PluginManifest,
  type PluginSnapshot,
  type PluginStatus,
  type PluginSetEnabledInput,
  type PluginReloadInput,
  type PluginInvokeInput,
} from "@t3tools/contracts";
import { PluginKernel, type PluginServiceContribution } from "@t3tools/shared/pluginKernel";
import { compilePluginEntries } from "@t3tools/shared/pluginCompiler";
import {
  installPluginRuntime,
  pluginEffectModules,
  pluginModuleExports,
  PLUGIN_WEB_RUNTIME_KEY,
} from "@t3tools/shared/pluginRuntime";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import type {
  DesktopCommand as SdkDesktopCommand,
  DesktopPluginHost,
} from "@t3tools/plugin-sdk/desktop";

type DesktopCommand<Input = unknown, Output = unknown> = SdkDesktopCommand<Input, Output>;
export type { DesktopPluginHost } from "@t3tools/plugin-sdk/desktop";

const compileCommandSchema = (schema: Schema.Codec<unknown, unknown>) => {
  // Extension schemas arrive during activation; compile once per generation.
  return Schema.decodeUnknownEffect(schema);
};
const compileCommandOutput = (schema: Schema.Codec<unknown, unknown>) =>
  Schema.encodeUnknownEffect(schema);

interface RegisteredDesktopCommand {
  readonly run: DesktopCommand["run"];
  readonly decodeInput: ReturnType<typeof compileCommandSchema> | undefined;
  readonly encodeOutput: ReturnType<typeof compileCommandOutput> | undefined;
}

const compileCommand = <Input, Output>(
  command: DesktopCommand<Input, Output>,
): RegisteredDesktopCommand => ({
  // Invocation decodes with this generation's input schema before entering the handler.
  run: (input: unknown) => command.run(input as Input),
  decodeInput: command.input ? compileCommandSchema(command.input) : undefined,
  encodeOutput: command.output ? compileCommandOutput(command.output) : undefined,
});

interface Generation {
  readonly manifest: PluginManifest;
  readonly fingerprint: string;
  readonly revision: number;
  readonly directory: string;
  readonly scope: Scope.Closeable;
  readonly commands: ReadonlyMap<string, RegisteredDesktopCommand>;
  unregister: Effect.Effect<void>;
  leases: number;
  retired: boolean;
  closed: boolean;
}

export class DesktopPluginError extends Schema.TaggedError<DesktopPluginError>()(
  "DesktopPluginError",
  { message: Schema.String },
) {}
const isDesktopPluginError = Schema.is(DesktopPluginError);
const decodeDesktopManifest = Schema.decodeEffect(Schema.fromJsonString(PluginManifest));
const MAX_PLUGIN_MANIFEST_BYTES = 256 * 1024;
const DesktopEnabledJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean));
const decodeDesktopEnabled = Schema.decodeEffect(DesktopEnabledJson);
const encodeDesktopEnabled = Schema.encodeEffect(DesktopEnabledJson);
const pluginError = (cause: unknown) =>
  isDesktopPluginError(cause) ? cause : new DesktopPluginError({ message: String(cause) });
// Keep the window and management IPC available; extensions can still replace their services.
const DESKTOP_RECOVERY_PLUGINS = new Set([
  "t3.desktop.desktop-window",
  "t3.desktop.electron-window",
  "t3.desktop.desktop-ipc",
]);

export class DesktopPluginRuntime extends Context.Service<
  DesktopPluginRuntime,
  {
    readonly start: Effect.Effect<void>;
    readonly list: Effect.Effect<PluginSnapshot>;
    readonly reload: (
      input?: PluginReloadInput,
    ) => Effect.Effect<PluginSnapshot, DesktopPluginError>;
    readonly setEnabled: (
      input: PluginSetEnabledInput,
    ) => Effect.Effect<PluginSnapshot, DesktopPluginError>;
    readonly invoke: (
      input: PluginInvokeInput,
    ) => Effect.Effect<{ readonly output: unknown }, DesktopPluginError>;
  }
>()("@t3tools/desktop/plugins/DesktopPluginRuntime") {}

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: pluginError });
// Opaque extension failures are caught before entering the host's error channel.
const extensionEffect = (value: unknown) =>
  value as Effect.Effect<unknown, DesktopPluginError, Scope.Scope>;
const isExtensionEffect = (value: unknown): boolean => Effect.isEffect(value);
const toEffect = (value: unknown): Effect.Effect<unknown, DesktopPluginError, Scope.Scope> =>
  isExtensionEffect(value)
    ? extensionEffect(value).pipe(Effect.catchCause((cause) => Effect.fail(pluginError(cause))))
    : value instanceof Promise
      ? Effect.tryPromise({ try: () => value, catch: pluginError })
      : Effect.succeed(value);

async function readCapturedPluginFile(filename: string, maxBytes: number): Promise<Buffer> {
  const handle = await NodeFSP.open(
    filename,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new DesktopPluginError({ message: "Desktop plugins contain only regular files." });
    if (info.size > maxBytes)
      throw new DesktopPluginError({
        message: "Desktop plugin file exceeds its package size limit.",
      });
    const buffer = Buffer.alloc(info.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const chunk = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw new DesktopPluginError({
        message: "Desktop plugin changed during capture; retry reload.",
      });
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Captures trusted local sources independently of their compiled generation entries. */
async function capture(source: string, target: string) {
  const files: Array<{ relative: string; contents: Uint8Array }> = [];
  let bytes = 0;
  let entries = 0;
  async function walk(directory: string) {
    for (const entry of (await NodeFSP.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (++entries > 2000)
        throw new DesktopPluginError({ message: "Desktop plugin tree is oversized." });
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.isSymbolicLink())
        throw new DesktopPluginError({
          message: "Desktop plugin tree contains a symlink.",
        });
      const file = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const remainingBytes = 16 * 1024 * 1024 - bytes;
        const contents = await readCapturedPluginFile(
          file,
          NodePath.relative(source, file) === "plugin.json"
            ? Math.min(MAX_PLUGIN_MANIFEST_BYTES, remainingBytes)
            : remainingBytes,
        );
        bytes += contents.length;
        files.push({ relative: NodePath.relative(source, file), contents });
      } else
        throw new DesktopPluginError({ message: "Desktop plugins contain only regular files." });
    }
  }
  await walk(source);
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files) {
    hash
      .update(String(file.relative.length))
      .update("\0")
      .update(file.relative)
      .update(String(file.contents.length))
      .update("\0")
      .update(file.contents);
    const destination = NodePath.join(target, file.relative);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.writeFile(destination, file.contents);
  }
  return hash.digest("hex");
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment;
  const kernel = yield* PluginKernel;
  const scope = yield* Effect.scope;
  const root = NodePath.join(environment.stateDir, "plugins");
  const cache = NodePath.join(environment.stateDir, "desktop-plugin-generations");
  const enabledFile = NodePath.join(environment.stateDir, "desktop-plugins-enabled.json");
  const lock = yield* Semaphore.make(1);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const enabled = new Map<string, boolean>();
  const generations = new Map<string, Generation>();
  const allGenerations = new Set<Generation>();
  const statuses = new Map<string, PluginStatus>();
  let revision = yield* Clock.currentTimeMillis;
  let started = false;
  let builtinEnableStateRestored = false;
  let stopping = false;
  const close = Effect.fn("DesktopPluginRuntime.close")(function* (generation: Generation) {
    if (generation.closed) return;
    generation.closed = true;
    yield* Scope.close(generation.scope, Exit.void).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Desktop plugin cleanup failed", { id: generation.manifest.id, cause }),
      ),
    );
    yield* attempt(() => NodeFSP.rm(generation.directory, { recursive: true, force: true })).pipe(
      Effect.ignore,
    );
    allGenerations.delete(generation);
  });
  const release = Effect.fn("DesktopPluginRuntime.release")(function* (generation: Generation) {
    generation.leases -= 1;
    if (generation.retired && generation.leases === 0) yield* close(generation);
  });
  const retire = Effect.fn("DesktopPluginRuntime.retire")(function* (generation: Generation) {
    generation.retired = true;
    yield* generation.unregister;
    if (generation.leases === 0) yield* close(generation);
  });
  const list = Effect.sync(() => {
    const plugins = new Map(statuses);
    for (const service of kernel.list()) {
      if (plugins.has(service.pluginId)) continue;
      plugins.set(service.pluginId, {
        manifest: { id: service.pluginId, apiVersion: 1, name: service.pluginId, version: "1.0.0" },
        source: "builtin",
        enabled: service.enabled,
        status: service.enabled ? "active" : "disabled",
        revision: 1,
      });
    }
    return { revision, plugins: [...plugins.values()] } satisfies PluginSnapshot;
  });
  const reloadUnlocked = Effect.fn("DesktopPluginRuntime.reloadUnlocked")(function* (
    _input: PluginReloadInput = {},
  ) {
    if (stopping)
      return yield* new DesktopPluginError({ message: "Desktop plugins are stopping." });
    yield* attempt(() => NodeFSP.mkdir(root, { recursive: true }));
    const seen = new Set<string>();
    const directories = yield* attempt(() => NodeFSP.readdir(root, { withFileTypes: true }));
    for (const entry of directories
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const directory = NodePath.join(root, entry.name);
      seen.add(entry.name);
      let id = entry.name;
      let discoveredManifest: PluginManifest | undefined;
      let candidateDirectory: string | undefined;
      let candidateScope: Scope.Closeable | undefined;
      let abortActivation: (() => void) | undefined;
      yield* Effect.gen(function* () {
        const raw = yield* attempt(async () =>
          (
            await readCapturedPluginFile(
              NodePath.join(directory, "plugin.json"),
              MAX_PLUGIN_MANIFEST_BYTES,
            )
          ).toString("utf8"),
        );
        let manifest = yield* decodeDesktopManifest(raw);
        discoveredManifest = manifest;
        if (!manifest.entries?.desktop) {
          const previous = generations.get(id);
          if (previous) {
            generations.delete(id);
            yield* retire(previous);
          }
          statuses.delete(id);
          return;
        }
        id = manifest.id;
        if (id !== entry.name || id.startsWith("t3."))
          throw new DesktopPluginError({
            message: "Desktop extension id must match its directory and cannot use t3.*.",
          });
        seen.add(id);
        const active = enabled.get(id) === true;
        if (!active) {
          const previous = generations.get(id);
          if (previous) {
            generations.delete(id);
            yield* retire(previous);
          }
          statuses.set(id, {
            manifest,
            source: "local",
            enabled: false,
            status: "disabled",
            revision: statuses.get(id)?.revision ?? 0,
          });
          return;
        }
        candidateDirectory = NodePath.join(cache, `${id}-${++revision}`);
        const fingerprint = yield* attempt(() => capture(directory, candidateDirectory!));
        const capturedRaw = yield* attempt(async () =>
          (
            await readCapturedPluginFile(
              NodePath.join(candidateDirectory!, "plugin.json"),
              MAX_PLUGIN_MANIFEST_BYTES,
            )
          ).toString("utf8"),
        );
        manifest = yield* decodeDesktopManifest(capturedRaw);
        discoveredManifest = manifest;
        if (manifest.id !== id || !manifest.entries?.desktop)
          throw new DesktopPluginError({
            message: "Desktop plugin changed during capture; retry reload.",
          });
        const previous = generations.get(id);
        if (previous?.fingerprint === fingerprint) {
          yield* attempt(() => NodeFSP.rm(candidateDirectory!, { recursive: true, force: true }));
          statuses.set(id, {
            manifest,
            source: "local",
            enabled: true,
            status: "active",
            revision: previous.revision,
          });
          return;
        }
        candidateScope = yield* Scope.make();
        const runtimeKey = `t3.plugin-runtime.desktop.v1:${NodeCrypto.randomUUID()}`;
        const releaseRuntime = yield* Effect.sync(() =>
          installPluginRuntime(runtimeKey, pluginEffectModules),
        );
        yield* Scope.addFinalizer(candidateScope, Effect.sync(releaseRuntime));
        const contributions: PluginServiceContribution[] = [];
        const commands = new Map<string, RegisteredDesktopCommand>();
        const disposers: Array<() => void | Promise<void>> = [];
        yield* Scope.addFinalizer(
          candidateScope,
          Effect.suspend(() =>
            Effect.forEach(
              disposers.splice(0).toReversed(),
              (dispose) =>
                attempt(async () => {
                  await dispose();
                }).pipe(Effect.ignore),
              { discard: true },
            ).pipe(
              Effect.interruptible,
              Effect.timeoutOrElse({
                duration: "10 seconds",
                orElse: () =>
                  Effect.logWarning("Desktop plugin cleanup exceeded 10 seconds", { id }),
              }),
            ),
          ),
        );
        let registering = true;
        const generation: Generation = {
          manifest,
          fingerprint,
          revision,
          directory: candidateDirectory,
          scope: candidateScope,
          commands,
          unregister: Effect.void,
          leases: 0,
          retired: false,
          closed: false,
        };
        abortActivation = () => {
          registering = false;
          generation.retired = true;
          generation.closed = true;
        };
        const requireRegistration = () => {
          if (!registering || generation.retired || generation.closed)
            throw new DesktopPluginError({
              message: "Desktop contributions register only during activation.",
            });
          if (!manifest.permissions?.includes("desktop:services"))
            throw new DesktopPluginError({
              message: "Desktop services require desktop:services permission.",
            });
        };
        const host: DesktopPluginHost = {
          id,
          Effect,
          Schema,
          services: {
            list: kernel.list,
            get: kernel.get,
            getBuiltin: kernel.getBuiltin,
            register: (key, factory) => {
              requireRegistration();
              if (
                (!key.startsWith(`${id}.`) && !key.startsWith(`${id}/`)) ||
                typeof factory !== "function"
              )
                throw new DesktopPluginError({
                  message: "Desktop service factories must use their plugin namespace.",
                });
              contributions.push({ kind: "register", key, factory });
            },
            replace: (key, factory) => {
              requireRegistration();
              contributions.push({ kind: "replace", key, factory });
            },
            wrap: (key, member, run) => {
              requireRegistration();
              contributions.push({ kind: "wrap", key, member, run });
            },
          },
          commands: {
            register: (method, command) => {
              requireRegistration();
              if (
                !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(method) ||
                commands.has(method) ||
                typeof command.run !== "function"
              )
                throw new DesktopPluginError({ message: "Invalid desktop plugin command." });
              commands.set(method, compileCommand(command));
            },
          },
          onDispose: (dispose) => {
            if (typeof dispose !== "function")
              throw new DesktopPluginError({ message: "Desktop cleanup requires a function." });
            if (!generation.retired && !generation.closed) disposers.push(dispose);
            else
              void runPromise(
                attempt(async () => {
                  await dispose();
                }).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Desktop retired plugin cleanup failed", { id, cause }),
                  ),
                ),
              );
          },
        };
        const compiled = yield* Effect.tryPromise({
          try: (signal) =>
            compilePluginEntries({
              directory: candidateDirectory!,
              entries: { server: manifest.entries!.desktop! },
              signal,
              hostRuntimeKeys: { server: runtimeKey, web: PLUGIN_WEB_RUNTIME_KEY },
              hostModules: { server: pluginModuleExports(pluginEffectModules), web: {} },
            }),
          catch: pluginError,
        });
        const modulePath = NodePath.resolve(candidateDirectory, compiled.entries.server!);
        if (!modulePath.startsWith(candidateDirectory + NodePath.sep))
          throw new DesktopPluginError({
            message: "Desktop plugin entry must stay inside its generation.",
          });
        const module: unknown = yield* attempt(
          () => import(/* @vite-ignore */ NodeURL.pathToFileURL(modulePath).href),
        ).pipe(Effect.timeout("10 seconds"), Effect.mapError(pluginError));
        const record = module as {
          activate?: (host: DesktopPluginHost) => unknown;
          default?:
            | { activate?: (host: DesktopPluginHost) => unknown }
            | ((host: DesktopPluginHost) => unknown);
        };
        const activate =
          record.activate ??
          (typeof record.default === "function" ? record.default : record.default?.activate);
        if (!activate)
          throw new DesktopPluginError({ message: "Desktop plugin must export activate(host)." });
        yield* Effect.suspend(() => toEffect(activate(host))).pipe(
          Effect.provideService(Scope.Scope, candidateScope),
          Effect.timeout("10 seconds"),
          Effect.mapError((cause) => pluginError(cause)),
        );
        registering = false;
        generation.unregister = yield* kernel
          .stage(
            id,
            contributions,
            Effect.sync(() => {
              if (generation.retired || generation.closed)
                throw new DesktopPluginError({ message: "Desktop generation retired." });
              generation.leases += 1;
              return release(generation);
            }),
          )
          .pipe(Effect.timeout("10 seconds"), Effect.mapError(pluginError));
        allGenerations.add(generation);
        generations.set(id, generation);
        statuses.set(id, {
          manifest,
          source: "local",
          enabled: true,
          status: "active",
          revision,
        });
        candidateScope = undefined;
        candidateDirectory = undefined;
        abortActivation = undefined;
        if (previous) yield* retire(previous);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            abortActivation?.();
            if (candidateScope) yield* Scope.close(candidateScope, Exit.void).pipe(Effect.ignore);
            if (candidateDirectory)
              yield* attempt(() =>
                NodeFSP.rm(candidateDirectory!, { recursive: true, force: true }),
              ).pipe(Effect.ignore);
            const previous = statuses.get(id);
            if (previous || discoveredManifest)
              statuses.set(id, {
                ...previous,
                manifest: previous?.manifest ?? discoveredManifest!,
                source: "local",
                enabled: enabled.get(id) === true,
                status: generations.has(id) ? "active" : "error",
                revision: previous?.revision ?? 0,
                error: String(cause),
              });
            else yield* Effect.logWarning("Desktop plugin discovery failed", { id, cause });
          }),
        ),
      );
    }
    for (const [id, generation] of generations)
      if (!seen.has(id)) {
        generations.delete(id);
        statuses.delete(id);
        yield* retire(generation);
      }
    return yield* list;
  });
  const reload = (input?: PluginReloadInput) => lock.withPermits(1)(reloadUnlocked(input));
  const start = Effect.gen(function* () {
    if (started) return;
    started = true;
    const saved = yield* attempt(() => NodeFSP.readFile(enabledFile, "utf8")).pipe(
      Effect.orElseSucceed(() => "{}"),
    );
    const persisted = yield* decodeDesktopEnabled(saved).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Desktop plugin enable state is invalid", { cause }).pipe(
          Effect.as({} as Record<string, boolean>),
        ),
      ),
    );
    for (const [id, value] of Object.entries(persisted))
      enabled.set(id, DESKTOP_RECOVERY_PLUGINS.has(id) || value);
    yield* reload().pipe(
      Effect.catch((cause) => Effect.logWarning("Desktop plugin discovery failed", { cause })),
    );
    const watcher = yield* attempt(async () => NodeFS.watch(root, { recursive: true }));
    let queued = false;
    let dirty = false;
    const onChange = () => {
      if (stopping) return;
      dirty = true;
      if (queued) return;
      queued = true;
      void (async () => {
        try {
          while (dirty) {
            if (stopping) break;
            dirty = false;
            await runPromise(reload());
          }
        } catch (cause) {
          await runPromise(Effect.logError("Desktop plugin reload failed", { cause }));
        } finally {
          queued = false;
          if (dirty && !stopping) onChange();
        }
      })();
    };
    watcher.on("change", onChange);
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => watcher.close()),
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Desktop plugins could not start", { cause })),
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      stopping = true;
      yield* lock.withPermits(1)(
        Effect.suspend(() =>
          Effect.forEach([...allGenerations], (generation) => retire(generation), {
            discard: true,
          }),
        ),
      );
    }),
  );
  return DesktopPluginRuntime.of({
    start,
    // Only renderer management requests restore builtin disables. Bootstrap and watcher
    // reloads use the passive snapshot above, so saved disables cannot prevent a window.
    list: lock.withPermits(1)(
      Effect.gen(function* () {
        if (!builtinEnableStateRestored && !stopping) {
          builtinEnableStateRestored = true;
          const builtinIds = new Set(kernel.list().map((service) => service.pluginId));
          for (const [id, value] of enabled)
            if (builtinIds.has(id))
              yield* kernel
                .setEnabled(id, value)
                .pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Desktop builtin enable state failed", { id, cause }),
                  ),
                );
        }
        return yield* list;
      }),
    ),
    reload,
    setEnabled: Effect.fn("DesktopPluginRuntime.setEnabled")((input: PluginSetEnabledInput) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (!input.enabled && DESKTOP_RECOVERY_PLUGINS.has(input.id))
            return yield* new DesktopPluginError({
              message: "This plugin must remain enabled for desktop plugin recovery.",
            });
          const local = statuses.has(input.id);
          if (!local)
            yield* kernel.setEnabled(input.id, input.enabled).pipe(Effect.mapError(pluginError));
          enabled.set(input.id, input.enabled);
          const encoded = yield* encodeDesktopEnabled(Object.fromEntries(enabled)).pipe(
            Effect.mapError(pluginError),
          );
          yield* attempt(async () => {
            const temporary = `${enabledFile}.${process.pid}.tmp`;
            await NodeFSP.writeFile(temporary, encoded);
            await NodeFSP.rename(temporary, enabledFile);
          });
          return yield* reloadUnlocked({ id: input.id });
        }),
      ),
    ),
    invoke: Effect.fn("DesktopPluginRuntime.invoke")((input: PluginInvokeInput) =>
      Effect.acquireUseRelease(
        lock.withPermits(1)(
          Effect.sync(() => {
            const generation = generations.get(input.id);
            const command = generation?.commands.get(input.method);
            if (!generation || !command || generation.retired)
              throw new DesktopPluginError({ message: "Desktop plugin command is unavailable." });
            generation.leases += 1;
            return { generation, command };
          }),
        ),
        ({ generation, command }) =>
          Effect.gen(function* () {
            const decoded = command.decodeInput
              ? yield* command.decodeInput(input.input)
              : input.input;
            const output = yield* Effect.suspend(() => toEffect(command.run(decoded))).pipe(
              Effect.provideService(Scope.Scope, generation.scope),
            );
            return {
              output: command.encodeOutput ? yield* command.encodeOutput(output) : output,
            };
          }),
        ({ generation }) => release(generation),
      ).pipe(Effect.catchCause((cause) => Effect.fail(pluginError(cause)))),
    ),
  });
});

export const layer = Layer.effect(DesktopPluginRuntime, make);
