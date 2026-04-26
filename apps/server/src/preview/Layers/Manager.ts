import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";
import path from "node:path";

import {
  PreviewManagerError,
  PreviewManifest,
  type PreviewOpenInput,
  type PreviewRestartInput,
  type PreviewSessionError,
  type PreviewSessionLogEntry,
  type PreviewSessionSnapshot,
  type PreviewSessionStreamEvent,
} from "@forma/contracts";
import { NetService } from "@forma/shared/Net";
import { Effect, Layer, PubSub, Schema, Stream } from "effect";

import { PreviewManager, type PreviewManagerShape } from "../Services/Manager.ts";
import { inspectPreviewConfig, type SerializablePreviewConfig } from "../previewConfigInspector.ts";

const PREVIEW_CONFIG_FILENAME = "forma.preview.ts";
const PREVIEW_HOST = "127.0.0.1";
const PREVIEW_READY_TIMEOUT_MS = 30_000;
const PREVIEW_READY_POLL_INTERVAL_MS = 500;
const PREVIEW_IDLE_TIMEOUT_MS = 60_000;
const PREVIEW_LOG_LIMIT = 200;

interface PreviewSessionState {
  readonly threadId: string;
  cwd: string;
  worktreePath: string | null;
  workspaceRoot: string;
  status: PreviewSessionSnapshot["status"];
  baseUrl: string | null;
  manifestUrl: string | null;
  command: string[];
  launchCwd: string | null;
  pid: number | null;
  startedAt: string | null;
  updatedAt: string;
  error: PreviewSessionError | null;
  logs: PreviewSessionLogEntry[];
  process: ChildProcessWithoutNullStreams | null;
  idleTimeout: ReturnType<typeof setTimeout> | null;
  launchId: number;
  launchConfigKey: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clearIdleTimeout(session: PreviewSessionState): void {
  if (session.idleTimeout !== null) {
    clearTimeout(session.idleTimeout);
    session.idleTimeout = null;
  }
}

function trimLogLine(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toSnapshot(session: PreviewSessionState): PreviewSessionSnapshot {
  return {
    threadId: session.threadId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    workspaceRoot: session.workspaceRoot,
    status: session.status,
    baseUrl: session.baseUrl,
    manifestUrl: session.manifestUrl,
    command: [...session.command],
    launchCwd: session.launchCwd,
    pid: session.pid,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    error: session.error,
    logs: [...session.logs],
  };
}

function previewError(input: {
  readonly reason: PreviewSessionError["reason"];
  readonly message: string;
  readonly command?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly detail?: string | undefined;
}): PreviewSessionError {
  const trimmedMessage = input.message.trim();
  return {
    reason: input.reason,
    message: trimmedMessage.length > 0 ? trimmedMessage : "Preview session failed.",
    ...(input.command && input.command.length > 0
      ? { command: [...input.command] }
      : { command: [] }),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.detail ? { detail: input.detail.trim() } : {}),
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findPreviewConfigPath(startDirectory: string): Promise<string | null> {
  let currentDirectory = path.resolve(startDirectory);
  while (true) {
    const candidate = path.join(currentDirectory, PREVIEW_CONFIG_FILENAME);
    if (await pathExists(candidate)) {
      return candidate;
    }
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return null;
    }
    currentDirectory = parentDirectory;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function splitLogLines(value: string | Buffer): string[] {
  return String(value)
    .split(/\r?\n/g)
    .map((line) => trimLogLine(line))
    .filter((line): line is string => line !== null);
}

function killProcess(processHandle: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && processHandle.pid) {
    spawn("taskkill", ["/pid", String(processHandle.pid), "/T", "/F"], {
      stdio: "ignore",
      shell: true,
    }).unref();
    return;
  }
  processHandle.kill("SIGTERM");
}

export const PreviewManagerLive = Layer.effect(
  PreviewManager,
  Effect.gen(function* () {
    const net = yield* NetService;
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);
    const sessionEvents = yield* Effect.acquireRelease(
      PubSub.unbounded<PreviewSessionStreamEvent>(),
      (pubSub) => PubSub.shutdown(pubSub),
    );
    const sessions = new Map<string, PreviewSessionState>();

    const publishSnapshot = (session: PreviewSessionState) => {
      const event: PreviewSessionStreamEvent = {
        type: "snapshot",
        snapshot: toSnapshot(session),
      };
      return PubSub.publish(sessionEvents, event).pipe(Effect.asVoid);
    };

    const updateSessionTimestamp = (session: PreviewSessionState) => {
      session.updatedAt = nowIso();
    };

    const appendLog = (
      session: PreviewSessionState,
      level: PreviewSessionLogEntry["level"],
      message: string,
    ) => {
      const trimmedMessage = trimLogLine(message);
      if (!trimmedMessage) {
        return;
      }
      session.logs = [
        ...session.logs,
        {
          id: crypto.randomUUID(),
          level,
          message: trimmedMessage,
          createdAt: nowIso(),
        },
      ].slice(-PREVIEW_LOG_LIMIT);
      updateSessionTimestamp(session);
      runFork(publishSnapshot(session));
    };

    const stopSessionProcess = async (
      session: PreviewSessionState,
      options?: { remove?: boolean | undefined },
    ): Promise<void> => {
      clearIdleTimeout(session);
      const processHandle = session.process;
      session.process = null;
      session.pid = null;
      session.baseUrl = null;
      session.manifestUrl = null;
      session.launchConfigKey = null;
      if (processHandle) {
        try {
          killProcess(processHandle);
        } catch {
          // Ignore stop failures during cleanup.
        }
      }
      if (options?.remove) {
        sessions.delete(session.threadId);
      } else {
        updateSessionTimestamp(session);
        runFork(publishSnapshot(session));
      }
    };

    const setUnsupportedSession = (
      session: PreviewSessionState,
      workspaceRoot: string,
      cwd: string,
      worktreePath: string | null,
    ) => {
      session.cwd = cwd;
      session.worktreePath = worktreePath;
      session.workspaceRoot = workspaceRoot;
      session.status = "unsupported";
      session.baseUrl = null;
      session.manifestUrl = null;
      session.command = [];
      session.launchCwd = null;
      session.pid = null;
      session.startedAt = null;
      session.error = previewError({
        reason: "missing-config",
        message: `No ${PREVIEW_CONFIG_FILENAME} file was found for this workspace.`,
        cwd: workspaceRoot,
      });
      updateSessionTimestamp(session);
      runFork(publishSnapshot(session));
    };

    const waitForManifestReady = async (
      session: PreviewSessionState,
      launchId: number,
    ): Promise<void> => {
      const startedAt = Date.now();
      let lastErrorMessage = "Preview manifest did not become ready.";

      while (Date.now() - startedAt < PREVIEW_READY_TIMEOUT_MS) {
        if (session.launchId !== launchId || session.process === null) {
          throw new Error("Preview launch was replaced before readiness completed.");
        }

        try {
          const response = await fetch(session.manifestUrl ?? "", {
            headers: { accept: "application/json" },
          });
          if (response.ok) {
            const payload = await response.json();
            Schema.decodeUnknownSync(PreviewManifest)(payload);
            return;
          }
          lastErrorMessage = `Preview manifest responded with ${response.status}.`;
        } catch (error) {
          lastErrorMessage =
            error instanceof Error ? error.message : "Preview manifest did not become ready.";
        }

        await sleep(PREVIEW_READY_POLL_INTERVAL_MS);
      }

      throw new Error(lastErrorMessage);
    };

    const ensureSession = (threadId: string): PreviewSessionState => {
      const existing = sessions.get(threadId);
      if (existing) {
        return existing;
      }
      const created: PreviewSessionState = {
        threadId,
        cwd: "",
        worktreePath: null,
        workspaceRoot: "",
        status: "unsupported",
        baseUrl: null,
        manifestUrl: null,
        command: [],
        launchCwd: null,
        pid: null,
        startedAt: null,
        updatedAt: nowIso(),
        error: null,
        logs: [],
        process: null,
        idleTimeout: null,
        launchId: 0,
        launchConfigKey: null,
      };
      sessions.set(threadId, created);
      return created;
    };

    const startSession = async (
      session: PreviewSessionState,
      input: PreviewOpenInput | PreviewRestartInput,
      options?: { forceRestart?: boolean | undefined },
    ): Promise<PreviewSessionSnapshot> => {
      clearIdleTimeout(session);

      const workspaceRoot = input.worktreePath ?? input.cwd;
      const configPath = await findPreviewConfigPath(workspaceRoot);
      if (!configPath) {
        setUnsupportedSession(session, workspaceRoot, input.cwd, input.worktreePath ?? null);
        return toSnapshot(session);
      }

      let inspectedConfig: SerializablePreviewConfig;
      try {
        inspectedConfig = await inspectPreviewConfig(configPath);
      } catch (error) {
        session.cwd = input.cwd;
        session.worktreePath = input.worktreePath ?? null;
        session.workspaceRoot = workspaceRoot;
        session.status = "error";
        session.error = previewError({
          reason: "config-invalid",
          message:
            error instanceof Error
              ? error.message
              : `Failed to inspect ${PREVIEW_CONFIG_FILENAME}.`,
          cwd: configPath,
        });
        updateSessionTimestamp(session);
        runFork(publishSnapshot(session));
        return toSnapshot(session);
      }

      const configRoot = path.dirname(configPath);
      const launchCwd = path.resolve(
        configRoot,
        inspectedConfig.server.cwd ?? inspectedConfig.appRoot,
      );
      const command = [...inspectedConfig.server.command];
      const launchConfigKey = JSON.stringify({
        workspaceRoot,
        configPath,
        launchCwd,
        command,
      });

      if (
        !options?.forceRestart &&
        session.process &&
        session.launchConfigKey === launchConfigKey &&
        (session.status === "starting" || session.status === "ready")
      ) {
        updateSessionTimestamp(session);
        runFork(publishSnapshot(session));
        return toSnapshot(session);
      }

      await stopSessionProcess(session);

      const port = await Effect.runPromise(net.reserveLoopbackPort(PREVIEW_HOST));
      const baseUrl = `http://${PREVIEW_HOST}:${port}`;
      const manifestUrl = `${baseUrl}/__forma/manifest`;
      const runtimeEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...inspectedConfig.server.env,
        FORMA_PREVIEW_PORT: String(port),
        FORMA_PREVIEW_HOST: PREVIEW_HOST,
        PORT: String(port),
        HOST: PREVIEW_HOST,
        FORMA_PROJECT_ROOT: input.cwd,
        ...(input.worktreePath ? { FORMA_WORKTREE_PATH: input.worktreePath } : {}),
      };

      const child = spawn(command[0]!, command.slice(1), {
        cwd: launchCwd,
        env: runtimeEnv,
        stdio: "pipe",
        shell: process.platform === "win32",
      });

      session.launchId += 1;
      const launchId = session.launchId;
      session.cwd = input.cwd;
      session.worktreePath = input.worktreePath ?? null;
      session.workspaceRoot = workspaceRoot;
      session.status = "starting";
      session.baseUrl = baseUrl;
      session.manifestUrl = manifestUrl;
      session.command = command;
      session.launchCwd = launchCwd;
      session.pid = child.pid ?? null;
      session.startedAt = nowIso();
      session.error = null;
      session.logs = [];
      session.process = child;
      session.launchConfigKey = launchConfigKey;
      appendLog(session, "info", `Preview workspace root: ${workspaceRoot}`);
      appendLog(session, "info", `Preview config path: ${configPath}`);
      appendLog(session, "info", `Preview launch cwd: ${launchCwd}`);
      appendLog(session, "info", `Preview manifest URL: ${manifestUrl}`);
      updateSessionTimestamp(session);
      runFork(publishSnapshot(session));

      child.stdout.on("data", (chunk) => {
        if (session.launchId !== launchId || session.process !== child) {
          return;
        }
        for (const line of splitLogLines(chunk)) {
          appendLog(session, "info", line);
        }
      });

      child.stderr.on("data", (chunk) => {
        if (session.launchId !== launchId || session.process !== child) {
          return;
        }
        for (const line of splitLogLines(chunk)) {
          appendLog(session, "warn", line);
        }
      });

      child.on("exit", (code, signal) => {
        if (session.launchId !== launchId || session.process !== child) {
          return;
        }
        session.process = null;
        session.pid = null;
        session.status = "error";
        session.error = previewError({
          reason: "start-failed",
          message: `Preview server exited before remaining in a healthy state (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
          command: session.command,
          cwd: session.launchCwd ?? undefined,
        });
        updateSessionTimestamp(session);
        runFork(publishSnapshot(session));
      });

      try {
        await waitForManifestReady(session, launchId);
        if (session.launchId !== launchId || session.process !== child) {
          return toSnapshot(session);
        }
        session.status = "ready";
        session.error = null;
        updateSessionTimestamp(session);
        runFork(publishSnapshot(session));
      } catch (error) {
        if (session.launchId === launchId) {
          session.status = "error";
          session.error = previewError({
            reason: "ready-timeout",
            message:
              error instanceof Error
                ? error.message
                : "Preview manifest did not become ready before timing out.",
            command: session.command,
            cwd: session.launchCwd ?? undefined,
          });
          updateSessionTimestamp(session);
          runFork(publishSnapshot(session));
          await stopSessionProcess(session);
        }
      }

      return toSnapshot(session);
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await Promise.all(
          [...sessions.values()].map((session) =>
            stopSessionProcess(session, { remove: true }).catch(() => undefined),
          ),
        );
      }),
    );

    const manager: PreviewManagerShape = {
      open: (input) =>
        Effect.tryPromise({
          try: async () => {
            const session = ensureSession(input.threadId);
            return startSession(session, input);
          },
          catch: (cause) =>
            new PreviewManagerError({
              message: cause instanceof Error ? cause.message : "Failed to open preview session.",
              cause,
            }),
        }),
      close: (input) =>
        Effect.tryPromise({
          try: async () => {
            const session = sessions.get(input.threadId);
            if (!session) {
              return;
            }

            if (!session.process) {
              sessions.delete(input.threadId);
              return;
            }

            clearIdleTimeout(session);
            session.idleTimeout = setTimeout(() => {
              void stopSessionProcess(session, { remove: true }).catch(() => undefined);
            }, PREVIEW_IDLE_TIMEOUT_MS);
          },
          catch: (cause) =>
            new PreviewManagerError({
              message: cause instanceof Error ? cause.message : "Failed to close preview session.",
              cause,
            }),
        }),
      restart: (input) =>
        Effect.tryPromise({
          try: async () => {
            const session = ensureSession(input.threadId);
            return startSession(session, input, { forceRestart: true });
          },
          catch: (cause) =>
            new PreviewManagerError({
              message:
                cause instanceof Error ? cause.message : "Failed to restart preview session.",
              cause,
            }),
        }),
      subscribe: (input) => {
        const initialSession = sessions.get(input.threadId);
        const initialStream = initialSession
          ? Stream.fromIterable<PreviewSessionStreamEvent>([
              {
                type: "snapshot",
                snapshot: toSnapshot(initialSession),
              },
            ])
          : Stream.fromIterable<PreviewSessionStreamEvent>([]);
        const liveStream = Stream.fromPubSub(sessionEvents).pipe(
          Stream.filter((event) => event.snapshot.threadId === input.threadId),
        );
        return Stream.concat(initialStream, liveStream);
      },
    };

    return manager;
  }),
);
