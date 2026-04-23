/**
 * GeminiAdapterLive - Scoped live implementation for the Gemini provider adapter.
 *
 * Wraps Gemini CLI ACP sessions behind the generic provider adapter contract
 * and emits canonical provider runtime events.
 *
 * @module GeminiAdapterLive
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ApprovalRequestId,
  type CanonicalItemType,
  EventId,
  type GeminiThinkingBudget,
  type GeminiThinkingLevel,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";
import {
  geminiCapabilitiesForModel,
  getGeminiThinkingConfigKind,
  getGeminiThinkingModelAlias,
  hasEffortLevel,
  resolveApiModelId,
} from "@t3tools/shared/model";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Queue,
  Scope,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  type AcpParsedSessionEvent,
  type AcpPermissionRequest,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { makeGeminiAcpRuntime } from "../acp/GeminiAcpSupport.ts";
import { resolveGeminiBinaryPath } from "../geminiBinaryPath.ts";
import { GeminiAdapter, type GeminiAdapterShape } from "../Services/GeminiAdapter.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { asArray, asNumber, asRecord, trimToUndefined } from "../jsonValue.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "gemini" as const;
const GEMINI_TMP_DIR = path.join(os.homedir(), ".gemini", "tmp");
const GEMINI_CHAT_DIR_NAME = "chats";
const GEMINI_SESSION_FILE_PREFIX = "session-";
const T3CODE_GEMINI_SETTINGS_DIR = path.join(os.tmpdir(), "t3code", "gemini");
const GEMINI_3_THINKING_LEVELS: ReadonlyArray<GeminiThinkingLevel> = ["HIGH", "LOW"];
const GEMINI_2_5_THINKING_BUDGETS: ReadonlyArray<GeminiThinkingBudget> = [-1, 512, 0];

interface GeminiPendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface GeminiRecordedItem {
  id: string;
  itemType: CanonicalItemType;
  title?: string;
  detail?: string;
  status?: "inProgress" | "completed" | "failed";
  text?: string;
  data?: unknown;
}

interface GeminiTurnState {
  readonly turnId: TurnId;
  reasoningItemId: RuntimeItemId | undefined;
  readonly items: GeminiRecordedItem[];
  reasoningTextStarted: boolean;
}

interface GeminiStoredTurn {
  readonly id: TurnId;
  readonly items: Array<unknown>;
  readonly snapshotSessionId?: string;
  readonly snapshotFilePath?: string;
}

interface GeminiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, GeminiPendingApproval>;
  readonly turns: GeminiStoredTurn[];
  readonly runtimeModeId: string;
  readonly sessionId: string;
  currentModeId: string | undefined;
  currentModelId: string | undefined;
  turnState: GeminiTurnState | undefined;
  sessionFilePath: string | undefined;
  systemSettingsPath: string | undefined;
  stopped: boolean;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  cumulativePromptUsage: GeminiPromptUsageSnapshot | undefined;
}

export interface GeminiAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export interface GeminiPromptUsageSnapshot {
  readonly usedTokens: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

function toSpawnEnv(
  env: NodeJS.ProcessEnv | Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!env) {
    return undefined;
  }
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function buildGeminiThinkingModelConfigAliases(
  modelIds: ReadonlyArray<string>,
): Record<string, Record<string, unknown>> {
  const aliases: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();

  for (const modelId of modelIds) {
    const model = modelId.trim();
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    const caps = geminiCapabilitiesForModel(model);

    switch (getGeminiThinkingConfigKind(model)) {
      case "level": {
        for (const thinkingLevel of GEMINI_3_THINKING_LEVELS) {
          if (!hasEffortLevel(caps, thinkingLevel)) {
            continue;
          }
          const alias = getGeminiThinkingModelAlias(model, { thinkingLevel });
          if (!alias) {
            continue;
          }
          aliases[alias] = {
            extends: "chat-base-3",
            modelConfig: {
              model,
              generateContentConfig: {
                thinkingConfig: {
                  thinkingLevel,
                },
              },
            },
          };
        }
        break;
      }
      case "budget": {
        for (const thinkingBudget of GEMINI_2_5_THINKING_BUDGETS) {
          if (!hasEffortLevel(caps, String(thinkingBudget))) {
            continue;
          }
          const alias = getGeminiThinkingModelAlias(model, { thinkingBudget });
          if (!alias) {
            continue;
          }
          aliases[alias] = {
            extends: "chat-base-2.5",
            modelConfig: {
              model,
              generateContentConfig: {
                thinkingConfig: {
                  thinkingBudget,
                },
              },
            },
          };
        }
        break;
      }
      default:
        break;
    }
  }

  return aliases;
}

function readResumeSessionId(resumeCursor: unknown): string | undefined {
  const record = asRecord(resumeCursor);
  return trimToUndefined(record?.sessionId);
}

function cloneUnknownArray(items: ReadonlyArray<unknown>): Array<unknown> {
  return items.map((item) => {
    const record = asRecord(item);
    return record ? Object.assign({}, record) : item;
  });
}

function cloneStoredTurn(turn: GeminiStoredTurn): GeminiStoredTurn {
  return {
    id: turn.id,
    items: cloneUnknownArray(turn.items),
    ...(turn.snapshotSessionId ? { snapshotSessionId: turn.snapshotSessionId } : {}),
    ...(turn.snapshotFilePath ? { snapshotFilePath: turn.snapshotFilePath } : {}),
  };
}

function readResumeTurns(resumeCursor: unknown): Array<GeminiStoredTurn> {
  const record = asRecord(resumeCursor);
  return (
    asArray(record?.snapshots)?.reduce<Array<GeminiStoredTurn>>((acc, entry) => {
      const snapshot = asRecord(entry);
      const turnId = trimToUndefined(snapshot?.turnId);
      const sessionId = trimToUndefined(snapshot?.sessionId);
      const items = asArray(snapshot?.items);
      if (!turnId || !sessionId || !items) {
        return acc;
      }
      const filePath = trimToUndefined(snapshot?.filePath);
      const storedTurn = {
        id: TurnId.make(turnId),
        items: cloneUnknownArray(items),
        snapshotSessionId: sessionId,
      };
      acc.push(
        filePath
          ? (Object.assign(storedTurn, {
              snapshotFilePath: filePath,
            }) satisfies GeminiStoredTurn)
          : (storedTurn satisfies GeminiStoredTurn),
      );
      return acc;
    }, []) ?? []
  );
}

function buildResumeCursor(context: GeminiSessionContext) {
  const snapshots = context.turns
    .filter((turn) => turn.snapshotSessionId)
    .map((turn) => {
      const snapshot = {
        turnId: turn.id,
        sessionId: turn.snapshotSessionId as string,
        items: cloneUnknownArray(turn.items),
      };
      return turn.snapshotFilePath
        ? Object.assign(snapshot, { filePath: turn.snapshotFilePath })
        : snapshot;
    });

  return {
    sessionId: context.sessionId,
    ...(snapshots.length > 0 ? { snapshots } : {}),
  };
}

function isStoredGeminiSession(value: unknown): value is Record<string, unknown> & {
  sessionId: string;
  messages: Array<unknown>;
  startTime: string;
  lastUpdated: string;
} {
  const record = asRecord(value);
  return Boolean(
    trimToUndefined(record?.sessionId) &&
    asArray(record?.messages) &&
    trimToUndefined(record?.startTime) &&
    trimToUndefined(record?.lastUpdated),
  );
}

function makeGeminiSessionFileName(sessionId: string): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return `${GEMINI_SESSION_FILE_PREFIX}${timestamp}-${sessionId.slice(0, 8)}.json`;
}

async function readStoredGeminiSession(filePath: string) {
  const content = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!isStoredGeminiSession(content)) {
    throw new Error(`Invalid Gemini session file: ${filePath}`);
  }
  return content;
}

async function findGeminiSessionFileById(
  sessionId: string,
  hintedPath?: string,
): Promise<string | undefined> {
  const prefix = sessionId.slice(0, 8);
  const candidatePaths = new Set<string>();
  if (hintedPath) {
    candidatePaths.add(hintedPath);
  }

  let projectDirs: Array<string> = [];
  try {
    projectDirs = (await fs.readdir(GEMINI_TMP_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(GEMINI_TMP_DIR, entry.name, GEMINI_CHAT_DIR_NAME));
  } catch {
    return undefined;
  }

  for (const chatsDir of projectDirs) {
    try {
      const files = await fs.readdir(chatsDir, { withFileTypes: true });
      for (const entry of files) {
        if (
          entry.isFile() &&
          entry.name.startsWith(GEMINI_SESSION_FILE_PREFIX) &&
          entry.name.endsWith(".json") &&
          entry.name.includes(prefix)
        ) {
          candidatePaths.add(path.join(chatsDir, entry.name));
        }
      }
    } catch {
      // Ignore project temp dirs without chats.
    }
  }

  for (const candidatePath of candidatePaths) {
    try {
      const storedSession = await readStoredGeminiSession(candidatePath);
      if (storedSession.sessionId === sessionId) {
        return candidatePath;
      }
    } catch {
      // Ignore unreadable or unrelated files.
    }
  }

  return undefined;
}

async function cloneGeminiSessionFile(sourcePath: string, sessionId: string): Promise<string> {
  const storedSession = await readStoredGeminiSession(sourcePath);
  const nextSession = {
    ...storedSession,
    sessionId,
    lastUpdated: new Date().toISOString(),
  };
  const destinationPath = path.join(path.dirname(sourcePath), makeGeminiSessionFileName(sessionId));
  await fs.writeFile(destinationPath, `${JSON.stringify(nextSession, null, 2)}\n`, "utf8");
  return destinationPath;
}

function runtimeModeToGeminiModeId(runtimeMode: ProviderSession["runtimeMode"]): string {
  switch (runtimeMode) {
    case "approval-required":
      return "default";
    case "auto-accept-edits":
      return "auto_edit";
    case "full-access":
    default:
      return "yolo";
  }
}

function itemTypeFromAcpToolKind(kind: string | undefined): CanonicalItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
    case "fetch":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

function runtimeStatusFromAcpToolStatus(
  status: "pending" | "inProgress" | "completed" | "failed" | undefined,
): "inProgress" | "completed" | "failed" | undefined {
  switch (status) {
    case "pending":
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

function isAskUserPermissionRequest(request: AcpPermissionRequest): boolean {
  return request.toolCall?.title?.trim().toLowerCase() === "ask user";
}

function permissionOutcomeFromGeminiOptions(
  decision: ProviderApprovalDecision,
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): { outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } } {
  if (decision === "cancel") {
    return { outcome: { outcome: "cancelled" } };
  }

  const pick = (...kinds: ReadonlyArray<EffectAcpSchema.PermissionOptionKind>) =>
    kinds
      .map((kind) => options.find((option) => option.kind === kind))
      .find((option) => option !== undefined);

  const selected =
    decision === "acceptForSession"
      ? pick("allow_always", "allow_once")
      : decision === "accept"
        ? pick("allow_once", "allow_always")
        : pick("reject_once", "reject_always");

  const optionId =
    typeof selected?.optionId === "string" && selected.optionId.trim().length > 0
      ? selected.optionId.trim()
      : undefined;
  return optionId
    ? {
        outcome: {
          outcome: "selected",
          optionId,
        },
      }
    : { outcome: { outcome: "cancelled" } };
}

function cleanupGeminiSystemSettings(systemSettingsPath: string | undefined): void {
  if (!systemSettingsPath) {
    return;
  }
  void fs.unlink(systemSettingsPath).catch(() => {
    // Ignore already deleted temporary settings files.
  });
}

function sumTokenUsageValue(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}

/** @internal - Exported for testing */
export function normalizeGeminiPromptUsage(value: unknown): GeminiPromptUsageSnapshot | undefined {
  const usage = asRecord(value);
  const usedTokens = asNumber(usage?.totalTokens);
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const inputTokens = asNumber(usage?.inputTokens);
  const outputTokens = asNumber(usage?.outputTokens);
  const thoughtTokens = asNumber(usage?.thoughtTokens);
  const cachedReadTokens = asNumber(usage?.cachedReadTokens);
  const cachedWriteTokens = asNumber(usage?.cachedWriteTokens);
  const cachedInputTokens =
    (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0) > 0
      ? (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0)
      : undefined;

  return {
    usedTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(thoughtTokens !== undefined ? { reasoningOutputTokens: thoughtTokens } : {}),
  };
}

