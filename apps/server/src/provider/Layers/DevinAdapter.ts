import {
  ApprovalRequestId,
  type ChatAttachment,
  type DevinSettings,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as NodeURL from "node:url";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { expandHomePath } from "../../pathExpansion.ts";

import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  type AcpParsedSessionEvent,
  type AcpPermissionRequest,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import {
  applyDevinAcpModelSelection,
  buildDevinModelsFromSessionModelState,
  currentDevinModelIdFromSessionSetup,
  DEVIN_DEFAULT_MODEL_SLUG_PUBLIC,
  makeDevinAcpRuntime,
  resolveDevinAcpBaseModelId,
  resolveDevinAcpMode,
} from "../acp/DevinAcpSupport.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { type DevinAdapterShape } from "../Services/DevinAdapter.ts";

const PROVIDER = ProviderDriverKind.make("devin");
const DEVIN_PROMPT_TIMEOUT_MS = 600_000;

interface DevinPendingApproval {
  readonly request: EffectAcpSchema.RequestPermissionRequest;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly turnId: TurnId | undefined;
  readonly runtimeRequestId: RuntimeRequestId;
  readonly permissionRequest: AcpPermissionRequest;
  readonly detail: string;
}

interface DevinPendingUserInput {
  readonly request: EffectAcpSchema.ElicitationRequest;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
  readonly turnId: TurnId | undefined;
  readonly runtimeRequestId: RuntimeRequestId;
}

interface DevinSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly acpSessionId: string;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  currentModelId: string | undefined;
  protocolMap: Map<string, string>;
  activeItemId: string | undefined;
  activeTurnId: TurnId | undefined;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  stopped: boolean;
  pendingApprovals: Map<ApprovalRequestId, DevinPendingApproval>;
  pendingUserInputs: Map<ApprovalRequestId, DevinPendingUserInput>;
}

export interface DevinAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
  readonly attachmentsDir?: string;
}

