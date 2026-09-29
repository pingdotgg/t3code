/**
 * CursorCloudAdapter — Cursor Cloud Agents over Cursor's HTTP API.
 *
 * The first turn creates a cloud agent on the thread's GitHub repository;
 * every later turn is a run on that agent. Runs execute in Cursor-hosted VMs,
 * so this adapter never touches the local checkout and a run keeps going
 * while T3 is disconnected. The resume cursor records the agent and any run
 * T3 has not yet seen finish, which is what lets recovery reattach.
 *
 * @module CursorCloudAdapter
 */
import {
  type ChatAttachment,
  CURSOR_CLOUD_DEFAULT_MODEL,
  type CursorSettings,
  EventId,
  type ModelSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  ProviderDriverKind,
  type ProviderInstanceId,
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  type CursorCloudApi,
  CursorCloudApiError,
  type CursorCloudGit,
  type CursorCloudPrompt,
  type CursorCloudStreamEvent,
  isTerminalRunStatus,
  makeCursorCloudApi,
} from "../cursorCloudApi.ts";
import { resolveCursorCloudRepository } from "../cursorCloudWorkspace.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  CURSOR_CLOUD_MISSING_KEY_MESSAGE,
  resolveCursorCloudApiKey,
} from "./CursorCloudProvider.ts";

const PROVIDER = ProviderDriverKind.make("cursor");
const RESUME_VERSION = 1 as const;
const RESUME_KIND = "cloud" as const;
const MAX_PROMPT_IMAGES = 5;
const MAX_RECONNECT_DELAY_MS = 30_000;

interface ActiveRun {
  readonly runId: string;
  readonly turnId: TurnId;
}

interface RunOutcome {
  readonly status: string;
  readonly text: string | undefined;
  readonly git: CursorCloudGit | undefined;
  readonly errorMessage?: string;
}

/** The run or its agent is gone, or the key no longer works; retrying cannot help. */
const UNRECOVERABLE_STATUSES = new Set([401, 403, 404]);

interface ResumeCursor {
  readonly schemaVersion: typeof RESUME_VERSION;
  /** Distinguishes a cloud cursor from the local Cursor CLI's in the same driver. */
  readonly kind: typeof RESUME_KIND;
  readonly agentId: string;
  readonly agentUrl?: string;
  /** Fixed when the agent is created; a session without it looks like a model change. */
  readonly model?: string;
  readonly activeRun?: ActiveRun;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResumeCursor(raw: unknown): ResumeCursor | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== RESUME_VERSION || raw.kind !== RESUME_KIND) {
    return undefined;
  }
  if (typeof raw.agentId !== "string" || raw.agentId.length === 0) return undefined;
  const run = isRecord(raw.activeRun) ? raw.activeRun : undefined;
  return {
    schemaVersion: RESUME_VERSION,
    kind: RESUME_KIND,
    agentId: raw.agentId,
    ...(typeof raw.agentUrl === "string" ? { agentUrl: raw.agentUrl } : {}),
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(typeof run?.runId === "string" && typeof run.turnId === "string"
      ? { activeRun: { runId: run.runId, turnId: TurnId.make(run.turnId) } }
      : {}),
  };
}

interface CursorCloudSessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  /** The thread's chosen starting branch; the checkout decides when absent. */
  readonly branch: string | undefined;
  readonly api: CursorCloudApi;
  readonly lock: Semaphore.Semaphore;
  /** Owns run followers; closing it stops tracking without touching the cloud run. */
  readonly scope: Scope.Closeable;
  session: ProviderSession;
  agentId: string | undefined;
  agentUrl: string | undefined;
  /** The thread's selection at session start, used if the first turn does not repeat it. */
  readonly modelSelection: ModelSelection | undefined;
  activeRun: ActiveRun | undefined;
  readonly linkedPullRequests: Set<string>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  stopped: boolean;
}

