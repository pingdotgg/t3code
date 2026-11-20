// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off -- Worker entrypoint owns process stdio, signals, and final exit.
import * as NodeReadline from "node:readline";
import type { AgentOptions } from "@cursor/sdk";
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

const CLOSE_GRACE_MS = 3_000;

function cursorSandboxUnsupported(cause: unknown): boolean {
  const seen = new Set<object>();
  let current = cause;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error && current.message.includes("sandboxing is not supported")) {
      return true;
    }
    current = Reflect.get(current, "cause");
  }
  return false;
}

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
  let session: CursorAgentSdk.CursorAgentSdkSession | undefined;
  const activeRuns = new Map<number, CursorAgentSdk.CursorAgentSdkRun>();
  let shuttingDown = false;
  let exitCode = 0;

  const runner = await runtime.runPromise(
    CursorAgentSdk.makeCursorAgentSdkRunner(
      () => (event) =>
        Effect.sync(() => {
          if (activeSendStarts > 0 && event.payload.type === "run.cancel") {
            writeMessage({ type: "protocolLog", event });
          }
        }),
    ),
  );

  const runTextGenerate = Effect.fn("CursorSdkWorker.textGenerate")(function* (
    req: Extract<CursorWorkerRequest, { readonly type: "textGenerate" }>,
  ) {
    const sdk = yield* CursorSdk.CursorSdk;
    const { Agent } = yield* Effect.try({
      try: sdk.load,
      catch: (cause) =>
        new CursorAgentSdk.CursorAgentSdkRunnerError({ method: "textGenerate.load", cause }),
    });
    const store = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          sdk.loadSqlite().SqliteLocalAgentStore.open({
            workspaceRef: req.cwd,
            stateRoot: req.stateRoot,
          }),
        catch: (cause) =>
          new CursorAgentSdk.CursorAgentSdkRunnerError({ method: "textGenerate.store", cause }),
      }),
      (opened) =>
        Effect.tryPromise({
          try: () => opened.dispose(),
          catch: () => undefined,
        }).pipe(Effect.ignore),
    );
    const baseOptions: AgentOptions = {
      apiKey: req.apiKey,
      mode: "plan",
      model: req.model,
      local: {
        cwd: req.cwd,
        store,
        autoReview: false,
        sandboxOptions: { enabled: true },
        settingSources: [],
        enableAgentRetries: true,
      },
    };
    const runPrompt = (sandboxEnabled: boolean) =>
      Effect.scoped(
        Effect.gen(function* () {
          const agent = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: (signal) =>
                Agent.create(
                  sandboxEnabled
                    ? baseOptions
                    : {
                        ...baseOptions,
                        local: {
                          ...baseOptions.local,
                          sandboxOptions: { enabled: false },
                        },
                      },
                ).then((created) => {
                  if (signal.aborted) created.close();
                  return created;
                }),
              catch: (cause) =>
                new CursorAgentSdk.CursorAgentSdkRunnerError({
                  method: "textGenerate.create",
                  cause,
                }),
            }),
            (created) =>
              Effect.tryPromise({
                try: () => created[Symbol.asyncDispose](),
                catch: () => undefined,
              }).pipe(Effect.timeout("5 seconds"), Effect.ignore),
            { interruptible: true },
          );
          const run = yield* Effect.tryPromise({
            try: (signal) =>
              agent.send(req.prompt).then((started) => {
                if (signal.aborted) void started.cancel().catch(() => undefined);
                return started;
              }),
            catch: (cause) =>
              new CursorAgentSdk.CursorAgentSdkRunnerError({
                method: "textGenerate.send",
                cause,
              }),
          });
          yield* Effect.addFinalizer(() =>
            run.status === "running"
              ? Effect.tryPromise({
                  try: () => run.cancel(),
                  catch: () => undefined,
                }).pipe(Effect.timeout("5 seconds"), Effect.ignore)
              : Effect.void,
          );
          return yield* Effect.tryPromise({
            try: () => run.wait(),
            catch: (cause) =>
              new CursorAgentSdk.CursorAgentSdkRunnerError({
                method: "textGenerate.wait",
                cause,
              }),
          });
        }),
      );
    return yield* runPrompt(true).pipe(
      Effect.catchIf(
        (error) => cursorSandboxUnsupported(error.cause),
        () => runPrompt(false),
      ),
    );
  }, Effect.scoped);

  const closeActiveSession = async (): Promise<
    Exit.Exit<void, CursorAgentSdk.CursorAgentSdkRunnerError>
  > => {
    const current = session;
    session = undefined;
    if (current === undefined) {
      return Exit.void;
    }
    return await runtime.runPromiseExit(
      current.close.pipe(Effect.timeoutOption(`${CLOSE_GRACE_MS} millis`), Effect.asVoid),
    );
  };

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (code: number): Promise<void> => {
    exitCode = Math.max(exitCode, code);
    if (shutdownPromise !== undefined) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      try {
        await closeActiveSession();
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
        const exit = await runtime.runPromiseExit(
          runner.open({
            operation: req.operation,
            ...(req.agentId === undefined ? {} : { agentId: req.agentId }),
            ...(req.storeCwd === undefined ? {} : { storeCwd: req.storeCwd }),
            options: req.options,
            threadId: req.threadId,
            providerSessionId: req.providerSessionId,
          }),
        );
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("open", exit),
          });
          return;
        }
        session = exit.value;
        writeMessage({
          type: "response",
          id: req.id,
          ok: true,
          result: { agentId: exit.value.agentId },
        });
        return;
      }

      case "send": {
        if (session === undefined) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: toRunnerFailure("run.start", new Error("Cursor SDK session is not open.")),
          });
          return;
        }
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
                  writeMessage({ type: "delta", sendId: req.id, update });
                }),
            }),
          );
        } finally {
          activeSendStarts -= 1;
        }
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure(req.resume === true ? "run.resume" : "run.start", exit),
          });
          return;
        }
        const run = exit.value;
        activeRuns.set(req.id, run);
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
        const run = activeRuns.get(req.sendId);
        if (run?.steer === undefined) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: true,
            result: "revert_to_followup",
          });
          return;
        }
        const exit = await runtime.runPromiseExit(run.steer(req.text));
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
        const run = activeRuns.get(req.sendId);
        if (run === undefined) {
          writeMessage({ type: "response", id: req.id, ok: true, result: null });
          return;
        }
        const exit = await runtime.runPromiseExit(run.cancel);
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
        const exit = await runtime.runPromiseExit(runTextGenerate(req));
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

      case "close": {
        const exit = await closeActiveSession();
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
