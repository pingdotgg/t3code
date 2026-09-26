import { resolveCapabilities } from "./resolution.js";
import {
  createApiBroker,
  type ApiAuthority,
  type HostApiProvider,
  type ApiAudit,
  type HostApiRootAuthority,
} from "./broker.js";
import type {
  ApiInvocation,
  ApiStreamInvocation,
  ApiStreamFrame,
  ApiStreamEvent,
  ApiDiscovery,
  ApiSelection,
} from "@t3tools/extension-sdk/capabilities";
import { copyEnvelope } from "./ipc.js";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { Ajv, type ValidateFunction } from "ajv";
import {
  assertId,
  copyJson,
  validateContext,
  type Json,
  type ViewContext,
} from "@t3tools/extension-sdk/contracts";
import {
  validateEnvironmentPackage,
  type EnvironmentPackage,
  type ToolDescriptor,
} from "@t3tools/extension-sdk/environment";
import {
  atomicJson,
  checkSyntax,
  ensureModuleScope,
  validateModuleScope,
  readPackage,
  readPackageMetadata,
  readDeclaredAsset,
  storePackage,
  prunePackages,
  type PackageMetadata,
  type PackageSnapshot,
} from "./storage.js";

export interface InstallationGrants {
  readonly capabilities: readonly string[];
  readonly projectIds: readonly string[];
}
export interface Installation {
  readonly id: string;
  readonly contentHash: string;
  readonly package: EnvironmentPackage;
  readonly enabled: boolean;
  readonly grants: InstallationGrants;
}
export interface HostService {
  readonly capability: string;
  invoke(input: Json, context: ViewContext, signal: AbortSignal): Json | Promise<Json>;
}
export interface RuntimeOptions {
  readonly rootDir: string;
  readonly environmentId: string;
  readonly services: readonly HostService[];
  readonly apiProviders?: readonly HostApiProvider[];
  readonly auditApi?: (event: ApiAudit) => void;
  readonly onCatalogueChanged?: () => void;
  readonly validateApiScope?: (context: ViewContext) => boolean | Promise<boolean>;
  authorize(
    installation: Installation,
    capability: string,
    context: ViewContext,
  ): boolean | Promise<boolean>;
  readonly timeoutMs?: number;
  readonly workerUrl?: URL;
  /**
   * Starts workers as `process.execPath ...workerCommand` instead of forking
   * `workerUrl`. A Node single-executable has no Node to fork a script with, so
   * it passes the hidden subcommand that runs `runWorkerProcess` inside itself.
   */
  readonly workerCommand?: readonly string[];
}
export interface ExtensionRuntime {
  install(sourceDir: string, grants?: Partial<InstallationGrants>): Promise<Installation>;
  list(): readonly Installation[];
  catalogue(): {
    apiSelections: readonly ApiSelection[];
    apiResolution: ReturnType<typeof resolveCapabilities>["apis"];
    pluginResolution: ReturnType<typeof resolveCapabilities>["plugins"];
  };
  updateGrants(id: string, grants: InstallationGrants): Promise<Installation>;
  enable(id: string): Promise<Installation>;
  disable(id: string): Promise<Installation>;
  remove(id: string): Promise<void>;
  update(id: string, sourceDir: string): Promise<Installation>;
  rollback(id: string): Promise<Installation>;
  selectApi(selection: ApiSelection): Promise<void>;
  invokeApi(
    id: string,
    expectedContentHash: string,
    request: ApiInvocation,
    signal: AbortSignal,
    root?: HostApiRootAuthority,
  ): Promise<Json>;
  subscribeApi(
    id: string,
    expectedContentHash: string,
    request: ApiStreamInvocation,
    signal: AbortSignal,
    root?: HostApiRootAuthority,
  ): AsyncIterable<ApiStreamFrame>;
  discoverApis(
    id: string,
    expectedContentHash: string,
    context: ViewContext,
    signal: AbortSignal,
  ): Promise<readonly ApiDiscovery[]>;
  readClient(id: string): Promise<{ code: string; contentHash: string }>;
  readAsset(
    id: string,
    expectedContentHash: string,
    path: string,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mediaType: string; sha256: string }>;
  invoke(
    toolId: string,
    input: Json,
    context: ViewContext,
    signal: AbortSignal,
    expectedContentHash?: string,
  ): Promise<Json>;
  dispose(): Promise<void>;
}
interface NestedStream {
  readonly parentCallId: string;
  readonly controller: AbortController;
  readonly iterator: AsyncIterator<ApiStreamFrame>;
  pulling: boolean;
  readonly unlinkParent: () => void;
}
interface StreamPending {
  readonly controller: AbortController;
  readonly context: ViewContext;
  readonly authority: ApiAuthority;
  readonly clientConnectionId?: string;
  readonly ready: Promise<void>;
  readyResolve(): void;
  readyReject(error: Error): void;
  waiting:
    | { resolve(value: IteratorResult<ApiStreamFrame>): void; reject(error: Error): void }
    | undefined;
  pulling: boolean;
}
interface Pending {
  readonly authority?: ApiAuthority;
  readonly context: ViewContext;
  readonly clientConnectionId?: string;
  readonly tool: ToolDescriptor;
  readonly controller: AbortController;
  resolve(value: Json): void;
  reject(error: Error): void;
  cleanup(): void;
}
interface Worker {
  readonly child: NodeChildProcess.ChildProcess;
  readonly installation: Installation;
  readonly calls: Map<string, Pending>;
  readonly streams: Map<string, StreamPending>;
  readonly nestedStreams: Map<string, NestedStream>;
  readonly streamSettlers: Map<string, () => void>;
  readonly cancelled: Map<string, ReturnType<typeof setTimeout>>;
  services: number;
  readonly ready: Promise<void>;
  readyResolve(): void;
  readyReject(error: Error): void;
  readonly exited: Promise<void>;
  readonly startupTimer: ReturnType<typeof setTimeout>;
}
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 1000) : "Extension failed";
const WORKER_HEAP_LIMIT = "--max-old-space-size=96";
const clone = <T>(value: T): T => copyEnvelope(value, 4 * 1024 * 1024) as T;

