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
      "ensureDaemon",
      "stopDaemon",
      "getStatus",
      "getTimeline",
      "clear",
      "removeMemory",
    ]),
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

export class ComputerHistoryManager extends Context.Service<
  ComputerHistoryManager,
  {
    readonly ensureDaemon: (
      stateDir: string,
      settings: ComputerHistorySettings,
    ) => Effect.Effect<void>;
    readonly stopDaemon: () => Effect.Effect<void>;
    readonly getStatus: (
      stateDir: string,
      settings: ComputerHistorySettings,
    ) => Effect.Effect<ComputerHistoryStatus>;
    readonly getTimeline: (stateDir: string) => Effect.Effect<ComputerHistoryTimeline>;
    readonly clear: (
      stateDir: string,
      scope: ComputerHistoryClearScope,
      settings: ComputerHistorySettings,
    ) => Effect.Effect<ComputerHistoryTimeline>;
    readonly removeMemory: (
      stateDir: string,
      path: string,
      settings: ComputerHistorySettings,
    ) => Effect.Effect<ComputerHistoryTimeline, ComputerHistoryOperationError>;
    readonly revealMemory: (path: string) => Effect.Effect<boolean>;
    readonly currentRoot: () => Effect.Effect<string | null>;
  }
>()("ComputerHistoryManager") {}

export const make = Effect.gen(function* () {
  // Plain mutable state — avoids Effect.runPromise on every Ref touch inside
  // imperative daemon helpers (Macroscope Effect Service Conventions).
  const state: DaemonState = {
    child: null,
    generation: 0,
    rootPath: null,
    stopping: null,
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
      );
    });
    child.on("exit", () => {
      if (state.child === child && state.generation === generation) {
        state.child = null;
      }
    });
  };

  return ComputerHistoryManager.of({
    ensureDaemon: (stateDir, settings) =>
      Effect.tryPromise({
        try: () => ensureDaemonImpl(stateDir, settings),
        catch: (cause) =>
          new ComputerHistoryOperationError({
            operation: "ensureDaemon",
            cause,
          }),
      }).pipe(Effect.orDie),
    stopDaemon: () =>
      Effect.tryPromise({
        try: () => stopDaemonImpl(),
        catch: (cause) =>
          new ComputerHistoryOperationError({
            operation: "stopDaemon",
            cause,
          }),
      }).pipe(Effect.orDie),
    getStatus: (stateDir, settings) =>
      Effect.tryPromise({
        try: async () => {
          const root = resolveComputerHistoryRoot(stateDir);
          await ensureComputerHistoryLayout(root);
          const file = await readStatusFile(root);
          const memoriesPath = NodePath.join(root, "memories", "resources");
          const codexMirrorPath = settings.mirrorToCodex
            ? NodePath.join(defaultCodexHome(), "memories", "extensions", "skysight", "resources")
            : undefined;
          return {
            enabled: settings.enabled,
            paused: settings.paused,
            phase: !settings.enabled
              ? "stopped"
              : (file?.phase ?? (state.child ? "starting" : "stopped")),
            accessibilityGranted: file?.accessibilityGranted ?? false,
            rootPath: root,
            memoriesPath,
            ...(codexMirrorPath ? { codexMirrorPath } : {}),
            ...(file?.activeSegmentId ? { activeSegmentId: file.activeSegmentId } : {}),
            eventCount: file?.eventCount ?? 0,
            ...(file?.lastError ? { lastError: file.lastError } : {}),
            platform: file?.platform ?? process.platform,
          } satisfies ComputerHistoryStatus;
        },
        catch: (cause) =>
          new ComputerHistoryOperationError({
            operation: "getStatus",
            cause,
          }),
      }).pipe(Effect.orDie),
    getTimeline: (stateDir) =>
      Effect.tryPromise({
        try: () => listTimeline(resolveComputerHistoryRoot(stateDir)),
        catch: (cause) =>
          new ComputerHistoryOperationError({
            operation: "getTimeline",
            cause,
          }),
      }).pipe(Effect.orDie),
    clear: (stateDir, scope, settings) =>
      Effect.tryPromise({
        try: () =>
          clearHistory(resolveComputerHistoryRoot(stateDir), scope, {
            ...(settings.mirrorToCodex ? { codexHome: defaultCodexHome() } : {}),
          }),
        catch: (cause) =>
          new ComputerHistoryOperationError({
            operation: "clear",
            cause,
          }),
      }).pipe(Effect.orDie),
    removeMemory: (stateDir, path, settings) =>
      Effect.tryPromise({
        try: () =>
          deleteMemory(resolveComputerHistoryRoot(stateDir), path, {
            ...(settings.mirrorToCodex ? { codexHome: defaultCodexHome() } : {}),
          }),
        catch: (cause) =>
          new ComputerHistoryOperationError({
            operation: "removeMemory",
            cause,
          }),
      }),
    revealMemory: (path) =>
      Effect.sync(() => {
        if (!NodeFs.existsSync(path)) return false;
        shell.showItemInFolder(path);
        return true;
      }),
    currentRoot: () => Effect.sync(() => state.rootPath),
  });
});

export const layer = Layer.effect(ComputerHistoryManager, make);
