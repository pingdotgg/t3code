// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off -- Worker entrypoint owns process stdio, signals, and final exit.
import * as NodeReadline from "node:readline";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Path from "effect/Path";

import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import {
  type CursorWorkerMessage,
  type CursorWorkerRequest,
  type SerializedRunnerFailure,
  decodeWorkerFrame,
  encodeWorkerFrame,
  serializeRunResult,
  serializeWorkerError,
} from "./CursorAgentSdkWorkerProtocol.ts";
import * as CursorSdk from "./CursorSdk.ts";
import { runCursorTextGenerationInProcess } from "./textGeneration.ts";

const CLOSE_GRACE_MS = 3_000;

function toRunnerFailure(method: string, cause: unknown): SerializedRunnerFailure {
  if (CursorAgentSdk.isCursorAgentSdkRunnerError(cause)) {
    return {
      method: cause.method,
      cause: serializeWorkerError(cause.cause),
    };
  }
  return {
    method,
    cause: serializeWorkerError(cause),
  };
}

function exitFailure(
  method: string,
  exit: Exit.Failure<unknown, unknown>,
): SerializedRunnerFailure {
  const squashed = Cause.squash(exit.cause);
  return toRunnerFailure(method, squashed);
}

export async function runCursorSdkWorker(
  platformLayer: Layer.Layer<FileSystem.FileSystem | Path.Path>,
): Promise<void> {
  // Electron has already booted in Node mode; strip the flag so agent shells do not inherit it.
  delete process.env.ELECTRON_RUN_AS_NODE;

  // Reserve fd 1 exclusively for NDJSON frames; redirect stray SDK logs to stderr.
  const rawStdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  process.stdout.write = stderrWrite as typeof process.stdout.write;
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  console.warn = console.error;

  const writeMessage = (message: CursorWorkerMessage): void => {
    try {
      rawStdoutWrite(encodeWorkerFrame(message));
    } catch {
      // Parent closed the pipe; stdin EOF will trigger shutdown.
    }
  };

  const flushStdout = () =>
    new Promise<void>((resolve) => {
      try {
        rawStdoutWrite("", () => resolve());
      } catch {
        resolve();
      }
    });

  const runtime = ManagedRuntime.make(CursorSdk.layer.pipe(Layer.provideMerge(platformLayer)));

  let activeSendStarts = 0;
  // One worker hosts every Cursor session; each session is keyed by its open request id.
  const sessions = new Map<number, CursorAgentSdk.CursorAgentSdkSession>();
  const openingSessionIds = new Set<number>();
  const pendingClosedSessionIds = new Set<number>();
  // Other sessions keep the worker alive, so an abandoned generation must be interrupted here.
  const textGenerations = new Map<number, AbortController>();
  const activeRuns = new Map<
    number,
    { readonly sessionId: number; readonly run: CursorAgentSdk.CursorAgentSdkRun }
  >();
  const startingSendIds = new Set<number>();
  const pendingCancelledSendIds = new Set<number>();
  const sessionIdByOptions = new WeakMap<object, number>();
  let shuttingDown = false;
  let exitCode = 0;

  const runner = await runtime.runPromise(
    CursorAgentSdk.makeCursorAgentSdkRunner((input) => {
      const boundSessionId = sessionIdByOptions.get(input.options);
      return (event) =>
        Effect.sync(() => {
          if (activeSendStarts > 0 && event.payload.type === "run.cancel") {
            writeMessage({
              type: "protocolLog",
              providerSessionId: input.providerSessionId,
              ...(boundSessionId === undefined ? {} : { sessionId: boundSessionId }),
              event,
            });
          }
        });
    }),
  );

  const closeSession = async (
    sessionId: number,
  ): Promise<Exit.Exit<void, CursorAgentSdk.CursorAgentSdkRunnerError>> => {
    if (openingSessionIds.has(sessionId)) {
      pendingClosedSessionIds.add(sessionId);
    }
    const current = sessions.get(sessionId);
    sessions.delete(sessionId);
    for (const [sendId, entry] of activeRuns.entries()) {
      if (entry.sessionId === sessionId) {
        activeRuns.delete(sendId);
        void runtime.runPromiseExit(
          entry.run.cancel.pipe(Effect.timeoutOption(`${CLOSE_GRACE_MS} millis`), Effect.ignore),
        );
      }
    }
    if (current === undefined) {
      return Exit.void;
    }
    return await runtime.runPromiseExit(
      current.close.pipe(Effect.timeoutOption(`${CLOSE_GRACE_MS} millis`), Effect.asVoid),
    );
  };

  const closeAllSessions = () =>
    Promise.all(Array.from(sessions.keys(), (sessionId) => closeSession(sessionId)));

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (code: number): Promise<void> => {
    exitCode = Math.max(exitCode, code);
    if (shutdownPromise !== undefined) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      try {
        await closeAllSessions();
      } catch {
        // Best-effort cleanup before exit.
      }
      try {
        await Promise.race([
          runtime.dispose(),
          new Promise<void>((resolve) => setTimeout(resolve, CLOSE_GRACE_MS).unref()),
        ]);
      } catch {
        // Best-effort runtime disposal.
      }
      await flushStdout();
      process.exit(exitCode);
    })();
    return shutdownPromise;
  };

  const handleRequest = async (req: CursorWorkerRequest): Promise<void> => {
    if (shuttingDown && req.type !== "close") {
      writeMessage({
        type: "response",
        id: req.id,
        ok: false,
        error: toRunnerFailure(req.type, new Error("Cursor SDK worker is shutting down.")),
      });
      return;
    }

    switch (req.type) {
      case "open": {
        openingSessionIds.add(req.id);
        sessionIdByOptions.set(req.options, req.id);
        let exit: Exit.Exit<
          CursorAgentSdk.CursorAgentSdkSession,
          CursorAgentSdk.CursorAgentSdkRunnerError
        >;
        try {
          exit = await runtime.runPromiseExit(
            runner.open({
              operation: req.operation,
              ...(req.agentId === undefined ? {} : { agentId: req.agentId }),
              ...(req.storeCwd === undefined ? {} : { storeCwd: req.storeCwd }),
              options: req.options,
              threadId: req.threadId,
              providerSessionId: req.providerSessionId,
            }),
          );
        } finally {
          openingSessionIds.delete(req.id);
        }
        if (Exit.isFailure(exit)) {
          pendingClosedSessionIds.delete(req.id);
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("open", exit),
          });
          return;
        }
        if (pendingClosedSessionIds.delete(req.id)) {
          await runtime.runPromiseExit(
            exit.value.close.pipe(Effect.timeoutOption(`${CLOSE_GRACE_MS} millis`), Effect.ignore),
          );
          const aborted = Object.assign(new Error("Cursor session was closed while opening."), {
            name: "AbortError",
          });
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: toRunnerFailure("open", aborted),
          });
          return;
        }
        sessions.set(req.id, exit.value);
        writeMessage({
          type: "response",
          id: req.id,
          ok: true,
          result: { agentId: exit.value.agentId },
        });
        return;
      }

      case "send": {
        const session = sessions.get(req.sessionId);
        if (session === undefined) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: toRunnerFailure("run.start", new Error("Cursor SDK session is not open.")),
          });
          return;
        }
        startingSendIds.add(req.id);
        activeSendStarts += 1;
        let exit: Exit.Exit<
          CursorAgentSdk.CursorAgentSdkRun,
          CursorAgentSdk.CursorAgentSdkRunnerError
        >;
        try {
          exit = await runtime.runPromiseExit(
            session.send({
              message: req.message,
              ...(req.options === undefined ? {} : { options: req.options }),
              ...(req.summarize === undefined ? {} : { summarize: req.summarize }),
              ...(req.resume === undefined ? {} : { resume: req.resume }),
              onDelta: (update) =>
                Effect.sync(() => {
                  if (sessions.has(req.sessionId) && !pendingCancelledSendIds.has(req.id)) {
                    writeMessage({ type: "delta", sendId: req.id, update });
                  }
                }),
            }),
          );
        } finally {
          startingSendIds.delete(req.id);
          activeSendStarts -= 1;
        }
        if (Exit.isFailure(exit)) {
          pendingCancelledSendIds.delete(req.id);
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure(req.resume === true ? "run.resume" : "run.start", exit),
          });
          return;
        }
        const run = exit.value;
        // Session closed or cancel arrived while send was starting: stop the run immediately.
        if (!sessions.has(req.sessionId) || pendingCancelledSendIds.delete(req.id)) {
          await runtime.runPromiseExit(
            run.cancel.pipe(Effect.timeoutOption(`${CLOSE_GRACE_MS} millis`), Effect.ignore),
          );
          const aborted = Object.assign(new Error("Cursor run was cancelled while starting."), {
            name: "AbortError",
          });
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: toRunnerFailure(req.resume === true ? "run.resume" : "run.start", aborted),
          });
          return;
        }
        activeRuns.set(req.id, { sessionId: req.sessionId, run });
        writeMessage({
          type: "response",
          id: req.id,
          ok: true,
          result: { runId: run.runId, agentId: run.agentId },
        });
        void runtime.runPromiseExit(run.wait).then((waitExit) => {
          activeRuns.delete(req.id);
          if (Exit.isFailure(waitExit)) {
            writeMessage({
              type: "runDone",
              sendId: req.id,
              ok: false,
              error: exitFailure("run.wait", waitExit),
            });
            return;
          }
          writeMessage({
            type: "runDone",
            sendId: req.id,
            ok: true,
            result: serializeRunResult(waitExit.value),
          });
        });
        return;
      }

      case "steer": {
        const entry = activeRuns.get(req.sendId);
        if (entry?.run.steer === undefined) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: true,
            result: "revert_to_followup",
          });
          return;
        }
        const exit = await runtime.runPromiseExit(entry.run.steer(req.text));
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("run.steer", exit),
          });
          return;
        }
        writeMessage({ type: "response", id: req.id, ok: true, result: exit.value });
        return;
      }

      case "cancel": {
        const entry = activeRuns.get(req.sendId);
        if (entry === undefined) {
          if (startingSendIds.has(req.sendId)) {
            pendingCancelledSendIds.add(req.sendId);
          }
          writeMessage({ type: "response", id: req.id, ok: true, result: null });
          return;
        }
        const exit = await runtime.runPromiseExit(entry.run.cancel);
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("run.cancel", exit),
          });
          return;
        }
        writeMessage({ type: "response", id: req.id, ok: true, result: null });
        return;
      }

      case "listMessages": {
        const session = sessions.get(req.sessionId);
        if (session === undefined) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: toRunnerFailure(
              "agent.messages.list",
              new Error("Cursor SDK session is not open."),
            ),
          });
          return;
        }
        const exit = await runtime.runPromiseExit(session.listMessages);
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("agent.messages.list", exit),
          });
          return;
        }
        writeMessage({ type: "response", id: req.id, ok: true, result: exit.value });
        return;
      }

      case "readContextUsage": {
        const session = sessions.get(req.sessionId);
        if (session?.readContextUsage === undefined) {
          writeMessage({ type: "response", id: req.id, ok: true, result: null });
          return;
        }
        const exit = await runtime.runPromiseExit(session.readContextUsage);
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("agent.checkpoint.load", exit),
          });
          return;
        }
        writeMessage({ type: "response", id: req.id, ok: true, result: exit.value ?? null });
        return;
      }

      case "runCheckpointed": {
        const session = sessions.get(req.sessionId);
        if (session?.runCheckpointed === undefined) {
          writeMessage({ type: "response", id: req.id, ok: true, result: false });
          return;
        }
        const exit = await runtime.runPromiseExit(session.runCheckpointed(req.runId));
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("agent.run.get", exit),
          });
          return;
        }
        writeMessage({ type: "response", id: req.id, ok: true, result: exit.value });
        return;
      }

      case "rewindAfterRun": {
        const session = sessions.get(req.sessionId);
        if (session?.rewindAfterRun === undefined) {
          writeMessage({ type: "response", id: req.id, ok: true, result: null });
          return;
        }
        const exit = await runtime.runPromiseExit(session.rewindAfterRun(req.runId));
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("agent.rewind", exit),
          });
          return;
        }
        writeMessage({ type: "response", id: req.id, ok: true, result: null });
        return;
      }

      case "textGenerate": {
        const abort = new AbortController();
        textGenerations.set(req.id, abort);
        const exit = await runtime
          .runPromiseExit(runCursorTextGenerationInProcess(req), { signal: abort.signal })
          .finally(() => textGenerations.delete(req.id));
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("textGenerate", exit),
          });
          return;
        }
        writeMessage({
          type: "response",
          id: req.id,
          ok: true,
          result: serializeRunResult(exit.value),
        });
        return;
      }

      case "cancelTextGenerate": {
        textGenerations.get(req.textGenerateId)?.abort();
        writeMessage({ type: "response", id: req.id, ok: true, result: null });
        return;
      }

      case "closeSession": {
        const exit = await closeSession(req.sessionId);
        writeMessage(
          Exit.isFailure(exit)
            ? { type: "response", id: req.id, ok: false, error: exitFailure("agent.close", exit) }
            : { type: "response", id: req.id, ok: true, result: null },
        );
        return;
      }

      case "close": {
        const exits = await closeAllSessions();
        const exit = exits.find(Exit.isFailure) ?? Exit.void;
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("agent.close", exit),
          });
        } else {
          writeMessage({ type: "response", id: req.id, ok: true, result: null });
        }
        void shutdown(0);
        return;
      }
    }
  };

  process.on("SIGTERM", () => {
    void shutdown(0);
  });
  process.on("SIGINT", () => {
    void shutdown(0);
  });

  const rl = NodeReadline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed: CursorWorkerRequest;
    try {
      parsed = decodeWorkerFrame(line) as CursorWorkerRequest;
    } catch (cause) {
      console.error("Invalid Cursor SDK worker frame:", cause);
      return;
    }
    void handleRequest(parsed).catch((cause) => {
      writeMessage({
        type: "response",
        id: parsed.id,
        ok: false,
        error: toRunnerFailure(parsed.type, cause),
      });
    });
  });

  rl.on("close", () => {
    void shutdown(0);
  });

  // Stay alive until shutdown calls process.exit.
  await new Promise<void>(() => {});
}