/** @internal - Exported for testing */
export function accumulateGeminiPromptUsage(
  cumulativeUsage: GeminiPromptUsageSnapshot | undefined,
  turnUsage: GeminiPromptUsageSnapshot,
): GeminiPromptUsageSnapshot {
  const inputTokens = sumTokenUsageValue(cumulativeUsage?.inputTokens, turnUsage.inputTokens);
  const cachedInputTokens = sumTokenUsageValue(
    cumulativeUsage?.cachedInputTokens,
    turnUsage.cachedInputTokens,
  );
  const outputTokens = sumTokenUsageValue(cumulativeUsage?.outputTokens, turnUsage.outputTokens);
  const reasoningOutputTokens = sumTokenUsageValue(
    cumulativeUsage?.reasoningOutputTokens,
    turnUsage.reasoningOutputTokens,
  );

  return {
    usedTokens: (cumulativeUsage?.usedTokens ?? 0) + turnUsage.usedTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
}

/** @internal - Exported for testing */
export function buildGeminiPromptUsageSnapshot(
  lastKnownUsage: ThreadTokenUsageSnapshot | undefined,
  cumulativeUsage: GeminiPromptUsageSnapshot,
  turnUsage: GeminiPromptUsageSnapshot,
): ThreadTokenUsageSnapshot {
  const keepContextWindowUsage =
    typeof lastKnownUsage?.maxTokens === "number" &&
    Number.isFinite(lastKnownUsage.maxTokens) &&
    lastKnownUsage.maxTokens > 0;
  const usedTokens = keepContextWindowUsage
    ? lastKnownUsage.usedTokens
    : cumulativeUsage.usedTokens;

  return {
    usedTokens,
    totalProcessedTokens: cumulativeUsage.usedTokens,
    ...(keepContextWindowUsage ? { maxTokens: lastKnownUsage.maxTokens } : {}),
    ...(cumulativeUsage.inputTokens !== undefined
      ? { inputTokens: cumulativeUsage.inputTokens }
      : {}),
    ...(cumulativeUsage.cachedInputTokens !== undefined
      ? { cachedInputTokens: cumulativeUsage.cachedInputTokens }
      : {}),
    ...(cumulativeUsage.outputTokens !== undefined
      ? { outputTokens: cumulativeUsage.outputTokens }
      : {}),
    ...(cumulativeUsage.reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens: cumulativeUsage.reasoningOutputTokens }
      : {}),
    lastUsedTokens: turnUsage.usedTokens,
    ...(turnUsage.inputTokens !== undefined ? { lastInputTokens: turnUsage.inputTokens } : {}),
    ...(turnUsage.cachedInputTokens !== undefined
      ? { lastCachedInputTokens: turnUsage.cachedInputTokens }
      : {}),
    ...(turnUsage.outputTokens !== undefined ? { lastOutputTokens: turnUsage.outputTokens } : {}),
    ...(turnUsage.reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: turnUsage.reasoningOutputTokens }
      : {}),
  };
}

