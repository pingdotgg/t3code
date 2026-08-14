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

import { resolveDesktopMcpBinaryPathSync } from "./resolveBinary.ts";

let daemon: ChildProcess | null = null;
/** Generation counter so a late `exit` from an old child cannot clear a newer daemon. */
let daemonGeneration = 0;
let rootPath: string | null = null;
let stopping: Promise<void> | null = null;

process.on("exit", () => {
  if (daemon && !daemon.killed) {
    try {
      daemon.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
});

export function computerHistoryRootForStateDir(stateDir: string): string {
  return resolveComputerHistoryRoot(stateDir);
}

export async function syncControl(
  stateDir: string,
  settings: ComputerHistorySettings,
): Promise<void> {
  const root = resolveComputerHistoryRoot(stateDir);
  rootPath = root;
  await ensureComputerHistoryLayout(root);
  await writeControlFile(root, {
    enabled: settings.enabled,
    paused: settings.paused,
    appFilterMode: settings.appFilterMode,
    apps: [...settings.apps],
    websiteFilterMode: settings.websiteFilterMode,
    websites: [...settings.websites],
  });
}

export async function ensureDaemon(
  stateDir: string,
  settings: ComputerHistorySettings,
): Promise<void> {
  await syncControl(stateDir, settings);
  const root = resolveComputerHistoryRoot(stateDir);
  rootPath = root;

  if (!settings.enabled) {
    await stopDaemon();
    return;
  }

  if (stopping) {
    await stopping;
  }

  if (daemon && !daemon.killed) {
    return;
  }

  const binary = resolveDesktopMcpBinaryPathSync();
  if (!binary) {
    await writeUnavailableStatus(root, "t3-desktop-mcp binary not found");
    return;
  }

  const generation = ++daemonGeneration;
  const child = spawn(binary, ["computer-history", "--root", root], {
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
  });
  daemon = child;
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });
  child.on("error", (error) => {
    if (daemon === child && daemonGeneration === generation) {
      daemon = null;
    }
    void writeUnavailableStatus(root, `failed to start computer-history daemon: ${error.message}`);
  });
  child.on("exit", () => {
    // Only clear the slot if this child is still the current generation —
    // otherwise a stop/restart race would drop the replacement handle.
    if (daemon === child && daemonGeneration === generation) {
      daemon = null;
    }
  });
}

export async function stopDaemon(): Promise<void> {
  if (stopping) {
    await stopping;
    return;
  }
  const child = daemon;
  if (!child) return;

  stopping = new Promise<void>((resolve) => {
    const finish = () => {
      if (daemon === child) {
        daemon = null;
      }
      stopping = null;
      resolve();
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

  await stopping;
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

export async function getStatus(
  stateDir: string,
  settings: ComputerHistorySettings,
): Promise<ComputerHistoryStatus> {
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
    phase: !settings.enabled ? "stopped" : (file?.phase ?? (daemon ? "starting" : "stopped")),
    accessibilityGranted: file?.accessibilityGranted ?? false,
    rootPath: root,
    memoriesPath,
    ...(codexMirrorPath ? { codexMirrorPath } : {}),
    ...(file?.activeSegmentId ? { activeSegmentId: file.activeSegmentId } : {}),
    eventCount: file?.eventCount ?? 0,
    ...(file?.lastError ? { lastError: file.lastError } : {}),
    platform: file?.platform ?? process.platform,
  };
}

export async function getTimeline(stateDir: string): Promise<ComputerHistoryTimeline> {
  const root = resolveComputerHistoryRoot(stateDir);
  return listTimeline(root);
}

export async function clear(
  stateDir: string,
  scope: ComputerHistoryClearScope,
  settings: ComputerHistorySettings,
): Promise<ComputerHistoryTimeline> {
  const root = resolveComputerHistoryRoot(stateDir);
  return clearHistory(root, scope, {
    ...(settings.mirrorToCodex ? { codexHome: defaultCodexHome() } : {}),
  });
}

export async function removeMemory(
  stateDir: string,
  path: string,
  settings: ComputerHistorySettings,
): Promise<ComputerHistoryTimeline> {
  const root = resolveComputerHistoryRoot(stateDir);
  return deleteMemory(root, path, {
    ...(settings.mirrorToCodex ? { codexHome: defaultCodexHome() } : {}),
  });
}

export async function revealMemory(path: string): Promise<boolean> {
  if (!NodeFs.existsSync(path)) return false;
  shell.showItemInFolder(path);
  return true;
}

export function currentRoot(): string | null {
  return rootPath;
}