function resumeCursorFor(ctx: CursorCloudSessionContext): ResumeCursor | undefined {
  if (ctx.agentId === undefined) return undefined;
  return {
    schemaVersion: RESUME_VERSION,
    kind: RESUME_KIND,
    agentId: ctx.agentId,
    ...(ctx.agentUrl ? { agentUrl: ctx.agentUrl } : {}),
    ...(ctx.session.model ? { model: ctx.session.model } : {}),
    ...(ctx.activeRun ? { activeRun: ctx.activeRun } : {}),
  };
}

const TOOL_ITEM_TYPES: ReadonlyArray<
  readonly [RegExp, "command_execution" | "file_change" | "web_search" | "mcp_tool_call"]
> = [
  [/terminal|shell|command/u, "command_execution"],
  [/edit|write|replace|delete|patch|create_file/u, "file_change"],
  [/web_search|search_web/u, "web_search"],
  [/^mcp/u, "mcp_tool_call"],
];

function toolItemType(name: string) {
  return TOOL_ITEM_TYPES.find(([pattern]) => pattern.test(name))?.[1] ?? "dynamic_tool_call";
}

const SUMMARY_ARG_KEYS = ["command", "path", "target_file", "file_path", "query", "pattern", "url"];

/** Keep only short identifying arguments; file bodies and patches stay out of the event log. */
function summarizeToolArgs(args: unknown): Record<string, string> {
  if (!isRecord(args)) return {};
  return Object.fromEntries(
    SUMMARY_ARG_KEYS.flatMap((key) => {
      const value = args[key];
      return typeof value === "string" && value.trim() ? [[key, value.trim().slice(0, 500)]] : [];
    }),
  );
}

/** The API takes every model parameter as a string, including booleans. */
function modelParams(
  options: ModelSelection["options"] | undefined,
): Array<{ id: string; value: string }> {
  return (Array.isArray(options) ? options : []).map((option) => ({
    id: option.id,
    value: String(option.value),
  }));
}

function humanizeToolName(name: string): string {
  const words = name.replace(/[_-]+/gu, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Tool";
}

function turnStateForRunStatus(status: string): "completed" | "cancelled" | "failed" {
  switch (status.toUpperCase()) {
    case "FINISHED":
      return "completed";
    case "CANCELLED":
      return "cancelled";
    default:
      return "failed";
  }
}

interface CursorCloudAdapterOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly instanceId: ProviderInstanceId;
}

