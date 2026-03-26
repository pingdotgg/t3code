/**
 * FactoryDroidAdapterLive - Factory Droid provider adapter.
 *
 * Wraps `droid exec` JSON-RPC protocol behind the shared provider adapter
 * contract. Streams token-level deltas via coalesced `content.delta` events.
 *
 * @module FactoryDroidAdapterLive
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import readline from "node:readline";
import {
  ApprovalRequestId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderStartOptions,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
} from "../Errors.ts";
import {
  FactoryDroidAdapter,
  type FactoryDroidAdapterShape,
} from "../Services/FactoryDroidAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  FACTORY_DROID_PROVIDER as PROVIDER,
  asObj,
  makeFactoryDroidBaseEvent,
  makeFactoryDroidContentDeltaEvent,
  mapFactoryDroidNotification,
} from "./FactoryDroidRuntimeEvents.ts";

// ── Constants ─────────────────────────────────────────────────────────

const API_VERSION = "1.0.0";
const PROTOCOL_VERSION = "1.1.0";
const DELTA_COALESCE_MS = 50;
const IDLE_COMPLETION_MS = 200;

// ── Helpers ───────────────────────────────────────────────────────────

const now = () => new Date().toISOString();

function resolveBinaryPath(opts: ProviderStartOptions | undefined): string {
  return (
    opts?.factoryDroid?.binaryPath?.trim() ||
    process.env.T3CODE_FACTORY_DROID_BINARY_PATH?.trim() ||
    "droid"
  );
}

function modelFromSelection(
  sel: { readonly provider: string; readonly model: string } | undefined,
): string | undefined {
  return sel?.provider === PROVIDER ? sel.model : undefined;
}

// ── Session context ───────────────────────────────────────────────────

interface Ctx {
  session: ProviderSession;
  providerOptions: ProviderStartOptions | undefined;
  child: ChildProcessWithoutNullStreams | null;
  initialized: boolean;
  stopped: boolean;
  turns: Array<{ id: TurnId; items: unknown[] }>;
  activeTurnId: TurnId | null;
  rpc: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  pendingUserInputs: Map<
    string,
    {
      readonly resolve: (answers: ProviderUserInputAnswers) => void;
      readonly reject: (e: Error) => void;
    }
  >;
  toolUseRegistry: Map<string, import("./FactoryDroidRuntimeEvents.ts").ToolUseEntry>;
  assistantBuf: string;
  reasoningBuf: string;
  sawDelta: boolean;
  segment: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

function clearTimers(c: Ctx) {
  if (c.flushTimer !== null) {
    clearTimeout(c.flushTimer);
    c.flushTimer = null;
  }
  if (c.idleTimer !== null) {
    clearTimeout(c.idleTimer);
    c.idleTimer = null;
  }
}

function resetBuffers(c: Ctx) {
  c.assistantBuf = "";
  c.reasoningBuf = "";
  c.sawDelta = false;
  c.segment = 0;
}

function makeCtx(session: ProviderSession, providerOptions?: ProviderStartOptions): Ctx {
  return {
    session,
    providerOptions,
    child: null,
    initialized: false,
    stopped: false,
    turns: [],
    activeTurnId: null,
    rpc: new Map(),
    pendingUserInputs: new Map(),
    toolUseRegistry: new Map(),
    assistantBuf: "",
    reasoningBuf: "",
    sawDelta: false,
    segment: 0,
    flushTimer: null,
    idleTimer: null,
  };
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────

function rpcMsg(type: string, extra: Record<string, unknown>) {
  return JSON.stringify({
    factoryApiVersion: API_VERSION,
    factoryProtocolVersion: PROTOCOL_VERSION,
    type,
    jsonrpc: "2.0",
    ...extra,
  });
}

// ── Adapter factory ───────────────────────────────────────────────────

const turnsSnapshot = (c: Ctx) =>
  c.turns.map((t) => ({ id: t.id, items: t.items as ReadonlyArray<unknown> }));

export interface FactoryDroidAdapterLiveOptions {
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const makeAdapter = (options?: FactoryDroidAdapterLiveOptions) =>
  Effect.gen(function* () {
    const sessions = new Map<ThreadId, Ctx>();
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const emit = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Queue.offer(queue, event).pipe(
        Effect.tap(() =>
          options?.nativeEventLogger ? options.nativeEventLogger.write(event, null) : Effect.void,
        ),
        Effect.asVoid,
      );

    const emitSync = (event: ProviderRuntimeEvent) => {
      void Effect.runPromise(emit(event));
    };

    const requireCtx = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const c = sessions.get(threadId);
        if (!c)
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        if (c.stopped)
          return yield* new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
        return c;
      });

    function flushDeltas(c: Ctx, threadId: ThreadId) {
      if (c.flushTimer !== null) {
        clearTimeout(c.flushTimer);
        c.flushTimer = null;
      }
      const turnId = c.activeTurnId;
      if (!turnId) return;
      if (c.assistantBuf.length > 0) {
        const d = c.assistantBuf;
        c.assistantBuf = "";
        emitSync(
          makeFactoryDroidContentDeltaEvent(
            threadId,
            turnId,
            "assistant_text",
            d,
            `seg-${c.segment}-${turnId}`,
          ),
        );
      }
      if (c.reasoningBuf.length > 0) {
        const d = c.reasoningBuf;
        c.reasoningBuf = "";
        emitSync(makeFactoryDroidContentDeltaEvent(threadId, turnId, "reasoning_text", d));
      }
    }

    function scheduleFlush(c: Ctx, threadId: ThreadId) {
      if (c.flushTimer !== null) return;
      c.flushTimer = setTimeout(() => {
        c.flushTimer = null;
        flushDeltas(c, threadId);
      }, DELTA_COALESCE_MS);
    }

    function scheduleIdle(c: Ctx, threadId: ThreadId, turnId: TurnId) {
      if (c.idleTimer !== null) return;
      c.idleTimer = setTimeout(() => {
        c.idleTimer = null;
        flushDeltas(c, threadId);
        c.activeTurnId = null;
        c.session = { ...c.session, status: "ready", activeTurnId: undefined, updatedAt: now() };
        emitSync({
          ...makeFactoryDroidBaseEvent(threadId),
          type: "turn.completed",
          turnId,
          payload: { state: "completed" },
        } as unknown as ProviderRuntimeEvent);
      }, IDLE_COMPLETION_MS);
    }

    const stopInternal = (c: Ctx, emitExit: boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (c.stopped) return;
        c.stopped = true;
        clearTimers(c);
        if (c.child && !c.child.killed) c.child.kill();
        c.session = { ...c.session, status: "closed", activeTurnId: undefined, updatedAt: now() };
        for (const [, p] of c.rpc) p.reject(new Error("Session stopped"));
        c.rpc.clear();
        for (const [, p] of c.pendingUserInputs) p.reject(new Error("Session stopped"));
        c.pendingUserInputs.clear();
        c.toolUseRegistry.clear();
        sessions.delete(c.session.threadId);
        if (emitExit) {
          yield* emit({
            ...makeFactoryDroidBaseEvent(c.session.threadId),
            type: "session.exited",
            payload: { reason: "stopped" },
          } as unknown as ProviderRuntimeEvent);
        }
      });

    function sendRpc(c: Ctx, method: string, params: Record<string, unknown>): Promise<unknown> {
      return new Promise((resolve, reject) => {
        if (!c.child || c.child.killed || c.stopped) {
          reject(
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: c.session.threadId,
              detail: "Child process not available",
            }),
          );
          return;
        }
        const id = randomUUID();
        c.rpc.set(id, { resolve, reject });
        c.child.stdin.write(rpcMsg("request", { id, method, params }) + "\n");
      });
    }

    function hasToolUse(notif: Record<string, unknown>): boolean {
      const msg = asObj(notif.message);
      const content = msg && Array.isArray(msg.content) ? msg.content : undefined;
      return content?.some((b: unknown) => asObj(b)?.type === "tool_use") ?? false;
    }

    function setupListener(c: Ctx, threadId: ThreadId) {
      if (!c.child) return;
      const child = c.child;
      const rl = readline.createInterface({ input: child.stdout });

      rl.on("line", (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        const t = msg.type as string | undefined;

        if (t === "response") {
          const id = msg.id as string | null;
          const pending = id ? c.rpc.get(id) : undefined;
          if (pending) {
            c.rpc.delete(id!);
            if (msg.error) {
              pending.reject(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "jsonrpc",
                  detail: (msg.error as { message?: string }).message ?? "JSON-RPC error",
                }),
              );
            } else {
              pending.resolve(msg.result);
            }
          }
          return;
        }

        if (t === "notification") {
          const notif = (msg.params as { notification?: Record<string, unknown> })?.notification;
          if (!notif) return;
          const nt = notif.type as string;
          const turnId = c.activeTurnId;

          if ((nt === "assistant_text_delta" || nt === "thinking_text_delta") && turnId) {
            const delta = notif.textDelta as string;
            if (delta) {
              if (nt === "assistant_text_delta") {
                c.sawDelta = true;
                c.assistantBuf += delta;
              } else c.reasoningBuf += delta;
              scheduleFlush(c, threadId);
            }
          } else if (nt === "droid_working_state_changed") {
            const st = notif.newState as string;
            if (st === "idle" && turnId) scheduleIdle(c, threadId, turnId);
            else if (st !== "idle" && c.idleTimer !== null) {
              clearTimeout(c.idleTimer);
              c.idleTimer = null;
            }
          } else {
            if (nt === "create_message" && hasToolUse(notif)) {
              flushDeltas(c, threadId);
              c.segment += 1;
              c.sawDelta = false;
            }
            const { events, fallbackText } = mapFactoryDroidNotification({
              notif,
              sawAssistantTextDelta: c.sawDelta,
              threadId,
              toolUseRegistry: c.toolUseRegistry,
              ...(turnId ? { turnId } : {}),
            });
            for (const e of events) emitSync(e);
            if (fallbackText) {
              c.sawDelta = true;
              c.assistantBuf += fallbackText;
              scheduleFlush(c, threadId);
            }
          }
          return;
        }

        if (t === "request") {
          const method = msg.method as string;
          if (method === "droid.request_permission") {
            child.stdin.write(
              rpcMsg("response", { id: msg.id, result: { selectedOption: "always_allow" } }) + "\n",
            );
          } else if (method === "droid.ask_user") {
            const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
            const params = asObj(msg.params as Record<string, unknown>);
            const rawQuestions = params && Array.isArray(params.questions) ? params.questions : [];

            const questions: UserInputQuestion[] = rawQuestions
              .map((q: Record<string, unknown>, idx: number) => {
                const id = typeof q.id === "string" ? q.id : `q-${idx}`;
                const index = typeof q.index === "number" ? q.index : idx + 1;
                const header =
                  typeof q.header === "string"
                    ? q.header
                    : typeof q.topic === "string"
                      ? q.topic
                      : `Question ${index}`;
                const question =
                  typeof q.question === "string"
                    ? q.question
                    : typeof q.text === "string"
                      ? q.text
                      : "";
                const options = Array.isArray(q.options)
                  ? (q.options as Array<Record<string, unknown> | string>).map((opt) => {
                      if (typeof opt === "string") return { label: opt, description: "" };
                      return {
                        label: typeof opt.label === "string" ? opt.label : String(opt),
                        description: typeof opt.description === "string" ? opt.description : "",
                      };
                    })
                  : [];
                return { id, header, question, options };
              })
              .filter((q: UserInputQuestion) => q.question.length > 0);

            if (questions.length === 0 || c.stopped) {
              child.stdin.write(
                rpcMsg("response", { id: msg.id, result: { cancelled: true, answers: [] } }) + "\n",
              );
              return;
            }

            const promise = new Promise<ProviderUserInputAnswers>((resolve, reject) => {
              c.pendingUserInputs.set(requestId, { resolve, reject });
            });

            const turnId = c.activeTurnId;
            emitSync({
              ...makeFactoryDroidBaseEvent(threadId),
              ...(turnId ? { turnId } : {}),
              type: "user-input.requested",
              requestId,
              payload: { questions },
              providerRefs: turnId ? { providerTurnId: turnId } : undefined,
              raw: {
                source: "factorydroid.jsonrpc.request",
                method: "droid.ask_user",
                payload: params,
              },
            } as unknown as ProviderRuntimeEvent);

            void promise.then(
              (answers) => {
                emitSync({
                  ...makeFactoryDroidBaseEvent(threadId),
                  ...(turnId ? { turnId } : {}),
                  type: "user-input.resolved",
                  requestId,
                  payload: { answers },
                  providerRefs: turnId ? { providerTurnId: turnId } : undefined,
                  raw: {
                    source: "factorydroid.jsonrpc.request",
                    method: "droid.ask_user/resolved",
                    payload: { answers },
                  },
                } as unknown as ProviderRuntimeEvent);

                // Build the response in the Droid CLI's expected format:
                // { cancelled: false, answers: [{ index, question, answer }] }
                const droidAnswers: Array<{ index: number; question: string; answer: string }> = [];
                for (let i = 0; i < questions.length; i++) {
                  const q = questions[i]!;
                  const rawQ = rawQuestions[i] as Record<string, unknown> | undefined;
                  const answer = answers[q.id];
                  if (answer != null) {
                    droidAnswers.push({
                      index: typeof rawQ?.index === "number" ? rawQ.index : i + 1,
                      question: q.question,
                      answer: String(answer),
                    });
                  }
                }
                child.stdin.write(
                  rpcMsg("response", {
                    id: msg.id,
                    result: { cancelled: false, answers: droidAnswers },
                  }) + "\n",
                );
              },
              () => {
                child.stdin.write(
                  rpcMsg("response", { id: msg.id, result: { cancelled: true, answers: [] } }) +
                    "\n",
                );
              },
            );
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text && c.activeTurnId) {
          emitSync({
            ...makeFactoryDroidBaseEvent(threadId),
            type: "runtime.error",
            turnId: c.activeTurnId,
            payload: { message: text },
          } as unknown as ProviderRuntimeEvent);
        }
      });

      child.on("exit", (code) => {
        if (c.child !== child) return;
        clearTimers(c);
        flushDeltas(c, threadId);
        const turnId = c.activeTurnId;
        c.child = null;
        c.initialized = false;
        c.session = {
          ...c.session,
          status: code === 0 ? "ready" : "error",
          activeTurnId: undefined,
          ...(code !== 0 ? { lastError: `droid exec exited with code ${code}` } : {}),
          updatedAt: now(),
        };
        if (turnId) {
          c.activeTurnId = null;
          emitSync({
            ...makeFactoryDroidBaseEvent(threadId),
            type: "turn.completed",
            turnId,
            payload: { state: code === 0 ? "completed" : "failed" },
          } as unknown as ProviderRuntimeEvent);
        }
      });
    }

    async function ensureProcess(c: Ctx, threadId: ThreadId) {
      if (c.initialized && c.child && !c.child.killed) return;
      const bin = resolveBinaryPath(c.providerOptions);
      const auto = c.session.runtimeMode === "approval-required" ? "low" : "high";
      const child = spawn(
        bin,
        [
          "exec",
          "--output-format",
          "stream-jsonrpc",
          "--input-format",
          "stream-jsonrpc",
          "--auto",
          auto,
        ],
        {
          cwd: c.session.cwd,
          env: { ...process.env },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      c.child = child;
      setupListener(c, threadId);
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      c.session = { ...c.session, status: "ready", updatedAt: now() };
      await sendRpc(c, "droid.initialize_session", {
        machineId: os.hostname(),
        sessionId: randomUUID(),
        cwd: c.session.cwd,
        modelId: c.session.model,
        autonomyLevel: auto,
        interactionMode: "default",
      });
      c.initialized = true;
    }

    const startSession: FactoryDroidAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const t = now();
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          model: modelFromSelection(input.modelSelection),
          cwd: input.cwd ?? process.cwd(),
          threadId: input.threadId,
          createdAt: t,
          updatedAt: t,
        };
        sessions.set(input.threadId, makeCtx(session, input.providerOptions));
        yield* emit({
          ...makeFactoryDroidBaseEvent(input.threadId),
          type: "session.started",
          payload: {},
        } as unknown as ProviderRuntimeEvent);
        return { ...session };
      });

    const sendTurn: FactoryDroidAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const c = yield* requireCtx(input.threadId);
        const turnId = TurnId.makeUnsafe(randomUUID());
        const turnModel = modelFromSelection(input.modelSelection);
        if (turnModel && turnModel !== c.session.model)
          c.session = { ...c.session, model: turnModel };
        c.session = { ...c.session, status: "running", activeTurnId: turnId, updatedAt: now() };
        c.activeTurnId = turnId;
        resetBuffers(c);
        c.turns.push({ id: turnId, items: [] });
        yield* emit({
          ...makeFactoryDroidBaseEvent(input.threadId),
          type: "turn.started",
          turnId,
          payload: turnModel ? { model: turnModel } : {},
        } as unknown as ProviderRuntimeEvent);
        yield* Effect.promise(async () => {
          await ensureProcess(c, input.threadId);
          await sendRpc(c, "droid.add_user_message", { text: input.input ?? "" });
        });
        return { threadId: input.threadId, turnId };
      });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions, ([, c]) => stopInternal(c, false), { discard: true }).pipe(
        Effect.tap(() => Queue.shutdown(queue)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        statelessRecovery: true,
        requiresStreamingDelivery: true,
      },
      startSession,
      sendTurn,
      interruptTurn: (threadId) =>
        Effect.gen(function* () {
          const c = yield* requireCtx(threadId);
          if (c.initialized && c.child && !c.child.killed) {
            yield* Effect.promise(() =>
              sendRpc(c, "droid.interrupt_session", {}).catch(() => {
                c.child?.kill();
              }),
            );
          } else if (c.child && !c.child.killed) c.child.kill();
        }),
      readThread: (threadId) =>
        requireCtx(threadId).pipe(Effect.map((c) => ({ threadId, turns: turnsSnapshot(c) }))),
      rollbackThread: (threadId, n) =>
        requireCtx(threadId).pipe(
          Effect.map((c) => {
            c.turns.splice(Math.max(0, c.turns.length - n));
            return { threadId, turns: turnsSnapshot(c) };
          }),
        ),
      respondToRequest: (threadId) => requireCtx(threadId).pipe(Effect.asVoid),
      respondToUserInput: (threadId, requestId, answers) =>
        requireCtx(threadId).pipe(
          Effect.flatMap((c) =>
            Effect.sync(() => {
              const pending = c.pendingUserInputs.get(requestId);
              if (!pending) {
                throw new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "item/tool/respondToUserInput",
                  detail: `Unknown pending user-input request: ${requestId}`,
                });
              }
              c.pendingUserInputs.delete(requestId);
              pending.resolve(answers);
            }),
          ),
        ),
      stopSession: (threadId) =>
        requireCtx(threadId).pipe(Effect.flatMap((c) => stopInternal(c, true))),
      listSessions: () =>
        Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session }))),
      hasSession: (threadId) =>
        Effect.sync(() => {
          const c = sessions.get(threadId);
          return c !== undefined && !c.stopped;
        }),
      stopAll: () => Effect.forEach(sessions, ([, c]) => stopInternal(c, true), { discard: true }),
      streamEvents: Stream.fromQueue(queue),
    } satisfies FactoryDroidAdapterShape;
  });

export const FactoryDroidAdapterLive = Layer.effect(FactoryDroidAdapter, makeAdapter());

export function makeFactoryDroidAdapterLive(options?: FactoryDroidAdapterLiveOptions) {
  return Layer.effect(FactoryDroidAdapter, makeAdapter(options));
}