/** Trusted bundled code, one environment and one process owner per runtime root. Not a sandbox. */
export async function createExtensionRuntime(options: RuntimeOptions): Promise<ExtensionRuntime> {
  const root = NodePath.resolve(options.rootDir);
  const environmentId = options.environmentId;
  if (!environmentId || environmentId.length > 160) throw new Error("Invalid environment identity");
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
    throw new Error("Invalid deadline");
  let activeAssetReads = 0;
  const activeAssetReadsByInstallation = new Map<string, number>();
  const services = new Map<string, HostService>();
  for (const service of options.services) {
    assertId(service.capability);
    if (services.has(service.capability)) throw new Error("Duplicate host service");
    services.set(service.capability, { ...service });
  }
  const authorize = options.authorize;
  const workerUrl = options.workerUrl
    ? new URL(options.workerUrl.href)
    : new URL("./worker.js", import.meta.url);
  const workerCommand = options.workerCommand ? [...options.workerCommand] : undefined;
  function spawnWorker(record: Installation): NodeChildProcess.ChildProcess {
    const spawnOptions = {
      cwd: NodePath.join(root, "packages", record.contentHash),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", ELECTRON_RUN_AS_NODE: "1" },
    } satisfies NodeChildProcess.SpawnOptions;
    // An executable passes every argument to its own program, so the heap cap
    // reaches its embedded Node through NODE_OPTIONS instead of execArgv.
    return workerCommand
      ? NodeChildProcess.spawn(process.execPath, workerCommand, {
          ...spawnOptions,
          env: { ...spawnOptions.env, NODE_OPTIONS: WORKER_HEAP_LIMIT },
        })
      : NodeChildProcess.fork(workerUrl, [], { ...spawnOptions, execArgv: [WORKER_HEAP_LIMIT] });
  }
  await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 });
  if ((await NodeFSP.realpath(root)) !== root)
    throw new Error("Runtime root cannot contain symlinks");
  await ensureModuleScope(root);
  const installations = new Map<string, Installation>();
  const validators = new Map<string, Map<string, ValidateFunction>>();
  const workers = new Map<string, Worker>();
  const health = new Map<string, "ready" | "starting" | "failed" | "unavailable">();
  const recovering = new Map<string, Installation>();
  const draining = new Set<Promise<void>>();
  let disposed = false;
  let selections: readonly ApiSelection[] = [];
  const previous = new Map<string, Installation>();
  let mutations = Promise.resolve();
  const ajv = new Ajv({ strict: true, allErrors: false, addUsedSchema: false });
  function compile(pkg: EnvironmentPackage): Map<string, ValidateFunction> {
    return new Map(pkg.tools.map((tool) => [tool.id, ajv.compile(tool.inputSchema)]));
  }
  function grants(value: Partial<InstallationGrants> = {}): InstallationGrants {
    const result = clone({
      capabilities: value.capabilities ?? [],
      projectIds: value.projectIds ?? [],
    });
    if (
      !Array.isArray(result.capabilities) ||
      result.capabilities.length > 16 ||
      !Array.isArray(result.projectIds) ||
      result.projectIds.length > 64 ||
      new Set(result.capabilities).size !== result.capabilities.length ||
      new Set(result.projectIds).size !== result.projectIds.length
    )
      throw new Error("Invalid installation grants");
    for (const capability of result.capabilities) assertId(capability);
    for (const id of result.projectIds)
      if (typeof id !== "string" || !id || id.length > 160)
        throw new Error("Invalid project grant");
    return result;
  }
  const recordsPath = NodePath.join(root, "installations.json");
  try {
    const stat = await NodeFSP.lstat(recordsPath);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      throw new Error("Invalid installation records");
    const stored = JSON.parse(await NodeFSP.readFile(recordsPath, "utf8")) as {
      version: unknown;
      environmentId: unknown;
      installations: unknown;
      selections?: readonly ApiSelection[];
      previous?: readonly Installation[];
    };
    if (
      stored.version !== 1 ||
      stored.environmentId !== environmentId ||
      !Array.isArray(stored.installations) ||
      stored.installations.length > 32
    )
      throw new Error("Invalid installation records");
    selections = stored.selections ?? [];
    for (const record of stored.previous ?? []) {
      const pkg = validateEnvironmentPackage(record.package);
      if (record.id !== pkg.manifest.id || !/^[a-f0-9]{64}$/.test(record.contentHash))
        throw new Error("Invalid rollback record");
      previous.set(record.id, { ...record, package: pkg, grants: grants(record.grants) });
    }
    for (const value of stored.installations) {
      const record = clone(value) as Installation;
      const pkg = validateEnvironmentPackage(record.package);
      if (
        record.id !== pkg.manifest.id ||
        installations.has(record.id) ||
        !/^[a-f0-9]{64}$/.test(record.contentHash) ||
        typeof record.enabled !== "boolean"
      )
        throw new Error("Invalid installation identity");
      const installed = { ...record, package: pkg, grants: grants(record.grants) };
      installations.set(record.id, installed);
      validators.set(record.id, compile(pkg));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  function live() {
    if (disposed) throw new Error("Runtime disposed");
  }
  function required(id: string) {
    live();
    const record = installations.get(id);
    if (!record) throw new Error("Extension is not installed");
    return record;
  }
  function current(record: Installation) {
    live();
    if (installations.get(record.id) !== record || !record.enabled)
      throw new Error("Installation changed or disabled");
    const state = broker.resolution().plugins.find((item) => item.id === record.id);
    if (state?.status !== "available") throw new Error(state?.reason?.code ?? "Plugin unavailable");
  }
  function mutate<T>(action: () => Promise<T>): Promise<T> {
    const next = mutations.then(() => {
      live();
      return action();
    });
    mutations = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  async function persist(next: Map<string, Installation>, selected = selections) {
    await atomicJson(
      root,
      clone({
        version: 1,
        environmentId,
        installations: [...next.values()],
        selections: selected,
        previous: [...previous.values()],
      }),
    );
  }
  async function verify(record: Installation): Promise<PackageMetadata> {
    await validateModuleScope(root);
    const snapshot = await readPackageMetadata(NodePath.join(root, "packages", record.contentHash));
    if (
      snapshot.contentHash !== record.contentHash ||
      JSON.stringify(snapshot.package) !== JSON.stringify(record.package)
    )
      throw new Error("Installed package digest mismatch");
    return snapshot;
  }
  async function verifyComplete(record: Installation): Promise<PackageSnapshot> {
    await validateModuleScope(root);
    const snapshot = await readPackage(NodePath.join(root, "packages", record.contentHash));
    if (
      snapshot.contentHash !== record.contentHash ||
      JSON.stringify(snapshot.package) !== JSON.stringify(record.package)
    )
      throw new Error("Installed package digest mismatch");
    return snapshot;
  }
  async function allowed(record: Installation, capability: string, context: ViewContext) {
    current(record);
    if (
      context.resource.environmentId !== environmentId ||
      !context.resource.projectId ||
      !record.grants.projectIds.includes(context.resource.projectId)
    )
      throw new Error("Resource is outside installation grants");
    if (
      !record.grants.capabilities.includes(capability) ||
      !(await authorize(clone(record), capability, copyJson(context)))
    )
      throw new Error("Capability denied");
    current(record);
  }
  async function permitted(record: Installation, tool: ToolDescriptor, context: ViewContext) {
    current(record);
    if (
      context.resource.environmentId !== environmentId ||
      !context.resource.projectId ||
      !record.grants.projectIds.includes(context.resource.projectId)
    )
      throw new Error("Resource is outside installation grants");
    for (const capability of tool.capabilities) await allowed(record, capability, context);
    current(record);
  }
  function publishCatalogueChange() {
    try {
      options.onCatalogueChanged?.();
    } catch {
      /* A notification sink cannot undo an already committed registry change. */
    }
  }
  function affectedPlugins(
    changed: readonly string[],
    before: readonly Installation[] = [],
    oldResolution = broker.resolution(),
  ): string[] {
    const affected = new Set(changed);
    const now = broker.resolution();
    const changedApis = new Set(
      [...oldResolution.apis, ...now.apis]
        .filter(
          (api) =>
            oldResolution.apis.find((item) => item.id === api.id)?.providerId !==
            now.apis.find((item) => item.id === api.id)?.providerId,
        )
        .map((api) => api.id),
    );
    for (const state of now.plugins) {
      const old = oldResolution.plugins.find((item) => item.id === state.id);
      if (old?.status !== state.status || old?.reason?.code !== state.reason?.code)
        affected.add(state.id);
    }
    const records = [...before, ...installations.values()];
    let changedGraph = true;
    while (changedGraph) {
      changedGraph = false;
      for (const record of records) {
        if (affected.has(record.id)) continue;
        const depends =
          (record.package.provides ?? []).some((api) => changedApis.has(api.id)) ||
          (record.package.dependencies ?? []).some((dependency) =>
            affected.has(dependency.pluginId),
          ) ||
          (record.package.requires ?? []).some(
            (api) =>
              changedApis.has(api.id) ||
              records.some(
                (provider) =>
                  affected.has(provider.id) &&
                  provider.package.provides?.some((item) => item.id === api.id),
              ) ||
              [...oldResolution.apis, ...now.apis].some(
                (selected) =>
                  selected.id === api.id &&
                  !!selected.providerId &&
                  affected.has(selected.providerId),
              ),
          );
        if (depends) {
          affected.add(record.id);
          changedGraph = true;
        }
      }
    }
    return [...affected];
  }
  async function invalidatePlugins(ids: readonly string[]) {
    broker.invalidate(ids);
    const owned = ids.flatMap((id) => {
      const worker = workers.get(id);
      return worker ? [worker] : [];
    });
    for (const worker of owned)
      stop(worker, new Error("Installation or dependency changed"), false);
    for (const id of ids) {
      health.delete(id);
      recovering.delete(id);
    }
    await Promise.all(owned.map((worker) => worker.exited));
    publishCatalogueChange();
  }
  function stop(worker: Worker, reason: Error, failed = true) {
    if (failed && workers.get(worker.installation.id) === worker) {
      recovering.delete(worker.installation.id);
      health.set(worker.installation.id, "failed");
      broker.invalidate(affectedPlugins([worker.installation.id]));
      publishCatalogueChange();
    }
    if (workers.get(worker.installation.id) === worker) workers.delete(worker.installation.id);
    clearTimeout(worker.startupTimer);
    worker.readyReject(reason);
    for (const pending of worker.calls.values()) {
      pending.controller.abort(reason);
      pending.cleanup();
      pending.reject(reason);
    }
    worker.calls.clear();
    for (const stream of worker.streams.values()) {
      stream.controller.abort(reason);
      stream.readyReject(reason);
      stream.waiting?.reject(reason);
    }
    worker.streams.clear();
    for (const nested of worker.nestedStreams.values()) {
      nested.controller.abort(reason);
      nested.unlinkParent();
      void nested.iterator.return?.().catch(() => {});
    }
    worker.nestedStreams.clear();
    for (const timer of worker.cancelled.values()) clearTimeout(timer);
    worker.cancelled.clear();
    for (const settle of worker.streamSettlers.values()) settle();
    worker.streamSettlers.clear();
    if (worker.child.exitCode === null && worker.child.signalCode === null)
      worker.child.kill("SIGKILL");
  }
  function send(worker: Worker, message: unknown) {
    if (!worker.child.connected) throw new Error("Worker disconnected");
    worker.child.send(copyEnvelope(message), (error) => {
      if (error) stop(worker, error);
    });
  }
  async function receive(worker: Worker, raw: unknown): Promise<void> {
    if (workers.get(worker.installation.id) !== worker) return;
    const message = copyEnvelope(raw);
    if (message.type === "ready") {
      clearTimeout(worker.startupTimer);
      health.set(worker.installation.id, "ready");
      if (recovering.get(worker.installation.id) === worker.installation) {
        recovering.delete(worker.installation.id);
        broker.invalidate(affectedPlugins([worker.installation.id]));
        publishCatalogueChange();
      }
      worker.readyResolve();
      return;
    }
    if (message.type === "fatal") {
      stop(worker, new Error(String(message.error ?? "Worker failed")));
      return;
    }
    const id = String(message.callId);
    if (
      message.type === "api-stream-open" ||
      message.type === "api-stream-pull" ||
      message.type === "api-stream-cancel"
    ) {
      const streamId = String(message.streamId);
      if (message.type === "api-stream-open") {
        const parent = worker.calls.get(id) ?? worker.streams.get(id);
        if (!parent) {
          send(worker, { type: "api-stream-error", streamId, error: "Unknown stream parent" });
          return;
        }
        if (worker.nestedStreams.size >= 8 || worker.nestedStreams.has(streamId)) {
          send(worker, {
            type: "api-stream-error",
            streamId,
            error: "Worker stream limit reached",
          });
          return;
        }
        const controller = new AbortController();
        const parentSignal = parent.controller.signal;
        if (parentSignal.aborted) {
          send(worker, { type: "api-stream-error", streamId, error: "Stream parent expired" });
          return;
        }
        const onParentAbort = () => controller.abort(parentSignal.reason);
        parentSignal.addEventListener("abort", onParentAbort, { once: true });
        const unlinkParent = () => parentSignal.removeEventListener("abort", onParentAbort);
        const context = parent.context;
        const authority = parent.authority;
        const request = copyJson(message.request ?? {}) as unknown as Omit<
          ApiStreamInvocation,
          "context"
        >;
        let source: AsyncIterable<ApiStreamFrame>;
        try {
          source = broker.subscribe(
            worker.installation,
            { ...request, context },
            controller.signal,
            authority,
          );
          const iterator = source[Symbol.asyncIterator]();
          worker.nestedStreams.set(streamId, {
            parentCallId: id,
            controller,
            iterator,
            pulling: false,
            unlinkParent,
          });
          send(worker, { type: "api-stream-ready", streamId });
        } catch (error) {
          unlinkParent();
          send(worker, { type: "api-stream-error", streamId, error: errorMessage(error) });
        }
        return;
      }
      const nested = worker.nestedStreams.get(streamId);
      if (!nested || nested.parentCallId !== id) {
        if (message.type === "api-stream-cancel")
          send(worker, { type: "api-stream-settled", streamId });
        else send(worker, { type: "api-stream-error", streamId, error: "Unknown stream parent" });
        return;
      }
      if (message.type === "api-stream-cancel") {
        nested.controller.abort(new Error("Stream cancelled"));
        nested.unlinkParent();
        try {
          await nested.iterator.return?.();
        } catch {}
        worker.nestedStreams.delete(streamId);
        send(worker, { type: "api-stream-settled", streamId });
        return;
      }
      if (nested.pulling) {
        send(worker, { type: "api-stream-error", streamId, error: "Concurrent stream pull" });
        return;
      }
      nested.pulling = true;
      try {
        const next = await nested.iterator.next();
        if (nested.controller.signal.aborted || worker.nestedStreams.get(streamId) !== nested)
          return;
        if (next.done) {
          worker.nestedStreams.delete(streamId);
          nested.unlinkParent();
          await nested.iterator.return?.();
          send(worker, { type: "api-stream-end", streamId });
        } else send(worker, { type: "api-stream-frame", streamId, frame: copyJson(next.value) });
      } catch (error) {
        worker.nestedStreams.delete(streamId);
        nested.unlinkParent();
        send(worker, { type: "api-stream-error", streamId, error: errorMessage(error) });
      } finally {
        nested.pulling = false;
      }
      return;
    }
    const streamPending = worker.streams.get(id);
    if (message.type === "stream-ready" && streamPending) {
      streamPending.readyResolve();
      return;
    }
    if (message.type === "stream-frame" && streamPending?.waiting) {
      streamPending.pulling = false;
      const wait = streamPending.waiting;
      streamPending.waiting = undefined;
      wait.resolve({ done: false, value: copyJson(message.event) as unknown as ApiStreamFrame });
      return;
    }
    if (message.type === "stream-end" && streamPending?.waiting) {
      streamPending.pulling = false;
      const wait = streamPending.waiting;
      streamPending.waiting = undefined;
      worker.streams.delete(id);
      wait.resolve({ done: true, value: undefined });
      return;
    }
    if (message.type === "stream-error" && streamPending?.waiting) {
      streamPending.pulling = false;
      const wait = streamPending.waiting;
      streamPending.waiting = undefined;
      worker.streams.delete(id);
      wait.reject(new Error(String(message.error ?? "Stream failed")));
      return;
    }
    if (message.type === "stream-settled") {
      worker.streamSettlers.get(id)?.();
      worker.streamSettlers.delete(id);
      const timer = worker.cancelled.get(id);
      if (timer) clearTimeout(timer);
      worker.cancelled.delete(id);
      worker.streams.delete(id);
      return;
    }
    if (message.type === "settled") {
      const timer = worker.cancelled.get(id);
      if (timer) clearTimeout(timer);
      worker.cancelled.delete(id);
      return;
    }
    const pending = worker.calls.get(id);
    const streamParent = worker.streams.get(id);
    if (!pending && !streamParent) return;
    if (message.type === "api-service") {
      const parentAuthority = pending?.authority ?? streamParent?.authority;
      const parentContext = pending?.context ?? streamParent?.context;
      if (!parentAuthority || !parentContext || worker.services >= 8) {
        send(worker, {
          type: "service-result",
          requestId: message.requestId,
          error: "API authority unavailable",
        });
        return;
      }
      worker.services++;
      try {
        const request = copyJson(message.request) as unknown as Omit<ApiInvocation, "context">;
        const parentHint = pending?.clientConnectionId ?? streamParent?.clientConnectionId;
        const value = await broker.invoke(
          worker.installation,
          {
            ...request,
            context: parentContext,
            // A nested call inherits the parent's client-connection hint unless
            // the plugin explicitly names one — the hint is session-validated
            // downstream, so inheritance cannot widen reach.
            ...(request.clientConnectionId === undefined && parentHint !== undefined
              ? { clientConnectionId: parentHint }
              : {}),
          },
          pending?.controller.signal ?? streamParent!.controller.signal,
          parentAuthority,
        );
        if (
          ((pending && worker.calls.get(id) === pending) ||
            (streamParent && worker.streams.get(id) === streamParent)) &&
          !(pending?.controller.signal ?? streamParent!.controller.signal).aborted
        )
          send(worker, { type: "service-result", requestId: message.requestId, value });
      } catch (error) {
        if (
          ((pending && worker.calls.get(id) === pending) ||
            (streamParent && worker.streams.get(id) === streamParent)) &&
          !(pending?.controller.signal ?? streamParent!.controller.signal).aborted
        )
          send(worker, {
            type: "service-result",
            requestId: message.requestId,
            error: errorMessage(error),
          });
      } finally {
        worker.services--;
      }
      return;
    }
    if (message.type === "service") {
      if (!pending) return;
      if (worker.services >= 8) {
        stop(worker, new Error("Worker service limit reached"));
        return;
      }
      worker.services++;
      try {
        const capability = String(message.capability);
        if (!pending.tool.capabilities.includes(capability))
          throw new Error("Tool capability is not declared");
        if (!services.has(capability)) throw new Error("Host service unavailable");
        for (const caller of pending.authority?.callers ?? [worker.installation])
          await allowed(caller, capability, pending.context);
        if (pending.controller.signal.aborted) throw new Error("Invocation cancelled");
        const value = copyJson(
          await services
            .get(capability)!
            .invoke(
              copyJson(message.input ?? null),
              copyJson(pending.context),
              pending.controller.signal,
            ),
        );
        if (!services.has(capability)) throw new Error("Host service unavailable");
        for (const caller of pending.authority?.callers ?? [worker.installation])
          await allowed(caller, capability, pending.context);
        if (worker.calls.get(id) !== pending || pending.controller.signal.aborted) return;
        send(worker, { type: "service-result", requestId: message.requestId, value });
      } catch (error) {
        if (worker.calls.get(id) === pending && !pending.controller.signal.aborted)
          send(worker, {
            type: "service-result",
            requestId: message.requestId,
            error: errorMessage(error),
          });
      } finally {
        worker.services--;
      }
      return;
    }
    if (!pending) return;
    if (message.type !== "result") {
      stop(worker, new Error("Invalid worker response"));
      return;
    }
    try {
      await permitted(worker.installation, pending.tool, pending.context);
      if (worker.calls.get(id) !== pending || pending.controller.signal.aborted) return;
      if (typeof message.error === "string") throw new Error(message.error);
      const value = copyJson(message.value ?? null);
      worker.calls.delete(id);
      pending.cleanup();
      pending.controller.abort();
      pending.resolve(value);
    } catch (error) {
      if (worker.calls.get(id) !== pending) return;
      worker.calls.delete(id);
      pending.cleanup();
      pending.controller.abort();
      pending.reject(new Error(errorMessage(error)));
    }
  }
  function start(record: Installation): Worker {
    const existing = workers.get(record.id);
    if (existing) return existing;
    if (!record.package.serverEntry) throw new Error("Package has no server entry");
    const child = spawnWorker(record);
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    draining.add(exited);
    void exited.then(() => draining.delete(exited));
    const worker: Worker = {
      child,
      installation: record,
      calls: new Map(),
      streams: new Map(),
      nestedStreams: new Map(),
      streamSettlers: new Map(),
      cancelled: new Map(),
      services: 0,
      ready,
      readyResolve,
      readyReject,
      exited,
      startupTimer: setTimeout(
        () => stop(worker, new Error("Worker startup deadline exceeded")),
        timeout,
      ),
    };
    health.set(record.id, "starting");
    workers.set(record.id, worker);
    child.on("error", (error) => stop(worker, error));
    child.on("exit", () => stop(worker, new Error("Extension worker exited")));
    child.on("message", (raw) => {
      void receive(worker, raw).catch((error) => stop(worker, new Error(errorMessage(error))));
    });
    send(worker, {
      type: "initialize",
      package: record.package,
      entry: NodePath.join(root, "packages", record.contentHash, record.package.serverEntry),
    });
    return worker;
  }
  async function replace(
    record: Installation,
    nextRecord: Installation | null,
    compiled?: Map<string, ValidateFunction>,
  ): Promise<void> {
    const before = [...installations.values()];
    const oldResolution = broker.resolution();
    const next = new Map(installations);
    if (nextRecord) next.set(record.id, nextRecord);
    else next.delete(record.id);
    await persist(next);
    if (nextRecord) installations.set(record.id, nextRecord);
    else installations.delete(record.id);
    if (compiled) validators.set(record.id, compiled);
    await invalidatePlugins(affectedPlugins([record.id], before, oldResolution));
  }
  async function invokeWorker(
    toolId: string,
    input: Json,
    unsafeContext: ViewContext,
    signal: AbortSignal,
    expectedContentHash?: string,
    api?: { record: Installation; request: ApiInvocation; authority: ApiAuthority },
  ) {
    live();
    let worker: Worker | undefined;
    let callId: string | undefined;
    let recovery: Installation | undefined;
    const controller = new AbortController();
    const cancel = (reason: Error, hard = false) => {
      controller.abort(reason);
      if (!worker) return;
      if (hard) {
        stop(worker, reason);
        return;
      }
      if (!callId) return;
      const owned = worker;
      const pending = owned.calls.get(callId);
      if (!pending) return;
      owned.calls.delete(callId);
      pending.controller.abort(reason);
      pending.reject(reason);
      owned.cancelled.set(
        callId,
        setTimeout(
          () => stop(owned, new Error("Cancelled tool did not settle before deadline")),
          timeout,
        ),
      );
      try {
        send(owned, { type: "cancel", callId });
      } catch (error) {
        stop(owned, new Error(errorMessage(error)));
      }
    };
    const abort = () => cancel(new Error("Invocation cancelled"));
    const timer = setTimeout(
      () => cancel(new Error("Invocation deadline exceeded"), true),
      timeout,
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const active = () => {
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    let rejectCancelled!: (reason: Error) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancelled = reject;
    });
    const onCancel = () => rejectCancelled(controller.signal.reason as Error);
    controller.signal.addEventListener("abort", onCancel, { once: true });
    if (controller.signal.aborted) onCancel();
    const run = async (): Promise<Json> => {
      active();
      const context = validateContext(unsafeContext);
      const record =
        api?.record ??
        [...installations.values()].find((value) =>
          value.package.tools.some((tool) => tool.id === toolId),
        );
      if (!record) throw new Error("Tool is not installed");
      if (expectedContentHash !== undefined && record.contentHash !== expectedContentHash)
        throw new Error("Installed content changed");
      const descriptor = api
        ? record.package.provides
            ?.find((item) => item.id === api.request.id)
            ?.methods?.find((item) => item.name === api.request.method)
        : undefined;
      const tool: ToolDescriptor = api
        ? {
            id: api.request.id,
            title: api.request.method,
            description: "",
            readOnly: true,
            inputSchema: descriptor!.inputSchema,
            capabilities: descriptor!.requiredGrants,
          }
        : record.package.tools.find((value) => value.id === toolId)!;
      if (!api && record.package.format === 1 && health.get(record.id) === "failed") {
        recovery = record;
        recovering.set(record.id, record);
        health.delete(record.id);
      }
      const value = copyJson(input);
      if (!api && !validators.get(record.id)!.get(toolId)!(value))
        throw new Error("Tool input does not match schema");
      await permitted(record, tool, context);
      active();
      await verify(record);
      active();
      current(record);
      worker = start(record);
      await worker.ready;
      active();
      current(record);
      if (worker.calls.size >= 8) throw new Error("Pending tool limit reached");
      const owned = worker;
      return new Promise<Json>((resolve, reject) => {
        callId = NodeCrypto.randomUUID();
        owned.calls.set(callId, {
          authority: api?.authority ?? { callers: [record], calls: [], allowWrite: false },
          context,
          ...(api?.request.clientConnectionId !== undefined
            ? { clientConnectionId: api.request.clientConnectionId }
            : {}),
          tool,
          controller: new AbortController(),
          resolve,
          reject,
          cleanup() {},
        });
        try {
          send(owned, {
            type: "invoke",
            callId,
            toolId,
            ...(api ? { apiId: api.request.id, method: api.request.method } : {}),
            input: value,
            context,
          });
        } catch (error) {
          stop(owned, new Error(errorMessage(error)));
        }
      });
    };
    try {
      return await Promise.race([run(), cancelled]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onCancel);
      if (
        !disposed &&
        recovery &&
        recovering.get(recovery.id) === recovery &&
        installations.get(recovery.id) === recovery &&
        !workers.has(recovery.id)
      ) {
        recovering.delete(recovery.id);
        health.set(recovery.id, "failed");
      }
    }
  }

  async function* subscribeWorker(
    record: Installation,
    request: ApiStreamInvocation,
    signal: AbortSignal,
    authority: ApiAuthority,
  ): AsyncIterable<ApiStreamEvent> {
    if (!record || !record.enabled || (record.package.format !== 3 && record.package.format !== 4))
      throw new Error("API streams require an enabled format-3 installation");
    const worker = start(record);
    await worker.ready;
    if (signal.aborted) throw new Error("Stream cancelled");
    if (worker.streams.size + worker.cancelled.size >= 8)
      throw new Error("Plugin stream limit reached");
    const callId = NodeCrypto.randomUUID();
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const controller = new AbortController();
    const pending: StreamPending = {
      controller,
      context: request.context,
      authority,
      ...(request.clientConnectionId !== undefined
        ? { clientConnectionId: request.clientConnectionId }
        : {}),
      ready,
      readyResolve,
      readyReject,
      waiting: undefined,
      pulling: false,
    };
    worker.streams.set(callId, pending);
    const settled = new Promise<void>((resolve) => {
      worker.streamSettlers.set(callId, resolve);
    });
    const abort = (reason = new Error("Stream cancelled")) => {
      controller.abort(reason);
      readyReject(reason);
      pending.waiting?.reject(reason);
      try {
        send(worker, { type: "stream-cancel", callId });
      } catch {}
      if (!worker.cancelled.has(callId)) {
        worker.cancelled.set(
          callId,
          setTimeout(() => {
            worker.cancelled.delete(callId);
            if (workers.get(record.id) === worker)
              stop(worker, new Error("Cancelled stream did not settle before deadline"));
          }, 250),
        );
      }
    };
    const handshakeTimer = setTimeout(
      () => abort(new Error("Stream handshake deadline exceeded")),
      timeout,
    );
    const onAbort = () =>
      abort(signal.reason instanceof Error ? signal.reason : new Error("Stream cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      send(worker, {
        type: "stream-open",
        callId,
        apiId: request.id,
        name: request.name,
        input: copyJson(request.input),
        context: copyJson(request.context),
        ...(request.cursor ? { cursor: request.cursor } : {}),
      });
      await ready;
      clearTimeout(handshakeTimer);
      if (controller.signal.aborted) throw controller.signal.reason;
      while (!controller.signal.aborted) {
        const frame = await new Promise<IteratorResult<ApiStreamFrame>>((resolve, reject) => {
          if (pending.pulling) {
            reject(new Error("Concurrent stream pull"));
            return;
          }
          pending.pulling = true;
          pending.waiting = { resolve, reject };
          send(worker, { type: "stream-pull", callId });
        });
        if (frame.done) return;
        yield frame.value as unknown as ApiStreamEvent;
      }
      throw controller.signal.reason ?? new Error("Stream cancelled");
    } finally {
      clearTimeout(handshakeTimer);
      signal.removeEventListener("abort", onAbort);
      if (!controller.signal.aborted) abort(new Error("Stream closed"));
      worker.streams.delete(callId);
      pending.pulling = false;
      pending.waiting = undefined;
      await settled;
    }
  }

  const broker = createApiBroker({
    installations: () => [...installations.values()],
    providers: options.apiProviders ?? [],
    selections: () => selections,
    authorize,
    environmentId,
    timeoutMs: timeout,
    ...(options.auditApi ? { audit: options.auditApi } : {}),
    ...(options.validateApiScope ? { validateScope: options.validateApiScope } : {}),
    health: (id) => health.get(id) ?? "starting",
    subscribeWorker,
    invokeWorker: (record, request, signal, authority) =>
      invokeWorker(request.id, request.input, request.context, signal, record.contentHash, {
        record,
        request,
        authority,
      }),
  });
  for (const record of installations.values()) broker.validatePackage(record);
  async function stage(record: Installation) {
    if (!record.package.serverEntry) return;
    // A separate process verifies the executable contract without receiving grants or service authority.
    const child = spawnWorker(record);
    await new Promise<void>((resolve, reject) => {
      let result: Error | undefined;
      let ready = false;
      const timer = setTimeout(() => {
        result = new Error("Candidate handshake deadline exceeded");
        child.kill("SIGKILL");
      }, timeout);
      child.on("error", (error) => {
        result = error;
        child.kill("SIGKILL");
      });
      child.on("message", (raw) => {
        try {
          const message = copyEnvelope(raw);
          if (message.type === "ready") ready = true;
          else result = new Error(String(message.error ?? "Invalid candidate handshake"));
        } catch (error) {
          result = new Error(errorMessage(error));
        }
        child.kill("SIGKILL");
      });
      child.once("close", () => {
        clearTimeout(timer);
        if (ready && !result) resolve();
        else reject(result ?? new Error("Candidate exited before handshake"));
      });
      child.send({
        type: "initialize",
        package: record.package,
        entry: NodePath.join(root, "packages", record.contentHash, record.package.serverEntry!),
      });
    });
  }
  const retained = () =>
    new Set([...installations.values(), ...previous.values()].map((item) => item.contentHash));
  return {
    install(sourceDir, requested = {}) {
      return mutate(async () => {
        const snapshot = await readPackage(sourceDir);
        const id = snapshot.package.manifest.id;
        if (installations.has(id)) throw new Error("Extension already installed; use update");
        if (installations.size >= 32) throw new Error("Installation limit reached");
        const compiled = compile(snapshot.package);
        const record: Installation = {
          id,
          package: snapshot.package,
          contentHash: snapshot.contentHash,
          enabled: true,
          grants: grants(requested),
        };
        broker.validatePackage(record);
        await checkSyntax(snapshot);
        await prunePackages(root, retained());
        await storePackage(root, snapshot);
        await stage(record);
        const before = [...installations.values()];
        const oldResolution = broker.resolution();
        await persist(new Map(installations).set(id, record));
        installations.set(id, record);
        await invalidatePlugins(affectedPlugins([id], before, oldResolution));
        validators.set(id, compiled);
        return clone(record);
      });
    },
    catalogue() {
      live();
      const resolved = broker.resolution();
      return clone({
        apiSelections: selections,
        apiResolution: resolved.apis,
        pluginResolution: resolved.plugins,
      });
    },
    list() {
      live();
      return [...installations.values()].map(clone);
    },
    enable(id) {
      return mutate(async () => {
        const record = required(id);
        await verifyComplete(record);
        const next = { ...record, enabled: true };
        await stage(next);
        await replace(record, next);
        return clone(next);
      });
    },
    updateGrants(id, requested) {
      return mutate(async () => {
        const record = required(id);
        const next = { ...record, grants: grants(requested) };
        await replace(record, next);
        return clone(next);
      });
    },
    disable(id) {
      return mutate(async () => {
        const record = required(id);
        const next = { ...record, enabled: false };
        await replace(record, next);
        return clone(next);
      });
    },
    remove(id) {
      return mutate(async () => {
        const record = required(id);
        await prunePackages(root, retained());
        const old = previous.get(id);
        previous.delete(id);
        try {
          await replace(record, null);
        } catch (error) {
          if (old) previous.set(id, old);
          throw error;
        }
        validators.delete(id);
      });
    },
    update(id, sourceDir) {
      return mutate(async () => {
        const record = required(id);
        const snapshot = await readPackage(sourceDir);
        if (snapshot.package.manifest.id !== id)
          throw new Error("Update cannot replace installation identity");
        const compiled = compile(snapshot.package);
        await checkSyntax(snapshot);
        await prunePackages(root, retained());
        await storePackage(root, snapshot);
        const next = { ...record, package: snapshot.package, contentHash: snapshot.contentHash };
        broker.validatePackage(next);
        await stage(next);
        const old = previous.get(id);
        previous.set(id, record);
        try {
          await replace(record, next, compiled);
        } catch (error) {
          if (old) previous.set(id, old);
          else previous.delete(id);
          throw error;
        }
        return clone(next);
      });
    },
    async readClient(id) {
      const record = required(id);
      current(record);
      const snapshot = await verifyComplete(record);
      current(record);
      if (!record.package.clientEntry) throw new Error("Package has no client entry");
      return {
        code: snapshot.files.get(record.package.clientEntry)!.toString("utf8"),
        contentHash: record.contentHash,
      };
    },
    async readAsset(id, expectedContentHash, path, signal) {
      const record = required(id);
      if (record.contentHash !== expectedContentHash) throw new Error("Installed content changed");
      current(record);
      if (signal.aborted) throw new Error("Asset read cancelled");
      if (record.package.format !== 4) throw new Error("Package has no declared assets");
      const asset = record.package.assets.find((candidate) => candidate.path === path);
      if (!asset) throw new Error("Package asset is not declared");
      const count = activeAssetReadsByInstallation.get(id) ?? 0;
      if (activeAssetReads >= 16) throw new Error("Asset read limit reached");
      if (count >= 4) throw new Error("Installation asset read limit reached");
      activeAssetReads += 1;
      activeAssetReadsByInstallation.set(id, count + 1);
      try {
        await verify(record);
        current(record);
        if (signal.aborted) throw new Error("Asset read cancelled");
        const bytes = await readDeclaredAsset(
          NodePath.join(root, "packages", record.contentHash),
          asset,
        );
        if (signal.aborted) throw new Error("Asset read cancelled");
        current(record);
        return { bytes: new Uint8Array(bytes), mediaType: asset.mediaType, sha256: asset.sha256 };
      } finally {
        activeAssetReads -= 1;
        const remaining = (activeAssetReadsByInstallation.get(id) ?? 1) - 1;
        if (remaining > 0) activeAssetReadsByInstallation.set(id, remaining);
        else activeAssetReadsByInstallation.delete(id);
      }
    },
    invoke: invokeWorker,
    invokeApi(id, expectedContentHash, request, signal, root) {
      const record = required(id);
      if (record.contentHash !== expectedContentHash)
        return Promise.reject(new Error("Installed content changed"));
      return broker.invoke(record, request, signal, undefined, root);
    },
    subscribeApi(id, expectedContentHash, request, signal, root) {
      const record = required(id);
      if (record.contentHash !== expectedContentHash) throw new Error("Installed content changed");
      current(record);
      return broker.subscribe(record, request, signal, undefined, root);
    },
    async discoverApis(id, expectedContentHash, context, signal) {
      const record = required(id);
      if (record.contentHash !== expectedContentHash)
        return Promise.reject(new Error("Installed content changed"));
      current(record);
      // Discovery only awaits providers the requester can serve or call: itself,
      // the providers resolved for its declared API requirements, and its direct
      // plugin dependencies. Unrelated providers still verify and start so their
      // health and failure marking stay accurate, but their readiness is not on
      // the critical path and their lifecycle changes cannot fail this call.
      const related = new Set([record.id]);
      const requiredApis = new Set(
        [
          ...(record.package.requires ?? []),
          ...(record.package.dependencies ?? []).flatMap((dependency) => dependency.apis),
        ].map((api) => api.id),
      );
      for (const api of broker.resolution().apis)
        if (api.providerId && requiredApis.has(api.id)) related.add(api.providerId);
      for (const dependency of record.package.dependencies ?? []) related.add(dependency.pluginId);
      for (const provider of installations.values()) {
        if (signal.aborted) throw new Error("Discovery cancelled");
        if (
          !provider.package.serverEntry ||
          broker.resolution().plugins.find((item) => item.id === provider.id)?.status !==
            "available"
        )
          continue;
        const awaited = related.has(provider.id);
        const ready = (async () => {
          try {
            await verify(provider);
            current(provider);
            await start(provider).ready;
          } catch (error) {
            if (disposed || installations.get(provider.id) !== provider) {
              if (awaited) throw new Error("Discovery installation changed", { cause: error });
              return;
            }
            health.set(provider.id, "failed");
            broker.invalidate(affectedPlugins([provider.id]));
            publishCatalogueChange();
          }
        })();
        if (awaited) await ready;
      }
      return broker.discover(record, context, signal);
    },
    selectApi(selection) {
      return mutate(async () => {
        assertId(selection.id);
        assertId(selection.providerId);
        if (
          !Array.isArray(selection.fallbackProviderIds) ||
          selection.fallbackProviderIds.length > 32
        )
          throw new Error("Invalid provider fallbacks");
        selection.fallbackProviderIds.forEach(assertId);
        const next = [...selections.filter((item) => item.id !== selection.id), clone(selection)];
        if (next.length > 128) throw new Error("Provider selection limit reached");
        resolveCapabilities({
          installations: [...installations.values()],
          providers: options.apiProviders ?? [],
          selections: next,
        });
        const before = broker.resolution();
        await persist(installations, next);
        selections = next;
        await invalidatePlugins(affectedPlugins([], [...installations.values()], before));
      });
    },
    rollback(id) {
      return mutate(async () => {
        const record = required(id);
        const old = previous.get(id);
        if (!old) throw new Error("No rollback package available");
        const next = { ...old, grants: record.grants, enabled: record.enabled };
        await verifyComplete(next);
        broker.validatePackage(next);
        await stage(next);
        previous.set(id, record);
        try {
          await replace(record, next, compile(next.package));
        } catch (error) {
          previous.set(id, old);
          throw error;
        }
        return clone(next);
      });
    },
    async dispose() {
      if (disposed) return;
      await mutations;
      disposed = true;
      broker.invalidate();
      for (const worker of workers.values()) stop(worker, new Error("Runtime disposed"), false);
      await Promise.all(draining);
    },
  };
}

export type {
  HostApiProvider,
  HostApiInvocationMetadata,
  HostApiPrincipal,
  HostApiRootAuthority,
} from "./broker.js";
