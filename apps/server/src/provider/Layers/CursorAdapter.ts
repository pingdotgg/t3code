/**
 * CursorAdapterLive — Cursor CLI (`agent acp`) via ACP.
 *
 * Cursor-specific wiring on top of the provider-agnostic
 * {@link makeStandardAcpAdapter} core: resume/mode handling, model selection,
 * and Cursor's private ACP extension protocol registered through the base's
 * generic extension hook.
 *
 * @module CursorAdapterLive
 */

import {
  ApprovalRequestId,
  type CursorSettings,
  type ProviderOptionSelection,
  type ProviderInteractionMode,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { type AcpSessionMode, type AcpSessionModeState } from "../acp/AcpRuntimeModel.ts";
import { applyCursorAcpModelSelection, makeCursorAcpRuntime } from "../acp/CursorAcpSupport.ts";
import {
  CursorAskQuestionRequest,
  CursorCreatePlanRequest,
  CursorUpdateTodosRequest,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
} from "../acp/CursorAcpExtension.ts";
import { type CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { resolveCursorAcpBaseModelId } from "./CursorProvider.ts";
import {
  makeStandardAcpAdapter,
  type StandardAcpAdapterConfig,
  type StandardAcpAdapterOptions,
  type StandardAcpExtensionContext,
} from "./StandardAcpAdapter.ts";

const CURSOR_PROVIDER = ProviderDriverKind.make("cursor");
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];

export interface CursorAdapterLiveOptions extends StandardAcpAdapterOptions {
  /**
   * Optional per-session settings resolver. When provided the adapter yields
   * this effect at the start of every session and uses the result instead of
   * the `cursorSettings` captured at construction.
   *
   * Production instances bind settings to the instance scope (the hydration
   * layer rebuilds the adapter on config change) and leave this undefined.
   * Test suites that mutate `ServerSettingsService` mid-flight — e.g. to
   * swap `binaryPath` to a mock ACP wrapper — pass a resolver that reads
   * the latest snapshot so the closure isn't stale.
   */
  readonly resolveSettings?: Effect.Effect<CursorSettings>;
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  if (input.runtimeMode === "approval-required") {
    return (
      findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
      findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
      modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
      modeState.currentModeId
    );
  }

  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: EffectAcpErrors.AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.modelSelection) {
      yield* applyCursorAcpModelSelection({
        runtime: input.runtime,
        model: input.modelSelection.model,
        selections: input.modelSelection.options,
        mapError: ({ cause }) =>
          input.mapError({
            cause,
            method: "session/set_config_option",
          }),
      });
    }

    const requestedModeId = resolveRequestedModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) {
      return;
    }

    yield* input.runtime.setMode(requestedModeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
    );
  });
}

/**
 * Registers Cursor's private ACP extension protocol
 * (`cursor/ask_question`, `cursor/create_plan`, `cursor/update_todos`) through
 * the base adapter's generic extension hook. Behavior is identical to the
 * inline registrations these methods historically lived beside.
 */
function registerCursorExtensions(
  ctx: StandardAcpExtensionContext,
): Effect.Effect<void, EffectAcpErrors.AcpError> {
  return Effect.gen(function* () {
    yield* ctx.acp.handleExtRequest("cursor/ask_question", CursorAskQuestionRequest, (params) =>
      ctx.mapExtensionFailure(
        Effect.gen(function* () {
          yield* ctx.logNative("cursor/ask_question", params, "acp.cursor.extension");
          const requestId = ApprovalRequestId.make(yield* ctx.randomUUIDv4);
          const runtimeRequestId = RuntimeRequestId.make(requestId);
          const answers = yield* Deferred.make<ProviderUserInputAnswers>();
          ctx.pendingUserInputs.set(requestId, { answers });
          yield* ctx.offerRuntimeEvent({
            type: "user-input.requested",
            ...(yield* ctx.makeEventStamp()),
            provider: ctx.provider,
            threadId: ctx.threadId,
            turnId: ctx.getActiveTurnId(),
            requestId: runtimeRequestId,
            payload: { questions: extractAskQuestions(params) },
            raw: {
              source: "acp.cursor.extension",
              method: "cursor/ask_question",
              payload: params,
            },
          });
          const resolved = yield* Deferred.await(answers);
          ctx.pendingUserInputs.delete(requestId);
          yield* ctx.offerRuntimeEvent({
            type: "user-input.resolved",
            ...(yield* ctx.makeEventStamp()),
            provider: ctx.provider,
            threadId: ctx.threadId,
            turnId: ctx.getActiveTurnId(),
            requestId: runtimeRequestId,
            payload: { answers: resolved },
          });
          return { answers: resolved };
        }),
      ),
    );
    yield* ctx.acp.handleExtRequest("cursor/create_plan", CursorCreatePlanRequest, (params) =>
      ctx.mapExtensionFailure(
        Effect.gen(function* () {
          yield* ctx.logNative("cursor/create_plan", params, "acp.cursor.extension");
          yield* ctx.offerRuntimeEvent({
            type: "turn.proposed.completed",
            ...(yield* ctx.makeEventStamp()),
            provider: ctx.provider,
            threadId: ctx.threadId,
            turnId: ctx.getActiveTurnId(),
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
    yield* ctx.acp.handleExtNotification(
      "cursor/update_todos",
      CursorUpdateTodosRequest,
      (params) =>
        ctx.mapExtensionFailure(
          Effect.gen(function* () {
            yield* ctx.logNative("cursor/update_todos", params, "acp.cursor.extension");
            yield* ctx.emitActiveSessionPlanUpdate(
              extractTodosAsPlan(params),
              params,
              "acp.cursor.extension",
              "cursor/update_todos",
            );
          }),
        ),
    );
  });
}

export function makeCursorAdapter(
  cursorSettings: CursorSettings,
  options?: CursorAdapterLiveOptions,
) {
  // Production captures per-instance settings at adapter construction.
  // Tests may resolve the latest settings so mid-suite updates apply to
  // the next spawned session.
  const makeRuntime: StandardAcpAdapterConfig["makeRuntime"] = (input) =>
    options?.resolveSettings
      ? options.resolveSettings.pipe(
          Effect.flatMap((resolvedSettings) =>
            makeCursorAcpRuntime({
              ...input,
              cursorSettings: resolvedSettings,
            }),
          ),
        )
      : makeCursorAcpRuntime({
          ...input,
          cursorSettings,
        });

  return makeStandardAcpAdapter(
    {
      provider: CURSOR_PROVIDER,
      defaultInstanceId: ProviderInstanceId.make("cursor"),
      displayName: "Cursor",
      registerExtensions: registerCursorExtensions,
      makeRuntime,
      applySessionConfiguration: applyRequestedSessionConfiguration,
      resolveBaseModelId: resolveCursorAcpBaseModelId,
    },
    options,
  ).pipe(Effect.map((adapter): CursorAdapterShape => adapter));
}