export function makeDevinAdapter(devinSettings: DevinSettings, options?: DevinAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("devin");
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;

    const sessions = new Map<ThreadId, DevinSessionContext>();
    const pendingApprovalsByRequestId = new Map<
      ApprovalRequestId,
      DevinPendingApproval & { readonly threadId: ThreadId }
    >();
    const pendingUserInputsByRequestId = new Map<
      ApprovalRequestId,
      DevinPendingUserInput & { readonly threadId: ThreadId }
    >();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Devin runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Devin ACP callback.",
              cause,
            }),
        ),
      );

    const selectDevinAutoPermissionOptionId = (
      request: EffectAcpSchema.RequestPermissionRequest,
    ): string | undefined => {
      const allowAlways = request.options.find((option) => option.kind === "allow_always");
      if (allowAlways?.optionId.trim()) {
        return allowAlways.optionId.trim();
      }
      const allowOnce = request.options.find((option) => option.kind === "allow_once");
      return allowOnce?.optionId.trim() ?? request.options[0]?.optionId.trim();
    };

    const selectDevinPermissionOptionId = (
      request: EffectAcpSchema.RequestPermissionRequest,
      decision: ProviderApprovalDecision,
    ): string | undefined => {
      switch (decision) {
        case "acceptAlways":
          return request.options.find((option) => option.kind === "allow_always")?.optionId;
        case "acceptForSession":
        case "accept":
          return (
            request.options.find((option) => option.kind === "allow_once")?.optionId ??
            request.options.find((option) => option.kind === "allow_always")?.optionId
          );
        case "decline":
          return (
            request.options.find((option) => option.kind === "reject_once")?.optionId ??
            request.options.find((option) => option.kind === "reject_always")?.optionId
          );
        case "cancel":
          return undefined;
      }
    };

    const elicitQuestionsFromRequest = (
      request: Extract<EffectAcpSchema.ElicitationRequest, { readonly mode: "form" }>,
    ): Array<UserInputQuestion> => {
      const properties = request.requestedSchema.properties ?? {};
      return Object.entries(properties).map(([id, property]) => {
        const options: Array<{ readonly label: string; readonly description: string }> = [];
        if ("enum" in property && Array.isArray(property.enum)) {
          for (const value of property.enum) {
            const label = String(value);
            options.push({ label, description: label });
          }
        } else if ("oneOf" in property && Array.isArray(property.oneOf)) {
          for (const option of property.oneOf) {
            options.push({ label: option.title, description: option.title });
          }
        } else if (property.type === "boolean") {
          options.push({ label: "Yes", description: "Yes" }, { label: "No", description: "No" });
        }
        const header = property.title?.trim() || id;
        const question = property.description?.trim() || header;
        return {
          id,
          header,
          question,
          options,
          multiSelect: property.type === "array",
        } satisfies UserInputQuestion;
      });
    };

    const buildAutoElicitationContent = (
      request: Extract<EffectAcpSchema.ElicitationRequest, { readonly mode: "form" }>,
    ): Record<string, EffectAcpSchema.ElicitationContentValue> => {
      const properties = request.requestedSchema.properties ?? {};
      const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};
      for (const [id, property] of Object.entries(properties)) {
        if ("default" in property && property.default !== undefined && property.default !== null) {
          content[id] = property.default as EffectAcpSchema.ElicitationContentValue;
          continue;
        }
        switch (property.type) {
          case "string": {
            if ("enum" in property && Array.isArray(property.enum) && property.enum.length > 0) {
              content[id] = property.enum[0]!;
            } else if (
              "oneOf" in property &&
              Array.isArray(property.oneOf) &&
              property.oneOf.length > 0
            ) {
              content[id] = property.oneOf[0]!.const;
            } else {
              content[id] = "";
            }
            break;
          }
          case "integer":
          case "number": {
            content[id] = 0;
            break;
          }
          case "boolean": {
            content[id] = false;
            break;
          }
          case "array": {
            if ("default" in property && Array.isArray(property.default)) {
              content[id] = property.default as ReadonlyArray<string>;
            } else {
              content[id] = [];
            }
            break;
          }
          default:
            content[id] = "";
        }
      }
      return content;
    };

    const contentBlockForAttachment = (attachment: ChatAttachment) =>
      Effect.gen(function* () {
        const attachmentsDir = options?.attachmentsDir;
        if (attachmentsDir === undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "attachmentsDir is not configured; cannot send attachments.",
          });
        }
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        switch (attachment.type) {
          case "image": {
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
            return {
              type: "image" as const,
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            } satisfies EffectAcpSchema.ContentBlock;
          }
          case "file":
            return {
              type: "resource_link" as const,
              name: attachment.name,
              mimeType: attachment.mimeType,
              size: attachment.sizeBytes,
              uri: NodeURL.pathToFileURL(attachmentPath).href,
            } satisfies EffectAcpSchema.ContentBlock;
          default:
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: `Unsupported Devin attachment type '${attachment.type}'.`,
            });
        }
      });

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

    const stopSessionInternal = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) {
          return;
        }
        ctx.stopped = true;

        for (const [requestId, pending] of ctx.pendingApprovals) {
          yield* Deferred.succeed(pending.decision, "cancel" as const).pipe(Effect.ignore);
          pendingApprovalsByRequestId.delete(requestId);
        }
        ctx.pendingApprovals.clear();

        for (const [requestId, pending] of ctx.pendingUserInputs) {
          const answers: ProviderUserInputAnswers = {};
          yield* Deferred.succeed(pending.answers, answers).pipe(Effect.ignore);
          pendingUserInputsByRequestId.delete(requestId);
        }
        ctx.pendingUserInputs.clear();

        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        if (sessions.get(ctx.threadId) === ctx) {
          sessions.delete(ctx.threadId);
        }
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...stamp,
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: {},
        });
      });

    const handleParsedEvent = (ctx: DevinSessionContext, event: AcpParsedSessionEvent) =>
      Effect.gen(function* () {
        const stamp = yield* makeEventStamp();
        const turnId = ctx.activeTurnId;
        const activeTurn = turnId ? ctx.turns.find((turn) => turn.id === turnId) : undefined;

        const appendToActiveTurn = (item: unknown) => {
          if (activeTurn) {
            activeTurn.items.push(item);
          }
        };

        switch (event._tag) {
          case "ModeChanged":
            yield* offerRuntimeEvent({
              type: "session.state.changed",
              ...stamp,
              provider: PROVIDER,
              threadId: ctx.threadId,
              payload: { state: "ready", reason: `Mode ${event.modeId}` },
            });
            return;
          case "AssistantItemStarted":
            ctx.activeItemId = event.itemId;
            appendToActiveTurn(event);
            yield* offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                itemId: event.itemId,
                lifecycle: "item.started",
              }),
            );
            return;
          case "AssistantItemCompleted":
            ctx.activeItemId = undefined;
            appendToActiveTurn(event);
            yield* offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                itemId: event.itemId,
                lifecycle: "item.completed",
              }),
            );
            return;
          case "ContentDelta":
            appendToActiveTurn(event);
            yield* offerRuntimeEvent(
              makeAcpContentDeltaEvent({
                stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                ...(event.itemId ? { itemId: event.itemId } : {}),
                text: event.text,
                rawPayload: event.rawPayload,
              }),
            );
            return;
          case "ToolCallUpdated":
            appendToActiveTurn(event);
            yield* offerRuntimeEvent(
              makeAcpToolCallEvent({
                stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                toolCall: event.toolCall,
                rawPayload: event.rawPayload,
              }),
            );
            return;
          case "PlanUpdated":
            appendToActiveTurn(event);
            yield* offerRuntimeEvent(
              makeAcpPlanUpdatedEvent({
                stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                payload: event.payload,
                source: "acp.jsonrpc",
                method: "session/update",
                rawPayload: event.rawPayload,
              }),
            );
            return;
          case "ConfigOptionsChanged":
          case "AvailableCommandsChanged":
            return;
        }
      });

    const startSession = (input: ProviderSessionStartInput) =>
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
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const devinModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;

          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const resolvedConfigPath = devinSettings.configPath.trim()
            ? path.resolve(expandHomePath(devinSettings.configPath))
            : undefined;

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeSessionId =
            typeof input.resumeCursor === "string" && input.resumeCursor.trim().length > 0
              ? input.resumeCursor.trim()
              : undefined;

          const acp = yield* makeDevinAcpRuntime({
            devinSettings: {
              binaryPath: devinSettings.binaryPath,
              agentType: devinSettings.agentType,
              sandbox: devinSettings.sandbox,
              respectWorkspaceTrust: devinSettings.respectWorkspaceTrust,
              launchArgs: devinSettings.launchArgs,
              resolvedConfigPath,
            },
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            runtimeMode: input.runtimeMode,
            clientInfo: { name: "t3-code", version: "0.0.0" },
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
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

          // Handlers are registered before `acp.start()` so permission and
          // elicitation requests that arrive during startup have a handler.
          // They look up the live session context once it is published.
          const pendingApprovals = new Map<ApprovalRequestId, DevinPendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, DevinPendingUserInput>();

          const handleRequestPermissionCallback = (
            request: EffectAcpSchema.RequestPermissionRequest,
          ) =>
            mapAcpCallbackFailure(
              Effect.gen(function* () {
                const ctx = sessions.get(input.threadId);
                const turnId = ctx?.activeTurnId;

                if (input.runtimeMode === "full-access") {
                  const autoOptionId = selectDevinAutoPermissionOptionId(request);
                  if (autoOptionId !== undefined) {
                    return {
                      outcome: {
                        outcome: "selected" as const,
                        optionId: autoOptionId,
                      },
                    };
                  }
                }

                const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                const permissionRequest = parsePermissionRequest(request);
                const detail =
                  permissionRequest.detail ??
                  (typeof request.sessionId === "string"
                    ? `Session ${request.sessionId}`
                    : "[unknown]");
                const approvalContext = {
                  request,
                  decision,
                  turnId,
                  runtimeRequestId,
                  permissionRequest,
                  detail,
                };
                pendingApprovals.set(requestId, approvalContext);
                if (ctx) {
                  ctx.pendingApprovals.set(requestId, approvalContext);
                }
                pendingApprovalsByRequestId.set(requestId, {
                  ...approvalContext,
                  threadId: input.threadId,
                });

                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail,
                    args: request,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: request,
                  }),
                );

                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                ctx?.pendingApprovals.delete(requestId);
                pendingApprovalsByRequestId.delete(requestId);

                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );

                const optionId = selectDevinPermissionOptionId(request, resolved);
                if (resolved === "cancel" || optionId === undefined) {
                  return { outcome: { outcome: "cancelled" as const } };
                }
                return {
                  outcome: {
                    outcome: "selected" as const,
                    optionId,
                  },
                };
              }),
            );

          const handleElicitationCallback = (request: EffectAcpSchema.ElicitationRequest) =>
            mapAcpCallbackFailure(
              Effect.gen(function* () {
                const ctx = sessions.get(input.threadId);
                const turnId = ctx?.activeTurnId;

                if (input.runtimeMode === "full-access") {
                  if (request.mode === "url") {
                    return { action: { action: "decline" as const } };
                  }
                  return {
                    action: {
                      action: "accept" as const,
                      content: buildAutoElicitationContent(request),
                    },
                  };
                }

                if (request.mode === "url") {
                  return { action: { action: "decline" as const } };
                }

                const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                const userInputContext = {
                  request,
                  answers,
                  turnId,
                  runtimeRequestId,
                };
                pendingUserInputs.set(requestId, userInputContext);
                if (ctx) {
                  ctx.pendingUserInputs.set(requestId, userInputContext);
                }
                pendingUserInputsByRequestId.set(requestId, {
                  ...userInputContext,
                  threadId: input.threadId,
                });

                const questions = elicitQuestionsFromRequest(request);
                const stamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "user-input.requested",
                  ...stamp,
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  requestId: runtimeRequestId,
                  payload: { questions },
                });

                const resolved = yield* Deferred.await(answers);
                pendingUserInputs.delete(requestId);
                ctx?.pendingUserInputs.delete(requestId);
                pendingUserInputsByRequestId.delete(requestId);

                const content = resolved as Record<string, EffectAcpSchema.ElicitationContentValue>;
                const resolvedStamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "user-input.resolved",
                  ...resolvedStamp,
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  requestId: runtimeRequestId,
                  payload: { answers: content },
                });

                return {
                  action: {
                    action: "accept" as const,
                    content,
                  },
                };
              }),
            );

          yield* acp.handleRequestPermission(handleRequestPermissionCallback);
          yield* acp.handleElicitation(handleElicitationCallback);

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

          const modelState = started.sessionSetupResult.models;
          const { protocolMap } = buildDevinModelsFromSessionModelState(modelState);
          let currentModelId = currentDevinModelIdFromSessionSetup(started.sessionSetupResult);

          const initialModelId = resolveDevinAcpBaseModelId(devinModelSelection?.model);
          const initialReasoningEffort = getModelSelectionStringOptionValue(
            devinModelSelection,
            "reasoningEffort",
          );

          if (
            initialModelId !== DEVIN_DEFAULT_MODEL_SLUG_PUBLIC ||
            initialReasoningEffort !== undefined
          ) {
            const next = yield* applyDevinAcpModelSelection({
              runtime: acp,
              protocolMap,
              currentModelId,
              requestedModelId: initialModelId,
              requestedReasoningEffort: initialReasoningEffort,
              mapError: (context) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: context.step,
                  detail: context.cause.message,
                  cause: context.cause,
                }),
            });
            currentModelId = next;
          }

          const modeState = started.sessionSetupResult.modes ?? (yield* acp.getModeState);
          const desiredMode = resolveDevinAcpMode(
            input.runtimeMode,
            modeState?.availableModes,
            "default",
          );
          if (desiredMode) {
            yield* acp.setMode(desiredMode).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/set_config_option",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          }

          const createdAt = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd: input.cwd,
            model: devinModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: started.sessionId,
            activeTurnId: undefined,
            createdAt,
            updatedAt: createdAt,
          };

          const ctx: DevinSessionContext = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            acpSessionId: started.sessionId,
            notificationFiber: undefined,
            currentModelId,
            protocolMap,
            activeItemId: undefined,
            activeTurnId: undefined,
            turns: [],
            stopped: false,
            pendingApprovals,
            pendingUserInputs,
          };

          const nf = yield* Stream.runForEach(acp.getEvents(), (event) =>
            event._tag === "EventStreamBarrier" ? Effect.void : handleParsedEvent(ctx, event),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Devin runtime notification.", { cause }),
            ),
            Effect.forkIn(sessionScope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "session.started",
            ...stamp,
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          const stamp2 = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...stamp2,
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready" },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const getSession = (threadId: ThreadId, _operation: string) => {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      if (ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(ctx);
    };

    const sendTurn = (input: ProviderSendTurnInput) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* getSession(input.threadId, "sendTurn");

          if (!input.input?.trim() && (input.attachments ?? []).length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "input is required and must be non-empty when no attachments are provided.",
            });
          }

          if (ctx.activeTurnId !== undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Cannot start a new turn while another turn is active.",
            });
          }

          const turnId = TurnId.make(yield* randomUUIDv4);

          const devinModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;

          if (devinModelSelection) {
            const requestedModelId = resolveDevinAcpBaseModelId(devinModelSelection.model);
            const requestedReasoningEffort = getModelSelectionStringOptionValue(
              devinModelSelection,
              "reasoningEffort",
            );
            const next = yield* applyDevinAcpModelSelection({
              runtime: ctx.acp,
              protocolMap: ctx.protocolMap,
              currentModelId: ctx.currentModelId,
              requestedModelId,
              requestedReasoningEffort,
              mapError: (context) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: context.step,
                  detail: context.cause.message,
                  cause: context.cause,
                }),
            });
            ctx.currentModelId = next;
          }

          const modeState = yield* ctx.acp.getModeState;
          const desiredMode = resolveDevinAcpMode(
            ctx.session.runtimeMode,
            modeState?.availableModes,
            input.interactionMode === "plan" ? "plan" : "default",
          );
          if (desiredMode) {
            yield* ctx.acp.setMode(desiredMode).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/set_config_option",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          }

          const prompt: Array<EffectAcpSchema.ContentBlock> = [];
          const text = input.input?.trim();
          if (text) {
            prompt.push({ type: "text", text });
          }
          for (const attachment of input.attachments ?? []) {
            prompt.push(yield* contentBlockForAttachment(attachment));
          }

          const stamp = yield* makeEventStamp();
          ctx.activeTurnId = turnId;
          ctx.session = { ...ctx.session, status: "running", activeTurnId: turnId };
          ctx.turns.push({ id: turnId, items: [] });
          ctx.turns.at(-1)?.items.push({ role: "user", content: prompt });

          yield* offerRuntimeEvent({
            type: "turn.started",
            ...stamp,
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: { model: ctx.currentModelId },
          });

          const promptFiber = yield* ctx.acp.prompt({ prompt }).pipe(
            Effect.timeoutOption(DEVIN_PROMPT_TIMEOUT_MS),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: cause.message,
                  cause,
                }),
            ),
            Effect.forkIn(ctx.scope),
          );

          yield* Effect.gen(function* () {
            const promptResult = yield* Fiber.join(promptFiber).pipe(Effect.result);
            const stamp2 = yield* makeEventStamp();
            if (Result.isSuccess(promptResult)) {
              yield* Option.match(promptResult.success, {
                onNone: () =>
                  offerRuntimeEvent({
                    type: "turn.completed",
                    ...stamp2,
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: { state: "failed" },
                  }),
                onSome: (response) => {
                  const isCancelled = response.stopReason === "cancelled";
                  return offerRuntimeEvent({
                    type: "turn.completed",
                    ...stamp2,
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: {
                      state: isCancelled ? "cancelled" : "completed",
                      ...(response.stopReason ? { stopReason: response.stopReason } : {}),
                    },
                  });
                },
              });
            } else {
              const error = promptResult.failure;
              const message = error.message;
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...stamp2,
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: message,
                },
              });
            }
            const turn = ctx.turns.find((t) => t.id === turnId);
            if (turn) {
              if (Result.isSuccess(promptResult)) {
                Option.match(promptResult.success, {
                  onNone: () => {
                    turn.items.push({ state: "timeout" });
                  },
                  onSome: (response) => {
                    turn.items.push(response);
                  },
                });
              } else {
                const error = promptResult.failure;
                turn.items.push({ state: "failed", errorMessage: error.message });
              }
            }

            if (!ctx.stopped && ctx.activeTurnId === turnId) {
              ctx.activeTurnId = undefined;
              ctx.session = { ...ctx.session, status: "ready", activeTurnId: undefined };
            }
          }).pipe(Effect.forkIn(ctx.scope));

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.acpSessionId,
          } satisfies ProviderTurnStartResult;
        }),
      );

    const interruptTurn = (threadId: ThreadId, turnId?: TurnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* getSession(threadId, "interruptTurn");
          if (turnId !== undefined && ctx.activeTurnId !== turnId) {
            return;
          }
          if (ctx.activeTurnId === undefined) {
            return;
          }
          yield* ctx.acp.cancel.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/cancel",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          ctx.activeTurnId = undefined;
          ctx.session = { ...ctx.session, status: "ready", activeTurnId: undefined };
        }),
      );

    const respondToRequest = (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ) =>
      Effect.gen(function* () {
        const pending = pendingApprovalsByRequestId.get(_requestId);
        if (!pending || pending.threadId !== _threadId) {
          return;
        }
        const ctx = sessions.get(_threadId);
        if (ctx?.stopped) {
          pendingApprovalsByRequestId.delete(_requestId);
          return;
        }
        yield* Deferred.succeed(pending.decision, _decision).pipe(Effect.ignore);
      });

    const respondToUserInput = (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        const pending = pendingUserInputsByRequestId.get(_requestId);
        if (!pending || pending.threadId !== _threadId) {
          return;
        }
        const ctx = sessions.get(_threadId);
        if (ctx?.stopped) {
          pendingUserInputsByRequestId.delete(_requestId);
          return;
        }
        yield* Deferred.succeed(pending.answers, _answers).pipe(Effect.ignore);
      });

    const stopSession = (threadId: ThreadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* getSession(threadId, "stopSession");
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions = () =>
      Effect.sync(() => Array.from(sessions.values()).map((ctx) => ctx.session));

    const hasSession = (threadId: ThreadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const readThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const ctx = yield* getSession(threadId, "readThread");
        return {
          threadId,
          turns: ctx.turns,
        } satisfies ProviderThreadSnapshot;
      });

    const rollbackThread = (threadId: ThreadId, numTurns: number) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* getSession(threadId, "rollbackThread");
          if (!Number.isInteger(numTurns) || numTurns < 1) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "numTurns must be an integer >= 1.",
            });
          }
          if (numTurns > ctx.turns.length) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: `Cannot roll back ${numTurns} turns; only ${ctx.turns.length} turns exist.`,
            });
          }
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Devin ACP sessions do not support provider-side rollback yet.",
          });
        }),
      );

    const stopAll = () =>
      Effect.gen(function* () {
        const snapshot = Array.from(sessions.values());
        for (const ctx of snapshot) {
          if (ctx.stopped) {
            continue;
          }
          if (sessions.get(ctx.threadId) !== ctx) {
            continue;
          }
          yield* withThreadLock(
            ctx.threadId,
            Effect.gen(function* () {
              if (sessions.get(ctx.threadId) !== ctx) {
                return;
              }
              yield* stopSessionInternal(ctx);
            }),
          );
        }
      });

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

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
      streamEvents,
    } satisfies DevinAdapterShape;
  });
}