function updateGeminiSession(
  context: GeminiSessionContext,
  patch: Partial<ProviderSession>,
): ProviderSession {
  context.session = {
    ...context.session,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  return context.session;
}

function upsertGeminiTurnItem(
  turnState: GeminiTurnState,
  itemId: string,
  itemType: CanonicalItemType,
  patch: Partial<GeminiRecordedItem>,
): GeminiRecordedItem {
  let item = turnState.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    item = { id: itemId, itemType };
    turnState.items.push(item);
  }
  item.itemType = itemType;
  Object.assign(item, patch);
  return item;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, GeminiPendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function makeGeminiAdapter(options?: GeminiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const providerRegistry = yield* ProviderRegistry;
    const runtimeContext = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(runtimeContext);
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, GeminiSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());

    const makeEventStamp = () => ({
      eventId: EventId.make(crypto.randomUUID()),
      createdAt: new Date().toISOString(),
    });

    const makeEventBase = (context: GeminiSessionContext) => ({
      ...makeEventStamp(),
      provider: PROVIDER,
      threadId: context.threadId,
    });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEventQueue, event);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const getGeminiSettings = Effect.fn("getGeminiSettings")(function* (threadId: ThreadId) {
      return yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.gemini),
        Effect.mapError(
          (error) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: error.message,
              cause: error,
            }),
        ),
      );
    });

    const prepareGeminiLaunchConfig = Effect.fn("prepareGeminiLaunchConfig")(function* (input: {
      readonly threadId: ThreadId;
      readonly selectedModel?: string;
    }) {
      const providers = yield* providerRegistry.getProviders;
      const providerModels =
        providers
          .find((provider) => provider.provider === PROVIDER)
          ?.models.map((model) => model.slug) ?? [];
      const candidateModels = [
        ...providerModels,
        ...(input.selectedModel ? [input.selectedModel] : []),
      ].filter((model, index, collection) => collection.indexOf(model) === index);
      const aliases = buildGeminiThinkingModelConfigAliases(candidateModels);

      if (Object.keys(aliases).length === 0) {
        return {
          env: undefined,
          systemSettingsPath: undefined,
        };
      }

      const systemSettingsPath = path.join(
        T3CODE_GEMINI_SETTINGS_DIR,
        `${input.threadId}-${crypto.randomUUID()}.json`,
      );
      yield* Effect.tryPromise({
        try: async () => {
          await fs.mkdir(T3CODE_GEMINI_SETTINGS_DIR, { recursive: true });
          await fs.writeFile(
            systemSettingsPath,
            JSON.stringify(
              {
                modelConfigs: {
                  aliases,
                },
              },
              null,
              2,
            ),
            "utf8",
          );
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: `Failed to prepare Gemini thinking settings: ${toMessage(cause, "write failed")}`,
            cause,
          }),
      });

      return {
        systemSettingsPath,
        env: {
          ...process.env,
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettingsPath,
        },
      };
    });

    const snapshotThread = (context: GeminiSessionContext) => ({
      threadId: context.threadId,
      turns: context.turns.map((turn) => ({
        id: turn.id,
        items: cloneUnknownArray(turn.items),
      })),
    });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<GeminiSessionContext, ProviderAdapterError> => {
      const context = sessions.get(threadId);
      if (!context) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      if (context.stopped) {
        return Effect.fail(new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId }));
      }
      return Effect.succeed(context);
    };

    const emitSessionState = (
      context: GeminiSessionContext,
      state: "starting" | "ready" | "running" | "stopped" | "error",
      reason?: string,
      detail?: unknown,
    ) =>
      offerRuntimeEvent({
        ...makeEventBase(context),
        type: "session.state.changed",
        payload: {
          state,
          ...(reason ? { reason } : {}),
          ...(detail !== undefined ? { detail } : {}),
        },
        ...(detail !== undefined
          ? {
              raw: {
                source: "acp.jsonrpc" as const,
                method: "session/state",
                payload: detail,
              },
            }
          : {}),
      });

    const emitRuntimeWarning = (
      context: GeminiSessionContext,
      message: string,
      raw?: {
        readonly method: string;
        readonly payload: unknown;
      },
    ) =>
      offerRuntimeEvent({
        ...makeEventBase(context),
        ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
        type: "runtime.warning",
        payload: { message, ...(raw ? { detail: raw.payload } : {}) },
        ...(raw
          ? {
              raw: {
                source: "acp.jsonrpc" as const,
                method: raw.method,
                payload: raw.payload,
              },
            }
          : {}),
      });

    const emitRuntimeError = (
      context: GeminiSessionContext,
      message: string,
      detail?: unknown,
      turnId?: TurnId,
    ) =>
      offerRuntimeEvent({
        ...makeEventBase(context),
        ...(turnId ? { turnId } : {}),
        type: "runtime.error",
        payload: {
          message,
          class: "provider_error",
          ...(detail !== undefined ? { detail } : {}),
        },
        ...(detail !== undefined
          ? {
              raw: {
                source: "acp.jsonrpc" as const,
                method: "runtime/error",
                payload: detail,
              },
            }
          : {}),
      });

    const emitUsage = (
      context: GeminiSessionContext,
      usage: ThreadTokenUsageSnapshot,
      turnId?: TurnId,
      rawPayload?: unknown,
    ) => {
      context.lastKnownTokenUsage = {
        ...context.lastKnownTokenUsage,
        ...usage,
        usedTokens: usage.usedTokens,
      };
      return offerRuntimeEvent({
        ...makeEventBase(context),
        ...(turnId ? { turnId } : {}),
        type: "thread.token-usage.updated",
        payload: { usage: context.lastKnownTokenUsage },
        ...(rawPayload !== undefined
          ? {
              raw: {
                source: "acp.jsonrpc" as const,
                method: "session/update",
                payload: rawPayload,
              },
            }
          : {}),
      });
    };

    const emitReasoningItemStarted = (context: GeminiSessionContext) =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState || turnState.reasoningTextStarted) {
          return;
        }
        const itemId = RuntimeItemId.make(`gemini-reasoning-${crypto.randomUUID()}`);
        turnState.reasoningItemId = itemId;
        turnState.reasoningTextStarted = true;
        upsertGeminiTurnItem(turnState, itemId, "reasoning", {
          status: "inProgress",
          title: "Reasoning",
        });
        yield* offerRuntimeEvent({
          ...makeEventBase(context),
          turnId: turnState.turnId,
          itemId,
          type: "item.started",
          payload: {
            itemType: "reasoning",
            status: "inProgress",
            title: "Reasoning",
          },
        });
      });

    const emitContentDelta = (
      context: GeminiSessionContext,
      event: Extract<AcpParsedSessionEvent, { readonly _tag: "ContentDelta" }>,
    ) =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState || event.text.length === 0) {
          return;
        }

        let activeTurnState = turnState;
        let itemId = event.itemId;
        if (event.streamKind === "reasoning_text") {
          yield* emitReasoningItemStarted(context);
          const nextTurnState = context.turnState;
          if (!nextTurnState || nextTurnState.turnId !== turnState.turnId) {
            return;
          }
          activeTurnState = nextTurnState;
          itemId = activeTurnState.reasoningItemId;
        }
        if (!itemId) {
          return;
        }

        const itemType =
          event.streamKind === "assistant_text" ? "assistant_message" : ("reasoning" as const);
        const existing = upsertGeminiTurnItem(activeTurnState, itemId, itemType, {});
        existing.text = `${existing.text ?? ""}${event.text}`;

        yield* offerRuntimeEvent(
          makeAcpContentDeltaEvent({
            stamp: makeEventStamp(),
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: activeTurnState.turnId,
            streamKind: event.streamKind,
            itemId,
            text: event.text,
            rawPayload: event.rawPayload,
          }),
        );
      });

    const handleAcpEvent = (context: GeminiSessionContext, event: AcpParsedSessionEvent) =>
      Effect.gen(function* () {
        switch (event._tag) {
          case "ModeChanged":
            context.currentModeId = event.modeId;
            return;
          case "AssistantItemStarted": {
            if (!context.turnState) {
              return;
            }
            upsertGeminiTurnItem(context.turnState, event.itemId, "assistant_message", {
              status: "inProgress",
              title: "Assistant message",
            });
            yield* offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp: makeEventStamp(),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId: context.turnState.turnId,
                itemId: event.itemId,
                lifecycle: "item.started",
              }),
            );
            return;
          }
          case "AssistantItemCompleted": {
            if (!context.turnState) {
              return;
            }
            upsertGeminiTurnItem(context.turnState, event.itemId, "assistant_message", {
              status: "completed",
            });
            yield* offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp: makeEventStamp(),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId: context.turnState.turnId,
                itemId: event.itemId,
                lifecycle: "item.completed",
              }),
            );
            return;
          }
          case "PlanUpdated":
            yield* offerRuntimeEvent(
              makeAcpPlanUpdatedEvent({
                stamp: makeEventStamp(),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId: context.turnState?.turnId,
                payload: event.payload,
                source: "acp.jsonrpc",
                method: "session/update",
                rawPayload: event.rawPayload,
              }),
            );
            return;
          case "ToolCallUpdated": {
            if (!context.turnState) {
              return;
            }
            const runtimeStatus = runtimeStatusFromAcpToolStatus(event.toolCall.status);
            const itemPatch: Partial<GeminiRecordedItem> = {
              data: event.toolCall.data,
            };
            if (event.toolCall.title) {
              itemPatch.title = event.toolCall.title;
            }
            if (event.toolCall.detail) {
              itemPatch.detail = event.toolCall.detail;
            }
            if (runtimeStatus) {
              itemPatch.status = runtimeStatus;
            }
            upsertGeminiTurnItem(
              context.turnState,
              event.toolCall.toolCallId,
              itemTypeFromAcpToolKind(event.toolCall.kind),
              itemPatch,
            );
            yield* offerRuntimeEvent(
              makeAcpToolCallEvent({
                stamp: makeEventStamp(),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId: context.turnState.turnId,
                toolCall: event.toolCall,
                rawPayload: event.rawPayload,
              }),
            );
            return;
          }
          case "ContentDelta":
            yield* emitContentDelta(context, event);
            return;
          case "UsageUpdated":
            yield* emitUsage(
              context,
              {
                usedTokens: event.usage.usedTokens,
                lastUsedTokens: event.usage.usedTokens,
                ...(event.usage.maxTokens !== undefined
                  ? { maxTokens: event.usage.maxTokens }
                  : {}),
                compactsAutomatically: true,
              },
              context.turnState?.turnId,
              event.rawPayload,
            );
            return;
          case "ThreadMetadataUpdated":
            yield* offerRuntimeEvent({
              ...makeEventBase(context),
              ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
              type: "thread.metadata.updated",
              payload: {
                name: event.name,
                ...(event.metadata ? { metadata: event.metadata } : {}),
              },
              raw: {
                source: "acp.jsonrpc",
                method: "session/update",
                payload: event.rawPayload,
              },
            });
            return;
        }
      });

    const resolveSessionFilePath = Effect.fn("resolveSessionFilePath")(function* (
      context: GeminiSessionContext,
      options?: { readonly retries?: number },
    ) {
      const retries = options?.retries ?? 0;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const resolvedPath = yield* Effect.tryPromise({
          try: () => findGeminiSessionFileById(context.sessionId, context.sessionFilePath),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: context.threadId,
              detail: `Failed to locate Gemini session file: ${toMessage(cause, "lookup failed")}`,
              cause,
            }),
        });
        if (resolvedPath) {
          context.sessionFilePath = resolvedPath;
          return resolvedPath;
        }
        if (attempt < retries) {
          yield* Effect.sleep(100);
        }
      }
      return undefined;
    });

    const persistTurnSnapshot = Effect.fn("persistTurnSnapshot")(function* (
      context: GeminiSessionContext,
      turnId: TurnId,
      items: ReadonlyArray<unknown>,
    ) {
      const storedTurnBase: GeminiStoredTurn = {
        id: turnId,
        items: cloneUnknownArray(items),
      };
      const liveSessionFilePath = yield* resolveSessionFilePath(context, { retries: 5 });
      if (!liveSessionFilePath) {
        return storedTurnBase;
      }

      const snapshotSessionId = crypto.randomUUID();
      const snapshotFilePath = yield* Effect.tryPromise({
        try: () => cloneGeminiSessionFile(liveSessionFilePath, snapshotSessionId),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: context.threadId,
            detail: `Failed to snapshot Gemini session history: ${toMessage(cause, "snapshot failed")}`,
            cause,
          }),
      });

      return {
        ...storedTurnBase,
        snapshotSessionId,
        snapshotFilePath,
      } satisfies GeminiStoredTurn;
    });

    const finishTurn = (
      context: GeminiSessionContext,
      result: {
        readonly state: "completed" | "failed" | "cancelled" | "interrupted";
        readonly stopReason?: string | null;
        readonly usage?: unknown;
        readonly errorMessage?: string;
      },
    ) =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return;
        }

        for (const item of turnState.items) {
          if (item.itemType !== "assistant_message" || item.status !== "inProgress") {
            continue;
          }
          item.status = result.state === "failed" ? "failed" : "completed";
          yield* offerRuntimeEvent({
            ...makeEventBase(context),
            turnId: turnState.turnId,
            itemId: RuntimeItemId.make(item.id),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: item.status,
              ...(item.title ? { title: item.title } : {}),
            },
          });
        }

        if (turnState.reasoningItemId && turnState.reasoningTextStarted) {
          upsertGeminiTurnItem(turnState, turnState.reasoningItemId, "reasoning", {
            status: result.state === "failed" ? "failed" : "completed",
          });
          yield* offerRuntimeEvent({
            ...makeEventBase(context),
            turnId: turnState.turnId,
            itemId: turnState.reasoningItemId,
            type: "item.completed",
            payload: {
              itemType: "reasoning",
              status: result.state === "failed" ? "failed" : "completed",
              title: "Reasoning",
            },
          });
        }

        const normalizedUsage = normalizeGeminiPromptUsage(result.usage);
        if (normalizedUsage) {
          context.cumulativePromptUsage = accumulateGeminiPromptUsage(
            context.cumulativePromptUsage,
            normalizedUsage,
          );
          yield* emitUsage(
            context,
            buildGeminiPromptUsageSnapshot(
              context.lastKnownTokenUsage,
              context.cumulativePromptUsage,
              normalizedUsage,
            ),
            turnState.turnId,
            result.usage,
          );
        }

        yield* offerRuntimeEvent({
          ...makeEventBase(context),
          turnId: turnState.turnId,
          type: "turn.completed",
          payload: {
            state: result.state,
            ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
            ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
          },
        });

        const storedTurn = yield* persistTurnSnapshot(
          context,
          turnState.turnId,
          turnState.items,
        ).pipe(
          Effect.catch((error) =>
            emitRuntimeWarning(context, error.message, {
              method: "session/snapshot",
              payload: {
                message: error.message,
              },
            }).pipe(
              Effect.as({
                id: turnState.turnId,
                items: cloneUnknownArray(turnState.items),
              } satisfies GeminiStoredTurn),
            ),
          ),
        );

        context.turns.push(storedTurn);
        context.turnState = undefined;
        updateGeminiSession(context, {
          status: "ready",
          activeTurnId: undefined,
          resumeCursor: buildResumeCursor(context),
          lastError: result.state === "failed" ? result.errorMessage : undefined,
        });
        yield* emitSessionState(context, "ready");
      });

    const stopSessionInternal = (
      context: GeminiSessionContext,
      options?: {
        readonly emitExitEvent?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        if (context.stopped) {
          return;
        }
        context.stopped = true;
        yield* settlePendingApprovalsAsCancelled(context.pendingApprovals);
        if (context.notificationFiber) {
          yield* Fiber.interrupt(context.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(context.scope, Exit.void));
        cleanupGeminiSystemSettings(context.systemSettingsPath);
        context.systemSettingsPath = undefined;
        updateGeminiSession(context, {
          status: "closed",
          activeTurnId: undefined,
        });
        if (sessions.get(context.threadId) === context) {
          sessions.delete(context.threadId);
        }
        if (options?.emitExitEvent === false) {
          return;
        }
        yield* offerRuntimeEvent({
          ...makeEventBase(context),
          type: "session.exited",
          payload: {
            exitKind: "graceful",
          },
        });
      });

    const setGeminiMode = (context: GeminiSessionContext, modeId: string) =>
      Effect.gen(function* () {
        if (!modeId || context.currentModeId === modeId) {
          return;
        }
        yield* context.acp
          .request("session/set_mode", {
            sessionId: context.sessionId,
            modeId,
          })
          .pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, context.threadId, "session/set_mode", cause),
            ),
          );
        context.currentModeId = modeId;
      });

    const setGeminiModel = (
      context: GeminiSessionContext,
      input: {
        readonly model: string;
        readonly acpModelId: string;
      },
    ) =>
      Effect.gen(function* () {
        if (!input.acpModelId || context.currentModelId === input.acpModelId) {
          if (context.session.model !== input.model) {
            updateGeminiSession(context, { model: input.model });
          }
          return;
        }
        yield* context.acp
          .request("session/set_model", {
            sessionId: context.sessionId,
            modelId: input.acpModelId,
          })
          .pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, context.threadId, "session/set_model", cause),
            ),
          );
        context.currentModelId = input.acpModelId;
        updateGeminiSession(context, { model: input.model });
      });

    const buildPromptBlocks = Effect.fn("buildPromptBlocks")(function* (
      input: ProviderSendTurnInput,
    ) {
      const blocks: Array<EffectAcpSchema.ContentBlock> = [];

      if (trimToUndefined(input.input)) {
        blocks.push({
          type: "text",
          text: trimToUndefined(input.input) as string,
        });
      }

      for (const attachment of input.attachments ?? []) {
        if (attachment.type !== "image") {
          continue;
        }
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: cause.message,
                cause,
              }),
          ),
        );
        blocks.push({
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: attachment.mimeType,
        });
      }

      return blocks;
    });

    const runPromptTurn = (
      context: GeminiSessionContext,
      turnId: TurnId,
      prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>,
    ) =>
      Effect.gen(function* () {
        const promptResult = yield* Effect.result(
          context.acp
            .prompt({ prompt })
            .pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, context.threadId, "session/prompt", cause),
              ),
            ),
        );
        if (promptResult._tag === "Failure") {
          const error = promptResult.failure;
          const message = toMessage(error, "Gemini turn failed.");
          yield* emitRuntimeError(context, message, error, turnId);
          yield* finishTurn(context, {
            state: "failed",
            errorMessage: message,
          });
          return;
        }

        const response = promptResult.success;
        const responseRecord = asRecord(response);
        const stopReason =
          typeof responseRecord?.stopReason === "string" ? responseRecord.stopReason : null;
        yield* finishTurn(context, {
          state: stopReason === "cancelled" ? "cancelled" : "completed",
          stopReason,
          usage: responseRecord?.usage,
        });
      });

    const createGeminiSessionContext = (input: {
      readonly threadId: ThreadId;
      readonly runtimeMode: ProviderSession["runtimeMode"];
      readonly runtimeModeId: string;
      readonly cwd: string;
      readonly binaryPath: string;
      readonly env?: NodeJS.ProcessEnv | Readonly<Record<string, string>>;
      readonly turns?: ReadonlyArray<GeminiStoredTurn>;
      readonly resumeSessionId?: string;
      readonly allowResumeFallback?: boolean;
      readonly selectedModel?: string;
      readonly selectedApiModelId?: string;
      readonly sessionFilePath?: string;
      readonly systemSettingsPath?: string;
    }) =>
      Effect.gen(function* () {
        const pendingApprovals = new Map<ApprovalRequestId, GeminiPendingApproval>();
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred
            ? Effect.void
            : Scope.close(sessionScope, Exit.void).pipe(
                Effect.tap(() =>
                  Effect.sync(() => cleanupGeminiSystemSettings(input.systemSettingsPath)),
                ),
                Effect.ignore,
              ),
        );

        let context!: GeminiSessionContext;
        const spawnEnv = toSpawnEnv(input.env);
        const acp = yield* makeGeminiAcpRuntime({
          childProcessSpawner,
          binaryPath: input.binaryPath,
          cwd: input.cwd,
          ...(spawnEnv ? { env: spawnEnv } : {}),
          ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
          ...(input.allowResumeFallback !== undefined
            ? { allowResumeFallback: input.allowResumeFallback }
            : {}),
          clientInfo: { name: "t3-code", version: "0.0.0" },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            auth: { terminal: false },
          },
          ...makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          }),
        }).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );

        yield* acp.handleRequestPermission((params) =>
          Effect.gen(function* () {
            const permissionRequest = parsePermissionRequest(params);
            const approvalRequestId = ApprovalRequestId.make(
              `gemini-approval-${crypto.randomUUID()}`,
            );
            const runtimeRequestId = RuntimeRequestId.make(approvalRequestId);
            const decision = yield* Deferred.make<ProviderApprovalDecision>();
            pendingApprovals.set(approvalRequestId, { decision });
            const detail = isAskUserPermissionRequest(permissionRequest)
              ? "Gemini CLI requested user input, but Gemini ACP did not include the question payload. Accepting this request will continue with an empty answer set."
              : (permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000));

            yield* offerRuntimeEvent(
              makeAcpRequestOpenedEvent({
                stamp: makeEventStamp(),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: context?.turnState?.turnId,
                requestId: runtimeRequestId,
                permissionRequest,
                detail,
                args: {
                  ...(permissionRequest.toolCall ? { toolCall: permissionRequest.toolCall } : {}),
                  options: params.options,
                },
                source: "acp.jsonrpc",
                method: "session/request_permission",
                rawPayload: params,
              }),
            );

            const resolved = yield* Deferred.await(decision);
            pendingApprovals.delete(approvalRequestId);

            yield* offerRuntimeEvent(
              makeAcpRequestResolvedEvent({
                stamp: makeEventStamp(),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: context?.turnState?.turnId,
                requestId: runtimeRequestId,
                permissionRequest,
                decision: resolved,
              }),
            );

            return permissionOutcomeFromGeminiOptions(resolved, params.options);
          }),
        );

        const started = yield* acp.start().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );

        const now = new Date().toISOString();
        const sessionSetupRecord = asRecord(started.sessionSetupResult);
        context = {
          threadId: input.threadId,
          session: {
            provider: PROVIDER,
            status: "connecting",
            runtimeMode: input.runtimeMode,
            cwd: input.cwd,
            threadId: input.threadId,
            createdAt: now,
            updatedAt: now,
          },
          scope: sessionScope,
          acp,
          notificationFiber: undefined,
          pendingApprovals,
          turns: (input.turns ?? []).map(cloneStoredTurn),
          runtimeModeId: input.runtimeModeId,
          sessionId: started.sessionId,
          currentModeId: trimToUndefined(asRecord(sessionSetupRecord?.modes)?.currentModeId),
          currentModelId: trimToUndefined(asRecord(sessionSetupRecord?.models)?.currentModelId),
          turnState: undefined,
          sessionFilePath: input.sessionFilePath,
          systemSettingsPath: input.systemSettingsPath,
          stopped: false,
          lastKnownTokenUsage: undefined,
          cumulativePromptUsage: undefined,
        };

        context.notificationFiber = yield* Stream.runDrain(
          Stream.mapEffect(acp.getEvents(), (event) => handleAcpEvent(context, event)),
        ).pipe(Effect.forkChild);

        yield* setGeminiMode(context, input.runtimeModeId);
        if (input.selectedModel) {
          yield* setGeminiModel(context, {
            model: input.selectedModel,
            acpModelId: input.selectedApiModelId ?? input.selectedModel,
          });
        }

        updateGeminiSession(context, {
          status: "ready",
          ...(input.selectedModel
            ? { model: input.selectedModel }
            : context.currentModelId
              ? { model: context.currentModelId }
              : {}),
          resumeCursor: buildResumeCursor(context),
        });

        sessionScopeTransferred = true;
        return context;
      });

    const startSession: GeminiAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }

          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing, { emitExitEvent: false });
          }

          const geminiSettings = yield* getGeminiSettings(input.threadId);
          const binaryPath = resolveGeminiBinaryPath(geminiSettings.binaryPath);
          const cwd = path.resolve(input.cwd ?? process.cwd());
          const runtimeModeId = runtimeModeToGeminiModeId(input.runtimeMode);
          const selectedGeminiModel =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;
          const selectedApiModelId =
            input.modelSelection?.provider === PROVIDER
              ? resolveApiModelId(input.modelSelection)
              : undefined;
          const requestedResumeSessionId = readResumeSessionId(input.resumeCursor);
          const resumeTurns = readResumeTurns(input.resumeCursor);
          const launchConfig = yield* prepareGeminiLaunchConfig({
            threadId: input.threadId,
            ...(selectedGeminiModel ? { selectedModel: selectedGeminiModel } : {}),
          });

          const context = yield* createGeminiSessionContext({
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            runtimeModeId,
            cwd,
            binaryPath,
            ...(launchConfig.env ? { env: launchConfig.env } : {}),
            turns: resumeTurns,
            ...(requestedResumeSessionId ? { resumeSessionId: requestedResumeSessionId } : {}),
            allowResumeFallback: true,
            ...(selectedGeminiModel ? { selectedModel: selectedGeminiModel } : {}),
            ...(selectedApiModelId ? { selectedApiModelId } : {}),
            ...(launchConfig.systemSettingsPath
              ? { systemSettingsPath: launchConfig.systemSettingsPath }
              : {}),
          });

          sessions.set(input.threadId, context);

          yield* offerRuntimeEvent({
            ...makeEventBase(context),
            type: "session.started",
            payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
          });
          yield* offerRuntimeEvent({
            ...makeEventBase(context),
            type: "session.configured",
            payload: {
              config: {
                cwd,
                modeId: context.currentModeId ?? runtimeModeId,
                ...(context.session.model ? { model: context.session.model } : {}),
              },
            },
          });
          yield* emitSessionState(context, "ready");
          yield* offerRuntimeEvent({
            ...makeEventBase(context),
            type: "thread.started",
            payload: {
              providerThreadId: context.sessionId,
            },
          });

          return context.session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: GeminiAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(input.threadId);
          if (context.turnState) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "A Gemini turn is already in progress for this thread.",
            });
          }

          if (input.modelSelection?.provider === PROVIDER) {
            yield* setGeminiModel(context, {
              model: input.modelSelection.model,
              acpModelId: resolveApiModelId(input.modelSelection),
            });
          }

          yield* setGeminiMode(
            context,
            input.interactionMode === "plan" ? "plan" : context.runtimeModeId,
          );

          const prompt = yield* buildPromptBlocks(input);
          if (prompt.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Either input text or at least one attachment is required.",
            });
          }

          const turnId = TurnId.make(crypto.randomUUID());
          context.turnState = {
            turnId,
            reasoningItemId: undefined,
            items: [],
            reasoningTextStarted: false,
          };
          updateGeminiSession(context, {
            status: "running",
            activeTurnId: turnId,
            lastError: undefined,
          });

          yield* emitSessionState(context, "running");
          yield* offerRuntimeEvent({
            ...makeEventBase(context),
            turnId,
            type: "turn.started",
            payload: context.session.model ? { model: context.session.model } : {},
          });

          runFork(runPromptTurn(context, turnId, prompt));

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: buildResumeCursor(context),
          };
        }),
      );

    const interruptTurn: GeminiAdapterShape["interruptTurn"] = (threadId, turnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          if (turnId && context.turnState && context.turnState.turnId !== turnId) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "interruptTurn",
              issue: `Turn '${turnId}' is not active for thread '${threadId}'.`,
            });
          }
          if (!context.turnState) {
            return;
          }
          yield* settlePendingApprovalsAsCancelled(context.pendingApprovals);
          yield* context.acp.cancel.pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", cause),
            ),
          );
        }),
      );

    const respondToRequest: GeminiAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          const pending = context.pendingApprovals.get(requestId);
          if (!pending) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "respondToRequest",
              issue: `Unknown Gemini approval request '${requestId}'.`,
            });
          }
          yield* Deferred.succeed(pending.decision, decision);
        }),
      );

    const respondToUserInput: GeminiAdapterShape["respondToUserInput"] = (
      _threadId,
      _requestId,
      _answers,
    ) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue:
            "Gemini ACP does not expose structured user-input answers. Gemini Ask User requests can only be approved or declined.",
        }),
      );

    const stopSession: GeminiAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          yield* stopSessionInternal(context);
        }),
      );

    const listSessions: GeminiAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        Array.from(sessions.values())
          .filter((context) => !context.stopped)
          .map((context) => Object.assign({}, context.session)),
      );

    const hasSession: GeminiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      });

    const readThread: GeminiAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        return snapshotThread(context);
      });

    const rollbackThread: GeminiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          if (!Number.isInteger(numTurns) || numTurns < 1) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "numTurns must be an integer >= 1.",
            });
          }
          if (context.turnState) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "Cannot roll back a Gemini thread while a turn is in progress.",
            });
          }

          const nextLength = Math.max(0, context.turns.length - numTurns);
          const nextTurns = context.turns.slice(0, nextLength).map(cloneStoredTurn);
          const cwd = context.session.cwd ?? process.cwd();
          const geminiSettings = yield* getGeminiSettings(threadId);

          let resumeSessionId: string | undefined;
          let sessionFilePath: string | undefined;
          if (nextLength > 0) {
            const targetTurn = nextTurns[nextLength - 1];
            if (!targetTurn?.snapshotSessionId) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "rollbackThread",
                issue: "Gemini session snapshot is unavailable for the requested rollback target.",
              });
            }
            const targetSnapshotSessionId = targetTurn.snapshotSessionId;

            const sourceSnapshotPath = yield* Effect.tryPromise({
              try: () =>
                findGeminiSessionFileById(targetSnapshotSessionId, targetTurn.snapshotFilePath),
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId,
                  detail: `Failed to locate Gemini rollback snapshot: ${toMessage(cause, "lookup failed")}`,
                  cause,
                }),
            });
            if (!sourceSnapshotPath) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "rollbackThread",
                issue: "Gemini rollback snapshot file could not be found.",
              });
            }

            resumeSessionId = crypto.randomUUID();
            sessionFilePath = yield* Effect.tryPromise({
              try: () => cloneGeminiSessionFile(sourceSnapshotPath, resumeSessionId as string),
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId,
                  detail: `Failed to restore Gemini rollback snapshot: ${toMessage(cause, "restore failed")}`,
                  cause,
                }),
            });
          }

          const launchConfig = yield* prepareGeminiLaunchConfig({
            threadId,
            ...(context.session.model ? { selectedModel: context.session.model } : {}),
          });
          const binaryPath = resolveGeminiBinaryPath(geminiSettings.binaryPath);

          const nextContext = yield* createGeminiSessionContext({
            threadId,
            runtimeMode: context.session.runtimeMode,
            runtimeModeId: context.runtimeModeId,
            cwd,
            binaryPath,
            ...(launchConfig.env ? { env: launchConfig.env } : {}),
            turns: nextTurns,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            allowResumeFallback: false,
            ...(context.session.model ? { selectedModel: context.session.model } : {}),
            ...(context.currentModelId ? { selectedApiModelId: context.currentModelId } : {}),
            ...(sessionFilePath ? { sessionFilePath } : {}),
            ...(launchConfig.systemSettingsPath
              ? { systemSettingsPath: launchConfig.systemSettingsPath }
              : {}),
          });

          yield* stopSessionInternal(context, { emitExitEvent: false });
          sessions.set(threadId, nextContext);

          return snapshotThread(nextContext);
        }).pipe(Effect.scoped),
      );

    const stopAll: GeminiAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), (context) => stopSessionInternal(context), {
        discard: true,
      }).pipe(Effect.asVoid);

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), (context) => stopSessionInternal(context), {
        discard: true,
      }).pipe(
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
        Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEventQueue);
      },
    } satisfies GeminiAdapterShape;
  });
}

export const GeminiAdapterLive = Layer.effect(GeminiAdapter, makeGeminiAdapter());

export function makeGeminiAdapterLive(options?: GeminiAdapterLiveOptions) {
  return Layer.effect(GeminiAdapter, makeGeminiAdapter(options));
}