export const makeCursorCloudAdapter = Effect.fn("makeCursorCloudAdapter")(function* (
  settings: Pick<CursorSettings, "cloudAutoCreatePR">,
  options: CursorCloudAdapterOptions,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig;
  const adapterScope = yield* Effect.scope;

  const sessions = new Map<ThreadId, CursorCloudSessionContext>();
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const randomId = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const stamp = Effect.all({ eventId: Effect.map(randomId, EventId.make), createdAt: nowIso });

  type RuntimeEventInput = ProviderRuntimeEvent extends infer Event
    ? Event extends ProviderRuntimeEvent
      ? Omit<Event, "eventId" | "createdAt" | "provider">
      : never
    : never;
  const emit = (event: RuntimeEventInput) =>
    Effect.flatMap(stamp, (base) =>
      PubSub.publish(events, { ...base, provider: PROVIDER, ...event } as ProviderRuntimeEvent),
    ).pipe(Effect.asVoid);

  const requestError = (method: string, cause: CursorCloudApiError) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail:
        cause.code === "agent_busy"
          ? "Cursor Cloud is still working on the previous message."
          : cause.message,
      cause,
    });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<CursorCloudSessionContext, ProviderAdapterSessionNotFoundError> => {
    const ctx = sessions.get(threadId);
    return ctx && !ctx.stopped
      ? Effect.succeed(ctx)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const touch = (ctx: CursorCloudSessionContext, patch: Partial<ProviderSession>) =>
    Effect.map(nowIso, (updatedAt) => {
      const { resumeCursor: _previous, ...rest } = ctx.session;
      ctx.session = { ...rest, ...patch, updatedAt };
      const resumeCursor = resumeCursorFor(ctx);
      if (resumeCursor) ctx.session = { ...ctx.session, resumeCursor };
    });

  const linkPullRequests = (ctx: CursorCloudSessionContext, turnId: TurnId, git: CursorCloudGit) =>
    Effect.forEach(
      git.branches.flatMap((branch) => (branch.prUrl ? [branch.prUrl] : [])),
      (pullRequestUrl) => {
        if (ctx.linkedPullRequests.has(pullRequestUrl)) return Effect.void;
        ctx.linkedPullRequests.add(pullRequestUrl);
        return emit({
          type: "thread.metadata.updated",
          threadId: ctx.threadId,
          turnId,
          payload: { pullRequestUrl },
        });
      },
      { discard: true },
    );

  const finishRun = Effect.fn("CursorCloudAdapter.finishRun")(function* (
    ctx: CursorCloudSessionContext,
    run: ActiveRun,
    outcome: RunOutcome & { readonly streamedReply: boolean },
  ) {
    if (outcome.text && !outcome.streamedReply) {
      yield* emit({
        type: "item.completed",
        threadId: ctx.threadId,
        turnId: run.turnId,
        itemId: RuntimeItemId.make(`${run.runId}:result`),
        payload: { itemType: "assistant_message", status: "completed", detail: outcome.text },
      });
    }
    if (outcome.git) yield* linkPullRequests(ctx, run.turnId, outcome.git);

    const state = turnStateForRunStatus(outcome.status);
    ctx.activeRun = undefined;
    ctx.turns.push({ id: run.turnId, items: [{ runId: run.runId, status: outcome.status }] });
    yield* touch(ctx, { status: "ready", activeTurnId: undefined });
    yield* emit({
      type: "turn.completed",
      threadId: ctx.threadId,
      turnId: run.turnId,
      payload: {
        state,
        stopReason: outcome.status.toLowerCase(),
        ...(state === "failed"
          ? {
              errorMessage: `${
                outcome.errorMessage ?? `Cursor Cloud run ended with status ${outcome.status}.`
              }${ctx.agentUrl ? ` Details: ${ctx.agentUrl}` : ""}`,
            }
          : {}),
      },
    });
  });

  /**
   * Follow one run to its end, reconnecting from the last event id after a
   * dropped connection. With `replayingHistory`, earlier output may already
   * be in the thread, so only the final result is reported.
   */
  const followRun = (
    ctx: CursorCloudSessionContext,
    agentId: string,
    run: ActiveRun,
    replayingHistory: boolean,
  ): Effect.Effect<void> => {
    let replaying = replayingHistory;
    let lastEventId: string | undefined;
    let assistantText = "";
    let assistantItem: RuntimeItemId | undefined;
    let assistantItemCount = 0;
    const startedTools = new Set<string>();
    let terminal: RunOutcome | undefined;

    const closeAssistantItem = Effect.suspend(() => {
      if (!assistantItem) return Effect.void;
      const itemId = assistantItem;
      assistantItem = undefined;
      return emit({
        type: "item.completed",
        threadId: ctx.threadId,
        turnId: run.turnId,
        itemId,
        payload: { itemType: "assistant_message", status: "completed" },
      });
    });

    const handle = (event: CursorCloudStreamEvent): Effect.Effect<void> => {
      if (event.type === "result") {
        terminal = {
          status: event.result.status,
          text: event.result.text ?? undefined,
          git: event.result.git ?? undefined,
        };
        return Effect.void;
      }
      if (replaying) return Effect.void;
      switch (event.type) {
        case "assistant":
          return Effect.gen(function* () {
            if (!assistantItem) {
              assistantText = "";
              assistantItemCount += 1;
              assistantItem = RuntimeItemId.make(`${run.runId}:assistant:${assistantItemCount}`);
              yield* emit({
                type: "item.started",
                threadId: ctx.threadId,
                turnId: run.turnId,
                itemId: assistantItem,
                payload: { itemType: "assistant_message", status: "inProgress" },
              });
            }
            assistantText += event.text;
            yield* emit({
              type: "content.delta",
              threadId: ctx.threadId,
              turnId: run.turnId,
              itemId: assistantItem,
              payload: { streamKind: "assistant_text", delta: event.text },
            });
          });
        case "thinking":
          return emit({
            type: "content.delta",
            threadId: ctx.threadId,
            turnId: run.turnId,
            payload: { streamKind: "reasoning_text", delta: event.text },
          });
        case "tool_call": {
          const completed = event.call.status === "completed";
          const started = startedTools.has(event.call.callId);
          startedTools.add(event.call.callId);
          const args = summarizeToolArgs(event.call.args);
          const detail =
            args.command ?? args.path ?? args.target_file ?? args.file_path ?? args.query;
          return closeAssistantItem.pipe(
            Effect.andThen(
              emit({
                type: completed ? "item.completed" : started ? "item.updated" : "item.started",
                threadId: ctx.threadId,
                turnId: run.turnId,
                itemId: RuntimeItemId.make(`${run.runId}:tool:${event.call.callId}`),
                payload: {
                  itemType: toolItemType(event.call.name),
                  status: completed ? "completed" : "inProgress",
                  title: humanizeToolName(event.call.name),
                  ...(detail ? { detail } : {}),
                  data: { toolName: event.call.name, toolCallId: event.call.callId, ...args },
                },
              }),
            ),
          );
        }
        case "error":
          return Effect.logWarning("Cursor Cloud run stream reported an error.", {
            runId: run.runId,
            code: event.code,
          });
        default:
          return Effect.void;
      }
    };

    const connect = () =>
      Stream.runForEach(ctx.api.streamRun(agentId, run.runId, lastEventId), (item) => {
        if (item.id !== undefined) lastEventId = item.id;
        return handle(item.event);
      }).pipe(
        Effect.catch((error: CursorCloudApiError) =>
          Effect.sync(() => {
            // An expired or rejected resume id cannot be retried. Start over
            // and report only the result, since earlier output was shown.
            if (error.status === 400 || error.status === 410) {
              lastEventId = undefined;
              replaying = true;
            }
          }),
        ),
      );

    const loop = (attempt: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const before = lastEventId;
        yield* connect();
        if (terminal) return;
        // The stream closed without a result. Ask the run directly before reconnecting.
        const current = yield* Effect.result(ctx.api.getRun(agentId, run.runId));
        if (Result.isSuccess(current) && isTerminalRunStatus(current.success.status)) {
          terminal = {
            status: current.success.status,
            text: current.success.result ?? undefined,
            git: current.success.git ?? undefined,
          };
          return;
        }
        if (Result.isFailure(current) && UNRECOVERABLE_STATUSES.has(current.failure.status ?? 0)) {
          terminal = {
            status: "ERROR",
            text: undefined,
            git: undefined,
            errorMessage: current.failure.message,
          };
          return;
        }
        const nextAttempt = lastEventId !== before ? 0 : attempt + 1;
        if (nextAttempt > 0) {
          yield* Effect.sleep(Math.min(1_000 * 2 ** (nextAttempt - 1), MAX_RECONNECT_DELAY_MS));
        }
        return yield* loop(nextAttempt);
      });

    return loop(0).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          if (!terminal) return;
          // A recovered result may extend the last partial message. Append only
          // its missing suffix before closing that item; never duplicate a reply.
          let streamedReply = terminal.text === assistantText;
          if (assistantItem && terminal.text?.startsWith(assistantText)) {
            const delta = terminal.text.slice(assistantText.length);
            if (delta) {
              yield* emit({
                type: "content.delta",
                threadId: ctx.threadId,
                turnId: run.turnId,
                itemId: assistantItem,
                payload: { streamKind: "assistant_text", delta },
              });
            }
            streamedReply = true;
          }
          yield* closeAssistantItem;
          yield* finishRun(ctx, run, { ...terminal, streamedReply });
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Cursor Cloud run follower failed.", { runId: run.runId, cause }),
      ),
    );
  };

  const startFollowing = (
    ctx: CursorCloudSessionContext,
    agentId: string,
    run: ActiveRun,
    replaying: boolean,
  ) => followRun(ctx, agentId, run, replaying).pipe(Effect.forkIn(ctx.scope), Effect.asVoid);

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }
      const cwd = input.cwd?.trim();
      if (!cwd) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Cursor Cloud needs the project's local checkout to find its GitHub repository.",
        });
      }
      const apiKey = resolveCursorCloudApiKey(options.environment);
      if (!apiKey) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: CURSOR_CLOUD_MISSING_KEY_MESSAGE,
        });
      }

      // Replacing a session continues the same thread, so it does not announce an exit.
      const existing = sessions.get(input.threadId);
      if (existing) yield* stopSessionInternal(existing, { announce: false });

      const resume = parseResumeCursor(input.resumeCursor);
      const model =
        resume?.model ??
        (input.modelSelection?.instanceId === options.instanceId
          ? input.modelSelection.model
          : undefined);
      const now = yield* nowIso;
      const ctx: CursorCloudSessionContext = {
        threadId: input.threadId,
        cwd,
        branch: input.branch,
        api: makeCursorCloudApi({ apiKey, httpClient }),
        lock: yield* Semaphore.make(1),
        scope: yield* Scope.fork(adapterScope, "sequential"),
        session: {
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          status: resume?.activeRun ? "running" : "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(model ? { model } : {}),
          threadId: input.threadId,
          ...(resume?.activeRun ? { activeTurnId: resume.activeRun.turnId } : {}),
          createdAt: now,
          updatedAt: now,
        },
        agentId: resume?.agentId,
        agentUrl: resume?.agentUrl,
        modelSelection:
          input.modelSelection?.instanceId === options.instanceId
            ? input.modelSelection
            : undefined,
        activeRun: resume?.activeRun,
        linkedPullRequests: new Set(),
        turns: [],
        stopped: false,
      };
      yield* touch(ctx, {});
      sessions.set(input.threadId, ctx);

      yield* emit({ type: "session.started", threadId: input.threadId, payload: {} });
      // Without a recorded run nothing is in flight, even if the thread last showed one.
      yield* emit({
        type: "session.state.changed",
        threadId: input.threadId,
        payload: { state: ctx.activeRun ? "running" : "ready" },
      });
      if (ctx.agentId) {
        yield* emit({
          type: "thread.started",
          threadId: input.threadId,
          payload: { providerThreadId: ctx.agentId },
        });
      }
      // A run recorded in the cursor has not been seen to finish; it may have
      // kept running, or finished, while this server was away.
      if (ctx.agentId && ctx.activeRun) {
        yield* startFollowing(ctx, ctx.agentId, ctx.activeRun, true);
      }
      return ctx.session;
    });

  const readPromptImages = (attachments: ReadonlyArray<ChatAttachment>) =>
    Effect.gen(function* () {
      const images: Array<{ data: string; mimeType: string }> = [];
      for (const attachment of attachments) {
        if (attachment.type !== "image") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue:
              "Cursor Cloud agents cannot read local files. Attach images, or paste the text into your message.",
          });
        }
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn",
                detail: cause.message,
                cause,
              }),
          ),
        );
        images.push({ data: Buffer.from(bytes).toString("base64"), mimeType: attachment.mimeType });
      }
      if (images.length > MAX_PROMPT_IMAGES) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Cursor Cloud accepts at most ${MAX_PROMPT_IMAGES} images per message.`,
        });
      }
      return images;
    });

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(input.threadId);
      return yield* ctx.lock.withPermit(
        Effect.gen(function* () {
          if (ctx.activeRun) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail:
                "Cursor Cloud is still working on the previous message. Wait for it to finish, or stop it first.",
            });
          }
          const images = yield* readPromptImages(input.attachments ?? []);
          const text = input.input?.trim() ?? "";
          if (!text && images.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }
          const prompt: CursorCloudPrompt = { text, ...(images.length > 0 ? { images } : {}) };
          const mode = input.interactionMode === "plan" ? "plan" : "agent";
          const turnId = TurnId.make(yield* randomId);

          let runId: string;
          let agentId = ctx.agentId;
          if (agentId === undefined) {
            const repository = yield* resolveCursorCloudRepository(
              ctx.cwd,
              ctx.branch,
              options.environment,
            ).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "sendTurn",
                    issue: cause.detail,
                    cause,
                  }),
              ),
            );
            const selection =
              input.modelSelection?.instanceId === options.instanceId
                ? input.modelSelection
                : ctx.modelSelection;
            const model = selection?.model ?? ctx.session.model;
            const params = modelParams(selection?.options);
            const created = yield* ctx.api
              .createAgent({
                prompt,
                ...(model && model !== CURSOR_CLOUD_DEFAULT_MODEL
                  ? { model: { id: model, ...(params.length > 0 ? { params } : {}) } }
                  : {}),
                repos: [{ url: repository.url, startingRef: repository.startingRef }],
                autoCreatePR: settings.cloudAutoCreatePR,
                mode,
              })
              .pipe(Effect.mapError((cause) => requestError("createAgent", cause)));
            agentId = created.agent.id;
            ctx.agentId = agentId;
            ctx.agentUrl = created.agent.url ?? undefined;
            runId = created.run.id;
            yield* touch(ctx, model ? { model } : {});
            yield* emit({
              type: "thread.started",
              threadId: ctx.threadId,
              payload: { providerThreadId: created.agent.id },
            });
            if (repository.hasUnpushedLocalWork) {
              yield* emit({
                type: "runtime.warning",
                threadId: ctx.threadId,
                turnId,
                payload: {
                  message: `Cursor Cloud started from ${repository.startingRef.slice(0, 40)} on GitHub. Local changes that are not pushed are not included.`,
                },
              });
            }
            if (ctx.session.runtimeMode !== "full-access") {
              yield* emit({
                type: "runtime.warning",
                threadId: ctx.threadId,
                turnId,
                payload: {
                  message:
                    "Cursor Cloud agents do not ask for approval. They run with full access inside their cloud VM.",
                },
              });
            }
          } else {
            const run = yield* ctx.api
              .createRun(agentId, { prompt, mode })
              .pipe(Effect.mapError((cause) => requestError("createRun", cause)));
            runId = run.id;
          }

          const run: ActiveRun = { runId, turnId };
          ctx.activeRun = run;
          yield* touch(ctx, { status: "running", activeTurnId: turnId });
          yield* emit({
            type: "turn.started",
            threadId: ctx.threadId,
            turnId,
            payload:
              ctx.session.model && ctx.session.model !== CURSOR_CLOUD_DEFAULT_MODEL
                ? { model: ctx.session.model }
                : {},
          });
          const resumeCursor = ctx.session.resumeCursor;
          yield* startFollowing(ctx, agentId, run, false);
          return {
            threadId: ctx.threadId,
            turnId,
            ...(resumeCursor !== undefined ? { resumeCursor } : {}),
          } satisfies ProviderTurnStartResult;
        }),
      );
    });

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      if (!ctx.agentId || !ctx.activeRun) return;
      // The follower reports the CANCELLED result as the turn's end.
      yield* ctx.api
        .cancelRun(ctx.agentId, ctx.activeRun.runId)
        .pipe(
          Effect.catch((cause) =>
            cause.code === "run_not_cancellable"
              ? Effect.void
              : Effect.fail(requestError("cancelRun", cause)),
          ),
        );
    });

  const unsupported = (method: string, detail: string) =>
    Effect.fail(new ProviderAdapterRequestError({ provider: PROVIDER, method, detail }));

  function stopSessionInternal(
    ctx: CursorCloudSessionContext,
    options?: { readonly announce?: boolean },
  ) {
    return Effect.gen(function* () {
      if (ctx.stopped) return;
      ctx.stopped = true;
      sessions.delete(ctx.threadId);
      yield* Scope.close(ctx.scope, Exit.void);
      if (options?.announce !== false) {
        yield* emit({
          type: "session.exited",
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      }
    });
  }

  // Shutdown and instance rebuilds stop tracking only. The cloud run keeps
  // going, and the thread must stay running so recovery can reattach.
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.values()], (ctx) => stopSessionInternal(ctx, { announce: false }), {
      discard: true,
    }).pipe(Effect.andThen(PubSub.shutdown(events))),
  );

  return {
    provider: PROVIDER,
    // The router reports the instance's capabilities; these describe the agent itself.
    capabilities: { sessionModelSwitch: "unsupported", supportsConversationRollback: false },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest: () =>
      unsupported("respondToRequest", "Cursor Cloud agents do not ask for approval."),
    respondToUserInput: () =>
      unsupported("respondToUserInput", "Cursor Cloud agents do not ask questions."),
    stopSession: (threadId) =>
      requireSession(threadId).pipe(Effect.flatMap((ctx) => stopSessionInternal(ctx))),
    listSessions: () =>
      Effect.sync(() => [...sessions.values()].map((ctx) => ({ ...ctx.session }))),
    hasSession: (threadId) => Effect.sync(() => sessions.get(threadId)?.stopped === false),
    readThread: (threadId) =>
      requireSession(threadId).pipe(Effect.map((ctx) => ({ threadId, turns: ctx.turns }))),
    rollbackThread: () =>
      unsupported("rollbackThread", "Cursor Cloud agents cannot roll back their conversation."),
    stopAll: () =>
      Effect.forEach([...sessions.values()], (ctx) => stopSessionInternal(ctx), { discard: true }),
    streamEvents: Stream.fromPubSub(events),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});

type Adapter = ProviderAdapterShape<ProviderAdapterError>;

/**
 * One Cursor instance runs each thread either through the local CLI or as a
 * cloud agent. A thread whose execution target is `cloud`, or whose resume
 * cursor is a cloud cursor, goes to the cloud adapter for its whole life.
 */
export function routeCursorExecution(local: Adapter, cloud: Adapter): Adapter {
  const adapterFor = (threadId: ThreadId) =>
    Effect.map(cloud.hasSession(threadId), (isCloud) => (isCloud ? cloud : local));
  const route =
    <Args extends ReadonlyArray<unknown>, A>(
      use: (
        adapter: Adapter,
      ) => (threadId: ThreadId, ...args: Args) => Effect.Effect<A, ProviderAdapterError>,
    ) =>
    (threadId: ThreadId, ...args: Args) =>
      Effect.flatMap(adapterFor(threadId), (adapter) => use(adapter)(threadId, ...args));
  const compactionCommand =
    local.compaction?.type === "slash-command" ? local.compaction.command : undefined;

  return {
    provider: local.provider,
    capabilities: local.capabilities,
    ...(local.compaction ? { compaction: local.compaction } : {}),
    startSession: (input) =>
      parseResumeCursor(input.resumeCursor) !== undefined || input.executionTarget === "cloud"
        ? cloud.startSession(input)
        : local.startSession(input),
    sendTurn: (input) =>
      Effect.flatMap(adapterFor(input.threadId), (adapter) =>
        adapter === cloud &&
        compactionCommand !== undefined &&
        input.input?.trim() === compactionCommand
          ? Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn",
                detail: "Cloud agents manage their own context and cannot be compacted.",
              }),
            )
          : adapter.sendTurn(input),
      ),
    interruptTurn: route((adapter) => adapter.interruptTurn),
    respondToRequest: route((adapter) => adapter.respondToRequest),
    respondToUserInput: route((adapter) => adapter.respondToUserInput),
    stopSession: route((adapter) => adapter.stopSession),
    readThread: route((adapter) => adapter.readThread),
    rollbackThread: route((adapter) => adapter.rollbackThread),
    listSessions: () =>
      Effect.map(Effect.all([local.listSessions(), cloud.listSessions()]), (sessions) =>
        sessions.flat(),
      ),
    hasSession: (threadId) =>
      Effect.map(
        Effect.all([local.hasSession(threadId), cloud.hasSession(threadId)]),
        ([onLocal, onCloud]) => onLocal || onCloud,
      ),
    stopAll: () => Effect.all([local.stopAll(), cloud.stopAll()], { discard: true }),
    streamEvents: Stream.merge(local.streamEvents, cloud.streamEvents),
  };
}
