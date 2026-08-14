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
import * as Ref from "effect/Ref";

import { resolveDesktopMcpBinaryPathSync } from "./resolveBinary.ts";

export function computerHistoryRootForStateDir(stateDir: string): string {
  return resolveComputerHistoryRoot(stateDir);
}

type DaemonState = {
  child: ChildProcess | null;
  generation: number;
  rootPath: string | null;
  stopping: Promise<void> | null;
};

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
    ) => Effect.Effect<ComputerHistoryTimeline>;
    readonly revealMemory: (path: string) => Effect.Effect<boolean>;
    readonly currentRoot: () => Effect.Effect<string | null>;
  }
>()("ComputerHistoryManager") {}

const make = Effect.gen(function* () {
  const stateRef = yield* Ref.make<DaemonState>({
    child: null,
    generation: 0,
    rootPath: null,
    stopping: null,
  });

  const stopDaemonImpl = async (): Promise<void> => {
    const current = await Effect.runPromise(Ref.get(stateRef));
    if (current.stopping) {
      await current.stopping;
      return;
    }
    const child = current.child;
    if (!child) return;

    const stopping = new Promise<void>((resolve) => {
      const finish = () => {
        void Effect.runPromise(
          Ref.update(stateRef, (state) => ({
            ...state,
            child: state.child === child ? null : state.child,
            stopping: null,
          })),
        ).finally(resolve);
      };

      const onExit = () => {
        clearTimeout(timer);
        finish();
      };
      child.once("exit", onExit);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        finish();
      }, 2_000);
    });

    await Effect.runPromise(Ref.update(stateRef, (state) => ({ ...state, stopping })));
    await stopping;
  };

  yield* Effect.addFinalizer(() => Effect.promise(() => stopDaemonImpl()));

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
    await Effect.runPromise(Ref.update(stateRef, (state) => ({ ...state, rootPath: root })));

    if (!settings.enabled) {
      await stopDaemonImpl();
      return;
    }

    const before = await Effect.runPromise(Ref.get(stateRef));
    if (before.stopping) {
      await before.stopping;
    }
    const live = await Effect.runPromise(Ref.get(stateRef));
    if (live.child && !live.child.killed) {
      return;
    }

    const binary = resolveDesktopMcpBinaryPathSync();
    if (!binary) {
      await writeUnavailableStatus(root, "t3-desktop-mcp binary not found");
      return;
    }

    const generation = live.generation + 1;
    const child = spawn(binary, ["computer-history", "--root", root], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    });
    await Effect.runPromise(
      Ref.set(stateRef, {
        child,
        generation,
        rootPath: root,
        stopping: null,
      }),
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      void Effect.runPromise(
        Ref.update(stateRef, (state) =>
          state.child === child && state.generation === generation
            ? { ...state, child: null }
            : state,
        ),
      );
      void writeUnavailableStatus(
        root,
        `failed to start computer-history daemon: ${error.message}`,
      );
    });
    child.on("exit", () => {
      void Effect.runPromise(
        Ref.update(stateRef, (state) =>
          state.child === child && state.generation === generation
            ? { ...state, child: null }
            : state,
        ),
      );
    });
  };

  return ComputerHistoryManager.of({
    ensureDaemon: (stateDir, settings) =>
      Effect.promise(() => ensureDaemonImpl(stateDir, settings)),
    stopDaemon: () => Effect.promise(() => stopDaemonImpl()),
    getStatus: (stateDir, settings) =>
      Effect.promise(async () => {
        const root = resolveComputerHistoryRoot(stateDir);
        await ensureComputerHistoryLayout(root);
        const file = await readStatusFile(root);
        const memoriesPath = NodePath.join(root, "memories", "resources");
        const codexMirrorPath = settings.mirrorToCodex
          ? NodePath.join(defaultCodexHome(), "memories", "extensions", "skysight", "resources")
          : undefined;
        const { child } = await Effect.runPromise(Ref.get(stateRef));
        return {
          enabled: settings.enabled,
          paused: settings.paused,
          phase: !settings.enabled ? "stopped" : (file?.phase ?? (child ? "starting" : "stopped")),
          accessibilityGranted: file?.accessibilityGranted ?? false,
          rootPath: root,
          memoriesPath,
          ...(codexMirrorPath ? { codexMirrorPath } : {}),
          ...(file?.activeSegmentId ? { activeSegmentId: file.activeSegmentId } : {}),
          eventCount: file?.eventCount ?? 0,
          ...(file?.lastError ? { lastError: file.lastError } : {}),
          platform: file?.platform ?? process.platform,
        } satisfies ComputerHistoryStatus;
      }),
    getTimeline: (stateDir) =>
      Effect.promise(async () => listTimeline(resolveComputerHistoryRoot(stateDir))),
    clear: (stateDir, scope, settings) =>
      Effect.promise(async () =>
        clearHistory(resolveComputerHistoryRoot(stateDir), scope, {
          ...(settings.mirrorToCodex ? { codexHome: defaultCodexHome() } : {}),
        }),
      ),
    removeMemory: (stateDir, path, settings) =>
      Effect.promise(async () =>
        deleteMemory(resolveComputerHistoryRoot(stateDir), path, {
          ...(settings.mirrorToCodex ? { codexHome: defaultCodexHome() } : {}),
        }),
      ),
    revealMemory: (path) =>
      Effect.sync(() => {
        if (!NodeFs.existsSync(path)) return false;
        shell.showItemInFolder(path);
        return true;
      }),
    currentRoot: () => Ref.get(stateRef).pipe(Effect.map((state) => state.rootPath)),
  });
});

export const layer = Layer.effect(ComputerHistoryManager, make);
