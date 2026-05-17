import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import type * as AcpConnection from "./AcpConnection.ts";
import {
  collectSessionConfigOptionValues,
  extractModelConfigId,
  findSessionConfigOption,
  mergeToolCallState,
  parseSessionModeState,
  parseSessionUpdateEvent,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./AcpRuntimeModel.ts";

function formatConfigOptionValue(value: string | boolean): string {
  return JSON.stringify(value);
}

interface AssistantSegmentState {
  readonly nextSegmentIndex: number;
  readonly activeItemId?: string;
}

interface EnsureActiveAssistantSegmentResult {
  readonly itemId: string;
  readonly startedEvent?: Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>;
}

export interface AcpMultiSessionStartResult {
  readonly sessionId: string;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
}

/** Per-session handlers contributed by the adapter (file IO, permissions). */
export interface AcpMultiSessionUserHandlers {
  readonly onRequestPermission?: AcpConnection.AcpConnectionSessionHandlers["onRequestPermission"];
  readonly onElicitation?: AcpConnection.AcpConnectionSessionHandlers["onElicitation"];
  readonly onReadTextFile?: AcpConnection.AcpConnectionSessionHandlers["onReadTextFile"];
  readonly onWriteTextFile?: AcpConnection.AcpConnectionSessionHandlers["onWriteTextFile"];
}

export interface AcpMultiSessionOptions {
  readonly connection: AcpConnection.AcpConnection["Service"];
  readonly cwd: string;
  readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly resumeSessionId?: string;
  readonly handlers: AcpMultiSessionUserHandlers;
}

export interface AcpMultiSessionShape {
  readonly sessionId: string;
  readonly setupResult: AcpMultiSessionStartResult;
  readonly getEvents: () => Stream.Stream<AcpParsedSessionEvent, never>;
  readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
  readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
  readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly setMode: (
    modeId: string,
  ) => Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError>;
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
  readonly prompt: (
    payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
  ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  readonly cancel: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

export const makeAcpMultiSession = (
  options: AcpMultiSessionOptions,
): Effect.Effect<AcpMultiSessionShape, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    const eventQueue = yield* Queue.unbounded<AcpParsedSessionEvent>();
    const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
    const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallState>());
    const assistantSegmentRef = yield* Ref.make<AssistantSegmentState>({ nextSegmentIndex: 0 });
    const configOptionsRef = yield* Ref.make<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>(
      [],
    );

    const onSessionUpdate: AcpConnection.AcpConnectionSessionHandlers["onSessionUpdate"] = (
      notification,
    ) =>
      Effect.gen(function* () {
        const parsed = parseSessionUpdateEvent(notification);
        if (parsed.modeId) {
          yield* Ref.update(modeStateRef, (current) =>
            current === undefined ? current : updateModeState(current, parsed.modeId!),
          );
        }
        for (const event of parsed.events) {
          if (event._tag === "ToolCallUpdated") {
            yield* closeActiveAssistantSegment();
            const { previous, merged } = yield* Ref.modify(toolCallsRef, (current) => {
              const previous = current.get(event.toolCall.toolCallId);
              const nextToolCall = mergeToolCallState(previous, event.toolCall);
              const next = new Map(current);
              if (nextToolCall.status === "completed" || nextToolCall.status === "failed") {
                next.delete(nextToolCall.toolCallId);
              } else {
                next.set(nextToolCall.toolCallId, nextToolCall);
              }
              return [{ previous, merged: nextToolCall }, next] as const;
            });
            if (!shouldEmitToolCallUpdate(previous, merged)) {
              continue;
            }
            yield* Queue.offer(eventQueue, {
              _tag: "ToolCallUpdated",
              toolCall: merged,
              rawPayload: event.rawPayload,
            });
            continue;
          }
          if (event._tag === "ContentDelta") {
            if (event.text.trim().length === 0) {
              const seg = yield* Ref.get(assistantSegmentRef);
              if (!seg.activeItemId) {
                continue;
              }
            }
            const itemId = yield* ensureActiveAssistantSegment(notification.sessionId);
            yield* Queue.offer(eventQueue, { ...event, itemId });
            continue;
          }
          yield* Queue.offer(eventQueue, event);
        }
      });

    const ensureActiveAssistantSegment = (sessionId: string) =>
      Ref.modify<AssistantSegmentState, EnsureActiveAssistantSegmentResult>(
        assistantSegmentRef,
        (current) => {
          if (current.activeItemId) {
            return [{ itemId: current.activeItemId }, current] as const;
          }
          const itemId = `assistant:${sessionId}:segment:${current.nextSegmentIndex}`;
          return [
            {
              itemId,
              startedEvent: {
                _tag: "AssistantItemStarted",
                itemId,
              },
            },
            {
              nextSegmentIndex: current.nextSegmentIndex + 1,
              activeItemId: itemId,
            },
          ] as const;
        },
      ).pipe(
        Effect.flatMap((result) =>
          result.startedEvent
            ? Queue.offer(eventQueue, result.startedEvent).pipe(Effect.as(result.itemId))
            : Effect.succeed(result.itemId),
        ),
      );

    const closeActiveAssistantSegment = () =>
      Ref.modify(assistantSegmentRef, (current) => {
        if (!current.activeItemId) {
          return [undefined, current] as const;
        }
        return [
          {
            _tag: "AssistantItemCompleted",
            itemId: current.activeItemId,
          } satisfies AcpParsedSessionEvent,
          { nextSegmentIndex: current.nextSegmentIndex } satisfies AssistantSegmentState,
        ] as const;
      }).pipe(Effect.flatMap((event) => (event ? Queue.offer(eventQueue, event) : Effect.void)));

    const session = yield* options.connection.newSession({
      cwd: options.cwd,
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
      ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
      handlers: {
        onSessionUpdate,
        ...(options.handlers.onRequestPermission
          ? { onRequestPermission: options.handlers.onRequestPermission }
          : {}),
        ...(options.handlers.onElicitation
          ? { onElicitation: options.handlers.onElicitation }
          : {}),
        ...(options.handlers.onReadTextFile
          ? { onReadTextFile: options.handlers.onReadTextFile }
          : {}),
        ...(options.handlers.onWriteTextFile
          ? { onWriteTextFile: options.handlers.onWriteTextFile }
          : {}),
      },
    });

    yield* Ref.set(modeStateRef, parseSessionModeState(session.sessionSetupResult));
    yield* Ref.set(configOptionsRef, session.sessionSetupResult.configOptions ?? []);

    const setupResult: AcpMultiSessionStartResult = {
      sessionId: session.sessionId,
      sessionSetupResult: session.sessionSetupResult,
      modelConfigId: extractModelConfigId(session.sessionSetupResult),
    };

    const validateConfigOptionValue = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<void, EffectAcpErrors.AcpError> =>
      Effect.gen(function* () {
        const configOption = findSessionConfigOption(yield* Ref.get(configOptionsRef), configId);
        if (!configOption) return;
        if (configOption.type === "boolean") {
          if (typeof value === "boolean") return;
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected boolean`,
            data: { configId: configOption.id, expectedType: "boolean", receivedValue: value },
          });
        }
        if (typeof value !== "string") {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected string`,
            data: { configId: configOption.id, expectedType: "string", receivedValue: value },
          });
        }
        const allowedValues = collectSessionConfigOptionValues(configOption);
        if (allowedValues.includes(value)) return;
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected one of ${allowedValues.join(", ")}`,
          data: { configId: configOption.id, allowedValues, receivedValue: value },
        });
      });

    const setConfigOption = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
      validateConfigOptionValue(configId, value).pipe(
        Effect.flatMap(() => Ref.get(configOptionsRef)),
        Effect.flatMap((configOptions) => {
          const existing = findSessionConfigOption(configOptions, configId);
          if (existing && configOptionCurrentValueMatches(existing, value)) {
            return Effect.succeed({
              configOptions,
            } satisfies EffectAcpSchema.SetSessionConfigOptionResponse);
          }
          const payload =
            typeof value === "boolean"
              ? ({
                  sessionId: setupResult.sessionId,
                  configId,
                  type: "boolean",
                  value,
                } satisfies EffectAcpSchema.SetSessionConfigOptionRequest)
              : ({
                  sessionId: setupResult.sessionId,
                  configId,
                  value: String(value),
                } satisfies EffectAcpSchema.SetSessionConfigOptionRequest);
          return options.connection
            .setSessionConfigOption(payload)
            .pipe(
              Effect.tap((response) =>
                Ref.set(configOptionsRef, response.configOptions ?? configOptions),
              ),
            );
        }),
      );

    const updateCurrentModeId = (modeId: string) =>
      Ref.update(modeStateRef, (current) =>
        current ? { ...current, currentModeId: modeId } : current,
      );

    return {
      sessionId: setupResult.sessionId,
      setupResult,
      getEvents: () => Stream.fromQueue(eventQueue),
      getConfigOptions: Ref.get(configOptionsRef),
      getModeState: Ref.get(modeStateRef),
      setModel: (model) =>
        setConfigOption(setupResult.modelConfigId ?? "model", model).pipe(Effect.asVoid),
      setMode: (modeId) =>
        Ref.get(modeStateRef).pipe(
          Effect.flatMap((modeState) => {
            if (modeState?.currentModeId === modeId) {
              return Effect.succeed({} satisfies EffectAcpSchema.SetSessionModeResponse);
            }
            return setConfigOption("mode", modeId).pipe(
              Effect.tap(() => updateCurrentModeId(modeId)),
              Effect.as({} satisfies EffectAcpSchema.SetSessionModeResponse),
            );
          }),
        ),
      setConfigOption,
      prompt: (payload) =>
        closeActiveAssistantSegment().pipe(
          Effect.andThen(
            options.connection.prompt({
              sessionId: setupResult.sessionId,
              ...payload,
            } satisfies EffectAcpSchema.PromptRequest),
          ),
          Effect.tap(() => closeActiveAssistantSegment()),
        ),
      cancel: options.connection.cancel({ sessionId: setupResult.sessionId }),
    } satisfies AcpMultiSessionShape;
  });

function updateModeState(modeState: AcpSessionModeState, nextModeId: string): AcpSessionModeState {
  const normalized = nextModeId.trim();
  if (!normalized) return modeState;
  return modeState.availableModes.some((mode) => mode.id === normalized)
    ? { ...modeState, currentModeId: normalized }
    : modeState;
}

function shouldEmitToolCallUpdate(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
): boolean {
  if (next.status === "completed" || next.status === "failed") return true;
  if (!next.detail) return false;
  return (
    previous === undefined ||
    previous.title !== next.title ||
    previous.detail !== next.detail ||
    previous.status !== next.status
  );
}

function configOptionCurrentValueMatches(
  configOption: EffectAcpSchema.SessionConfigOption,
  value: string | boolean,
): boolean {
  const currentValue = configOption.currentValue;
  if (configOption.type === "boolean") return currentValue === value;
  if (typeof currentValue !== "string") return false;
  return currentValue.trim() === String(value).trim();
}
