/**
 * CursorAdapterLive — Cursor CLI (`agent acp`) via ACP.
 *
 * @module CursorAdapterLive
 */

import {
  ApprovalRequestId,
  type CursorSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type {
  AcpProviderAdapterLiveOptions,
  AcpProviderExtensionRegistrationInput,
} from "./AcpAdapter.ts";
import { makeAcpProviderAdapter } from "./AcpAdapter.ts";
import { applyCursorAcpModelSelection, makeCursorAcpRuntime } from "../acp/CursorAcpSupport.ts";
import {
  CursorAskQuestionRequest,
  CursorCreatePlanRequest,
  CursorUpdateTodosRequest,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
} from "../acp/CursorAcpExtension.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { type CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { resolveCursorAcpBaseModelId } from "./CursorProvider.ts";

const PROVIDER = ProviderDriverKind.make("cursor");

export type CursorAdapterLiveOptions = AcpProviderAdapterLiveOptions<CursorSettings>;

const registerCursorExtensions = (input: AcpProviderExtensionRegistrationInput) =>
  Effect.gen(function* () {
    yield* input.acp.handleExtRequest("cursor/ask_question", CursorAskQuestionRequest, (params) =>
      input.mapExtensionFailure(
        Effect.gen(function* () {
          yield* input.logNative(
            input.threadId,
            "cursor/ask_question",
            params,
            "acp.cursor.extension",
          );
          const requestId = ApprovalRequestId.make(yield* input.randomUUIDv4);
          const runtimeRequestId = RuntimeRequestId.make(requestId);
          const answers = yield* Deferred.make<ProviderUserInputAnswers>();
          input.pendingUserInputs.set(requestId, { answers });
          const context = input.getContext();
          yield* input.offerRuntimeEvent({
            type: "user-input.requested",
            ...(yield* input.makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: context?.activeTurnId,
            requestId: runtimeRequestId,
            payload: { questions: extractAskQuestions(params) },
            raw: {
              source: "acp.cursor.extension",
              method: "cursor/ask_question",
              payload: params,
            },
          });
          const resolved = yield* Deferred.await(answers);
          input.pendingUserInputs.delete(requestId);
          yield* input.offerRuntimeEvent({
            type: "user-input.resolved",
            ...(yield* input.makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: context?.activeTurnId,
            requestId: runtimeRequestId,
            payload: { answers: resolved },
          });
          return { answers: resolved };
        }),
      ),
    );
    yield* input.acp.handleExtRequest("cursor/create_plan", CursorCreatePlanRequest, (params) =>
      input.mapExtensionFailure(
        Effect.gen(function* () {
          yield* input.logNative(
            input.threadId,
            "cursor/create_plan",
            params,
            "acp.cursor.extension",
          );
          const context = input.getContext();
          yield* input.offerRuntimeEvent({
            type: "turn.proposed.completed",
            ...(yield* input.makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: context?.activeTurnId,
            payload: { planMarkdown: extractPlanMarkdown(params) },
            raw: {
              source: "acp.cursor.extension",
              method: "cursor/create_plan",
              payload: params,
            },
          });
          return { accepted: true } as const;
        }),
      ),
    );
    yield* input.acp.handleExtNotification(
      "cursor/update_todos",
      CursorUpdateTodosRequest,
      (params) =>
        input.mapExtensionFailure(
          Effect.gen(function* () {
            yield* input.logNative(
              input.threadId,
              "cursor/update_todos",
              params,
              "acp.cursor.extension",
            );
            const context = input.getContext();
            if (context) {
              yield* input.emitPlanUpdate(
                context,
                extractTodosAsPlan(params),
                params,
                "acp.cursor.extension",
                "cursor/update_todos",
              );
            }
          }),
        ),
    );
  });

export function makeCursorAdapter(
  cursorSettings: CursorSettings,
  options?: CursorAdapterLiveOptions,
) {
  return makeAcpProviderAdapter({
    provider: PROVIDER,
    defaultInstanceId: ProviderInstanceId.make("cursor"),
    displayName: "Cursor",
    settings: cursorSettings,
    supportsRollback: true,
    ...(options ? { options } : {}),
    registerExtensions: registerCursorExtensions,
    userInputRequestMethod: "cursor/ask_question",
    makeRuntime: ({
      threadId,
      settings,
      environment,
      childProcessSpawner,
      cwd,
      resumeSessionId,
      clientInfo,
      nativeLoggers,
    }) => {
      const mcpSession = McpProviderSession.readMcpProviderSession(threadId);
      return makeCursorAcpRuntime({
        cursorSettings: settings,
        ...(environment ? { environment } : {}),
        childProcessSpawner,
        cwd,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        clientInfo,
        ...(mcpSession
          ? {
              mcpServers: [
                {
                  type: "http" as const,
                  name: "t3-code",
                  url: mcpSession.endpoint,
                  headers: [
                    {
                      name: "Authorization",
                      value: mcpSession.authorizationHeader,
                    },
                  ],
                },
              ],
            }
          : {}),
        ...nativeLoggers,
      });
    },
    applyModelSelection: ({ runtime, threadId, model, selections }) =>
      applyCursorAcpModelSelection({
        runtime,
        model,
        selections,
        mapError: ({ cause, step }) =>
          mapAcpToAdapterError(
            PROVIDER,
            threadId,
            step === "set-model" ? "session/set_model" : "session/set_config_option",
            cause,
          ),
      }),
    resolveModelId: resolveCursorAcpBaseModelId,
  }).pipe(Effect.map((adapter) => adapter satisfies CursorAdapterShape));
}
