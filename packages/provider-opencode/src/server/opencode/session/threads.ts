/**
 * OpenCode thread registration, permission rules, snapshots and prompt submission.
 */
import type {
  Event as OpenCodeEvent,
  Message as OpenCodeMessage,
  Part as OpenCodePart,
  PermissionRequest,
  PermissionRuleset,
  QuestionRequest,
  Session as OpenCodeSession,
  Todo as OpenCodeTodo,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type PlanId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type ProviderSessionId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as OpenCodeRuntime from "../../OpenCodeRuntime.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  openCodeChildPermissionRules,
  openCodePermissionRules,
  permissionRuleEquals,
} from "../permissions.ts";
import {
  providerRef,
  unwrapData,
} from "../projection.ts";
import {
  dateTimeFromEpoch,
  nativeThreadId,
  protocolError,
} from "../protocol.ts";
import {
  OPENCODE_PROVIDER,
} from "../provider.ts";
import type {
  ActiveOpenCodeTurn,
  OpenCodeThreadState,
} from "../types.ts";
import type { Turns } from "./turns.ts";
import type { State } from "./base.ts";

export const makeThreads = (deps: State & Turns) => {
  const {
    input,
    client,
    scope,
    orchestrationSystemPrompt,
    idAllocator,
    host,
    now,
    threads,
    commandReceipts,
    commandControllers,
    subagentsByChildSessionId,
    abortController,
    sdkCall,
  } = deps;
  const m = deps.mutable;
  const registerThread = (
    nativeSession: OpenCodeSession,
    providerThread: OrchestrationV2ProviderThread,
    appThread: OrchestrationV2AppThread | null,
  ): OpenCodeThreadState => {
    const existing = threads.get(nativeSession.id);
    if (existing !== undefined) {
      existing.providerThread = providerThread;
      if (appThread !== null) existing.appThread = appThread;
      if (nativeSession.permission !== undefined)
        existing.permission = nativeSession.permission;
      return existing;
    }
    const parentSubagent = subagentsByChildSessionId.get(nativeSession.id) ?? null;
    const state: OpenCodeThreadState = {
      nativeSessionId: nativeSession.id,
      providerThread,
      appThread,
      activeTurn: null,
      providerTurns: new Map(),
      runtimeRequests: new Map(),
      messageRoles: new Map(),
      userMessageIds: [],
      parentSubagent,
      nextChildTurnOrdinal: 1,
      nextAdmissionGeneration: 1,
      permission: nativeSession.permission ?? [],
      inheritedPermission: parentSubagent?.parentState.permission ?? [],
    };
    threads.set(nativeSession.id, state);
    return state;
  };

  // OpenCode copies parent rules into a child only at creation, so children are updated here too.

  const applyPermissionRules = Effect.fnUntraced(function* (
    state: OpenCodeThreadState,
    policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  ) {
    const parentRules = openCodePermissionRules(policy);
    const pending = [state];
    for (let target = pending.pop(); target !== undefined; target = pending.pop()) {
      const previous = target.permission;
      const permission =
        target.parentSubagent === null
          ? parentRules
          : openCodeChildPermissionRules(policy, previous, target.inheritedPermission);
      if (
        permission.length !== previous.length ||
        !permission.every((rule, index) => permissionRuleEquals(rule, previous[index]!))
      ) {
        const sessionID = target.nativeSessionId;
        yield* sdkCall("session.update", { sessionID, permission }, () =>
          client.session.update({ sessionID, permission }),
        );
        target.permission = permission;
      }
      if (target.parentSubagent !== null) target.inheritedPermission = parentRules;
      for (const child of threads.values()) {
        if (child.parentSubagent?.parentState === target) pending.push(child);
      }
    }
  });

  const resolvePromptParts = Effect.fnUntraced(function* (
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) {
    const text = (yield* providerMessageTextWithAttachmentPaths({
      text: turnInput.message.text,
      attachments: turnInput.message.attachments,
      resolveAttachmentPath: host.resolveAttachmentPath,
      resolveExtractedTextPath: host.resolveExtractedTextPath,
    })).trim();
    const files = OpenCodeRuntime.toOpenCodeFileParts({
      attachments: turnInput.message.attachments,
      resolveAttachmentPath: host.resolveAttachmentPath,
    });
    if (text.length === 0 && files.length === 0) {
      throw protocolError("OpenCode turns require text or at least one valid attachment");
    }
    return [...(text.length === 0 ? [] : [{ type: "text" as const, text }]), ...files];
  });

  const readSnapshot = Effect.fnUntraced(function* (
    providerThread: OrchestrationV2ProviderThread,
  ) {
    const sessionId = nativeThreadId(providerThread);
    const sessionResponse = yield* sdkCall("session.get", { sessionID: sessionId }, () =>
      client.session.get({ sessionID: sessionId }),
    );
    const nativeSession = unwrapData("session.get", sessionResponse);
    const response = yield* sdkCall("session.messages", { sessionID: sessionId }, () =>
      client.session.messages({ sessionID: sessionId }),
    );
    const nativeMessages = [];
    for (const entry of unwrapData("session.messages", response)) {
      // Reverted records remain in messages; stop at the revert marker to avoid resurrecting work.
      if (entry.info.id === nativeSession.revert?.messageID) break;
      nativeMessages.push(entry);
    }
    const state = threads.get(sessionId);
    const snapshotNow = yield* DateTime.now;
    const messages: Array<OrchestrationV2ConversationMessage> = nativeMessages.flatMap(
      ({ info, parts }) => {
        const text = parts
          .filter(
            (part): part is Extract<OpenCodePart, { type: "text" }> => part.type === "text",
          )
          .filter((part) => part.ignored !== true && part.synthetic !== true)
          .map((part) => part.text)
          .join("\n");
        if (text.length === 0) return [];
        const createdAt = dateTimeFromEpoch(info.time.created, snapshotNow);
        return [
          {
            createdBy: info.role === "user" ? "user" : "agent",
            creationSource: "provider",
            id: idAllocator.derive.messageFromProviderItem({
              driver: OPENCODE_PROVIDER,
              nativeItemId: info.id,
            }),
            threadId: providerThread.appThreadId ?? input.threadId,
            runId: null,
            nodeId: null,
            role: info.role,
            text,
            attachments: [],
            streaming: false,
            createdAt,
            updatedAt:
              info.role === "assistant"
                ? dateTimeFromEpoch(info.time.completed, createdAt)
                : createdAt,
          },
        ];
      },
    );
    const lastUser = nativeMessages.findLast(({ info }) => info.role === "user")?.info.id;
    return {
      providerThread: {
        ...providerThread,
        providerSessionId: input.providerSessionId,
        nativeConversationHeadRef:
          lastUser === undefined ? null : providerRef(lastUser, "weak"),
        status: "idle" as const,
        updatedAt: snapshotNow,
      },
      providerTurns: state === undefined ? [] : [...state.providerTurns.values()],
      messages,
      runtimeRequests: state === undefined ? [] : [...state.runtimeRequests.values()],
      providerPayload: nativeMessages,
    };
  });

  // OpenCode runs each step with the agent and system prompt of the latest
  // user message, so every prompt in a turn, steers included, repeats them.

  const turnPromptOptions = (turn: ActiveOpenCodeTurn) => {
    const agent =
      getModelSelectionStringOptionValue(turn.modelSelection, "agent") ??
      (turn.runtimePolicy.interactionMode === "plan" ? "plan" : undefined);
    const variant = getModelSelectionStringOptionValue(turn.modelSelection, "variant");
    return {
      ...(agent === undefined ? {} : { agent }),
      ...(variant === undefined ? {} : { variant }),
      system: [
        orchestrationSystemPrompt,
        buildRuntimeInstructions({ harness: "OpenCode", model: turn.modelSelection.model }),
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  };

  // Native commands await generation; user-message receipts admit their background requests.

  const submitPrompt = Effect.fn("OpenCode.submitPrompt")(function* (
    state: OpenCodeThreadState,
    turn: ActiveOpenCodeTurn,
    payload: Parameters<typeof client.session.promptAsync>[0] & {
      messageID: string;
      sessionID: string;
    },
    abortController: AbortController,
  ) {
    const text = payload.parts
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    const match = text?.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    const command = match
      ? (yield* OpenCodeRuntime.loadOpenCodeCommands(client).pipe(
          Effect.timeout("10 seconds"),
          Effect.orElseSucceed(() => []),
        )).find((entry) => entry.name === match[1])
      : undefined;
    if (!command) {
      return yield* sdkCall("session.promptAsync", payload, (signal) =>
        client.session.promptAsync(payload, {
          signal: AbortSignal.any([signal, abortController.signal]),
        }),
      ).pipe(Effect.asVoid);
    }
    const receipt = Deferred.makeUnsafe<void>();
    commandReceipts.set(payload.messageID, receipt);
    const controllers =
      commandControllers.get(payload.sessionID) ?? new Set<AbortController>();
    controllers.add(abortController);
    commandControllers.set(payload.sessionID, controllers);
    const generation = turn.admissionGeneration;
    const commandPayload = {
      sessionID: payload.sessionID,
      messageID: payload.messageID,
      command: command.name,
      arguments: match?.[2] ?? "",
      ...(payload.model
        ? { model: `${payload.model.providerID}/${payload.model.modelID}` }
        : {}),
      ...(payload.agent ? { agent: payload.agent } : {}),
      ...(payload.variant ? { variant: payload.variant } : {}),
      parts: payload.parts?.filter((part) => part.type === "file") ?? [],
    };
    const request = yield* sdkCall("session.command", commandPayload, (signal) =>
      client.session.command(commandPayload, {
        signal: AbortSignal.any([signal, abortController.signal]),
      }),
    ).pipe(
      Effect.asVoid,
      Effect.tapError((cause) =>
        abortController.signal.aborted ||
        turn.finalized ||
        turn.admissionGeneration !== generation
          ? Effect.void
          : deps.finalizeTurn(state, turn, "failed", {
              failure: makeProviderFailure({ cause, class: "provider_error" }),
            }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          commandReceipts.delete(payload.messageID);
          controllers.delete(abortController);
          if (controllers.size === 0) commandControllers.delete(payload.sessionID);
        }),
      ),
      Effect.forkIn(scope),
    );
    yield* Effect.raceFirst(Fiber.join(request), Deferred.await(receipt)).pipe(
      Effect.timeout("10 seconds"),
      Effect.catchTags({
        TimeoutError: (cause) => {
          const error = new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "session.command",
            detail: "OpenCode command admission did not complete within 10 seconds.",
            cause,
          });
          abortController.abort();
          return deps.finalizeTurn(state, turn, "failed", {
            failure: makeProviderFailure({ cause: error, class: "provider_error" }),
          }).pipe(Effect.andThen(Effect.fail(error)));
        },
      }),
    );
  });

  return { registerThread, applyPermissionRules, resolvePromptParts, readSnapshot, turnPromptOptions, submitPrompt };
};

export type Threads = ReturnType<typeof makeThreads>;
