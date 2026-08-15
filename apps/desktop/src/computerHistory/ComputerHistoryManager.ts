// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { spawn, type ChildProcess } from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { shell } from "electron";

import type {
  ComputerHistoryClearScope,
  ComputerHistoryStatus,
  ComputerHistoryTimeline,
  ComputerHistorySettings,
} from "@t3tools/contracts";
import {
  clearHistory,
  computerHistoryResourcesDir,
  defaultCodexHome,
  deleteMemory,
  ensureComputerHistoryLayout,
  listTimeline,
  readStatusFile,
  resolveComputerHistoryRoot,
  writeControlFile,
} from "@t3tools/shared/computerHistory";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { resolveDesktopMcpBinaryPathSync } from "./resolveBinary.ts";

type DaemonState = {
  child: ChildProcess | null;
  generation: number;
  rootPath: string | null;
  stopping: Promise<void> | null;
};

export class ComputerHistoryOperationError extends Schema.TaggedErrorClass<ComputerHistoryOperationError>()(
  "ComputerHistoryOperationError",
  {
    operation: Schema.Literals([
      "mergePatchSettings",
      "ensureDaemon",
      "stopDaemon",
      "getStatus",
      "getTimeline",
      "clear",
      "removeMemory",
      "revealMemory",
    ]),
    root: Schema.String,
    path: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Computer History ${this.operation} failed`;
  }
}

async function writeUnavailableStatus(root: string, lastError: string): Promise<void> {
  await ensureComputerHistoryLayout(root);
  const payload = {
    phase: "unavailable",
    accessibilityGranted: false,
    eventCount: 0,
    platform: process.platform,
    updatedAt: new Date().toISOString(),
    lastError,
  };
  await NodeFs.promises.writeFile(
    NodePath.join(root, "status.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

// Errors stay in the Effect error channel so callers can catch/ignore.
// Never convert these to defects — bootstrap and quit recover with Effect.catch.
export class ComputerHistoryManager extends Context.Service<
  ComputerHistoryManager,
  {
    readonly mergePatchSettings: (
      stateDir: string,
      persisted: ComputerHistorySettings,
      patch: Partial<ComputerHistorySettings>,
    ) => Effect.Effect<ComputerHistorySettings, ComputerHistoryOperationError>;
    readonly ensureDaemon: (
      stateDir: string,
      settings: ComputerHistorySettings,
    ) => Effect.Effect<void, ComputerHistoryOperationError>;
    readonly stopDaemon: () => Effect.Effect<void, ComputerHistoryOperationError>;
    readonly getStatus: (
      stateDir: string,
      settings: ComputerHistorySettings,
    ) => Effect.Effect<ComputerHistoryStatus, ComputerHistoryOperationError>;
    readonly getTimeline: (
      stateDir: string,
    ) => Effect.Effect<ComputerHistoryTimeline, ComputerHistoryOperationError>;
    readonly clear: (
      stateDir: string,
      scope: ComputerHistoryClearScope,
      settings: ComputerHistorySettings,
    ) => Effect.Effect<ComputerHistoryTimeline, ComputerHistoryOperationError>;
    readonly removeMemory: (
      stateDir: string,
      path: string,
      settings: ComputerHistorySettings,
    ) => Effect.Effect<ComputerHistoryTimeline, ComputerHistoryOperationError>;
    readonly revealMemory: (
      stateDir: string,
      path: string,
    ) => Effect.Effect<boolean, ComputerHistoryOperationError>;
    readonly currentRoot: () => Effect.Effect<string | null>;
  }
>()("ComputerHistoryManager") {}

const runDaemonOp = (
  operation: "ensureDaemon" | "stopDaemon",
  root: string,
  run: () => Promise<void>,
): Effect.Effect<void, ComputerHistoryOperationError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ComputerHistoryOperationError({ operation, root, cause }),
  });

export const make = Effect.gen(function* () {
  // Plain mutable state — avoids Effect.runPromise on every Ref touch inside
  // imperative daemon helpers (Macroscope Effect Service Conventions).
  const state: DaemonState = {
    child: null,
    generation: 0,
    rootPath: null,
    stopping: null,
  };

  // Serialize ensure/stop so a stale status poll cannot respawn after disable.
  let ensureChain: Promise<void> = Promise.resolve();
  // Serialize settings patches so rapid IPC updates merge instead of clobbering.
  let patchChain: Promise<ComputerHistorySettings | null> = Promise.resolve(null);
  let lastMergedSettings: ComputerHistorySettings | null = null;
  const enqueueEnsure = (task: () => Promise<void>): Promise<void> => {
    const run = ensureChain.then(task, task);
    ensureChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const stopDaemonImpl = async (): Promise<void> => {
    if (state.stopping) {
      await state.stopping;
      return;
    }
    const child = state.child;
    if (!child) return;

    let stopping!: Promise<void>;
    stopping = new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        child.off("exit", onExit);
        if (state.child === child) {
          state.child = null;
        }
        // Only clear if this stop still owns the slot — a later stop must keep its promise.
        if (state.stopping === stopping) {
          state.stopping = null;
        }
        resolve();
      };

      const onExit = () => {
        finish();
      };
      child.once("exit", onExit);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
        return;
      }
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        finish();
      }, 2_000);
    });

    state.stopping = stopping;
    await stopping;
  };

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      try {
        await stopDaemonImpl();
      } catch {
        // Best-effort teardown on layer shutdown.
      }
    }),
  );

  const ensureDaemonImpl = async (
    stateDir: string,
    settings: ComputerHistorySettings,
  ): Promise<void> => {
    const root = resolveComputerHistoryRoot(stateDir);
    await ensureComputerHistoryLayout(root);
    await writeControlFile(root, {
      enabled: settings.enabled,
      paused: settings.paused,
      appFilterMode: settings.appFilterMode,
      apps: [...settings.apps],
      websiteFilterMode: settings.websiteFilterMode,
      websites: [...settings.websites],
    });
    state.rootPath = root;

    if (!settings.enabled) {
      await stopDaemonImpl();
      return;
    }

    if (state.stopping) {
      await state.stopping;
    }
    if (state.child && !state.child.killed) {
      return;
    }

    const binary = resolveDesktopMcpBinaryPathSync();
    if (!binary) {
      await writeUnavailableStatus(root, "t3-desktop-mcp binary not found");
      return;
    }

    const generation = state.generation + 1;
    const child = spawn(binary, ["computer-history", "--root", root], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    });
    state.child = child;
    state.generation = generation;
    state.rootPath = root;
    state.stopping = null;
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      if (state.child === child && state.generation === generation) {
        state.child = null;
      }
      void writeUnavailableStatus(
        root,
        `failed to start computer-history daemon: ${error.message}`,
      ).catch(() => {
        // Best-effort status write — never crash the main process.
      });
    });
    child.on("exit", (code, signal) => {
      if (state.generation !== generation) {
        return;
      }
      if (state.child === child) {
        state.child = null;
      }
      // Intentional stop (disable / layer shutdown) — do not mark unavailable.
      if (state.stopping !== null) {
        return;
      }
      const detail =
        code === null
          ? `computer-history daemon exited (${signal ?? "signal"})`
          : `computer-history daemon exited (code ${code})`;
      void writeUnavailableStatus(root, detail).catch(() => {
        // Best-effort status write — never crash the main process.
      });
    });
  };

  const mergePatchSettingsImpl = async (
    _stateDir: string,
    persisted: ComputerHistorySettings,
    patch: Partial<ComputerHistorySettings>,
  ): Promise<ComputerHistorySettings> => {
    const base = lastMergedSettings ?? persisted;
    // Never resurrect `enabled` from control.json — the server may rewrite that
    // file from stale ServerSettings while a disable patch is in flight.
    const enabled = patch.enabled ?? base.enabled;
    const merged = {
      ...base,
      ...patch,
      enabled,
      ...(patch.apps === undefined ? {} : { apps: [...patch.apps] }),
      ...(patch.websites === undefined ? {} : { websites: [...patch.websites] }),
    };
    lastMergedSettings = merged;
    return merged;
  };

  const applyPatchSettings = (
    stateDir: string,
    persisted: ComputerHistorySettings,
    patch: Partial<ComputerHistorySettings>,
  ): Promise<ComputerHistorySettings> => {
    const run = patchChain.then(() => mergePatchSettingsImpl(stateDir, persisted, patch));
    patchChain = run.then(
      (settings) => settings,
      () => lastMergedSettings,
    );
    return run;
  };

  return ComputerHistoryManager.of({
    mergePatchSettings: (stateDir, persisted, patch) =>
      Effect.tryPromise({
        try: () => applyPatchSettings(stateDir, persisted, patch),
        catch: (cause) => {
          const root = resolveComputerHistoryRoot(stateDir);
          return new ComputerHistoryOperationError({
            operation: "mergePatchSettings",
            root,
            cause,
          });
        },
      }),
    ensureDaemon: (stateDir, settings) =>
      runDaemonOp("ensureDaemon", resolveComputerHistoryRoot(stateDir), () =>
        enqueueEnsure(() => ensureDaemonImpl(stateDir, settings)),
      ),
    stopDaemon: () =>
      runDaemonOp("stopDaemon", state.rootPath ?? "", () => enqueueEnsure(() => stopDaemonImpl())),
    getStatus: (stateDir, settings) =>
      Effect.tryPromise({
        try: async () => {
          const root = resolveComputerHistoryRoot(stateDir);
          await ensureComputerHistoryLayout(root);
          const file = await readStatusFile(root);
          const daemonRunning = Boolean(state.child && !state.child.killed);
          const staleRunning =
            settings.enabled &&
            !daemonRunning &&
            (file?.phase === "running" || file?.phase === "paused");
          if (staleRunning) {
            await writeUnavailableStatus(root, "computer-history daemon is not running");
          }
          const liveFile = staleRunning ? await readStatusFile(root) : file;
          const memoriesPath = NodePath.join(root, "memories", "resources");
          const codexMirrorPath = settings.mirrorToCodex
            ? NodePath.join(defaultCodexHome(), "memories", "extensions", "skysight", "resources")
            : undefined;
          return {
            enabled: settings.enabled,
            paused: settings.paused,
            phase: !settings.enabled
              ? "stopped"
              : daemonRunning
                ? (liveFile?.phase ?? "starting")
                : (liveFile?.phase ?? "stopped"),
            accessibilityGranted: liveFile?.accessibilityGranted ?? false,
            rootPath: root,
            memoriesPath,
            ...(codexMirrorPath ? { codexMirrorPath } : {}),
            ...(liveFile?.activeSegmentId ? { activeSegmentId: liveFile.activeSegmentId } : {}),
            eventCount: liveFile?.eventCount ?? 0,
            ...(liveFile?.lastError ? { lastError: liveFile.lastError } : {}),
            platform: liveFile?.platform ?? process.platform,
          } satisfies ComputerHistoryStatus;
        },
        catch: (cause) =>
          new ComputerHistoryOperationError({
            operation: "getStatus",
            root: resolveComputerHistoryRoot(stateDir),
            cause,
          }),
      }),
    getTimeline: (stateDir) =>
      Effect.tryPromise({
        try: () => listTimeline(resolveComputerHistoryRoot(stateDir)),
        catch: (cause) =>
          new ComputerHistoryOperationError({
            operation: "getTimeline",
            root: resolveComputerHistoryRoot(stateDir),
            cause,
          }),
      }),
    clear: (stateDir, scope, settings) =>
      Effect.tryPromise({
        try: () =>
          clearHistory(resolveComputerHistoryRoot(stateDir), scope, {
            ...(settings.mirrorToCodex ? { codexHome: defaultCodexHome() } : {}),
          }),
        catch: (cause) =>
          new ComputerHistoryOperationError({
            operation: "clear",
            root: resolveComputerHistoryRoot(stateDir),
            cause,
          }),
      }),
    removeMemory: (stateDir, path, settings) =>
      Effect.tryPromise({
        try: () =>
          deleteMemory(resolveComputerHistoryRoot(stateDir), path, {
            ...(settings.mirrorToCodex ? { codexHome: defaultCodexHome() } : {}),
          }),
        catch: (cause) =>
          new ComputerHistoryOperationError({
            operation: "removeMemory",
            root: resolveComputerHistoryRoot(stateDir),
            path,
            cause,
          }),
      }),
    revealMemory: (stateDir, path) =>
      Effect.tryPromise({
        try: async () => {
          const root = resolveComputerHistoryRoot(stateDir);
          const resourcesDir = computerHistoryResourcesDir(root);
          const resolved = NodePath.resolve(path);
          const resourcesRoot = NodePath.resolve(resourcesDir);
          if (resolved !== resourcesRoot && !resolved.startsWith(resourcesRoot + NodePath.sep)) {
            return false;
          }
          if (!NodeFs.existsSync(resolved)) return false;
          shell.showItemInFolder(resolved);
          return true;
        },
        catch: (cause) =>
          new ComputerHistoryOperationError({
            operation: "revealMemory",
            root: resolveComputerHistoryRoot(stateDir),
            path,
            cause,
          }),
      }),
    currentRoot: () => Effect.sync(() => state.rootPath),
  });
});

export const layer: Layer.Layer<ComputerHistoryManager> = Layer.effect(
  ComputerHistoryManager,
  make,
);
