import {
  type ModelSelection,
  type PiSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { parsePiModelSlug, makePiModelSlug } from "../Drivers/PiModels.ts";
import {
  type PiSessionRuntimeError,
  type PiSessionRuntimeOptions,
  type PiSessionRuntimeShape,
} from "../Drivers/PiSessionRuntime.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const TURN_DELIVERY_MESSAGE =
  "Pi prompt delivery is not enabled until conversation streaming support is installed.";
const UNSUPPORTED_OPERATION_MESSAGE =
  "This Pi operation is not available until conversation controls are installed.";

export type PiRuntimeFactory<R = never> = (
  options: PiSessionRuntimeOptions,
) => Effect.Effect<PiSessionRuntimeShape, PiSessionRuntimeError, R | Scope.Scope>;

export interface PiAdapterOptions<R = never> {
  readonly instanceId: ProviderInstanceId;
  readonly sessionDirectory: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly makeRuntime: PiRuntimeFactory<R>;
}

interface PiAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly runtime: PiSessionRuntimeShape;
  session: ProviderSession;
  stopped: boolean;
}

function runtimeProcessError(
  threadId: ThreadId,
  error: PiSessionRuntimeError,
): ProviderAdapterProcessError {
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: error.message,
    cause: error,
  });
}

function runtimeRequestError(
  method: string,
  error: PiSessionRuntimeError,
): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: error.message,
    cause: error,
  });
}

/**
 * Build a Pi provider adapter bound to a single Pi Runtime Instance.
 *
 * Each adapter closure owns a separate session map and Pi Session Directory;
 * the T3 thread ID is always supplied to Pi as its native session ID.
 */
export function makePiAdapter<R>(
  piSettings: PiSettings,
  options: PiAdapterOptions<R>,
): Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, never, R | Scope.Scope> {
  return Effect.gen(function* () {
    const runtimeFactory = options.makeRuntime;
    // Provider adapter methods cannot require services at call time. Capture
    // the runtime factory's infrastructure while the driver materializes this
    // instance, then re-provide it when a thread starts later.
    const runtimeContext = yield* Effect.context<R>();
    const sessions = new Map<ThreadId, PiAdapterSessionContext>();

    const stopSessionInternal = (context: PiAdapterSessionContext): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (context.stopped) {
          return Effect.void;
        }
        context.stopped = true;
        return context.runtime.close.pipe(
          Effect.ignore,
          Effect.andThen(Scope.close(context.scope, Exit.void).pipe(Effect.ignore)),
          Effect.andThen(
            Effect.sync(() => {
              if (sessions.get(context.threadId) === context) {
                sessions.delete(context.threadId);
              }
            }),
          ),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PiAdapterSessionContext, ProviderAdapterSessionNotFoundError> => {
      const session = sessions.get(threadId);
      if (session && !session.stopped) {
        return Effect.succeed(session);
      }
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const applyModelSelection = (input: {
      readonly runtime: PiSessionRuntimeShape;
      readonly modelSelection: ModelSelection | undefined;
      readonly initialModel: string | undefined;
      readonly operation: "startSession" | "sendTurn";
    }) =>
      Effect.gen(function* () {
        const selection = input.modelSelection;
        if (!selection || selection.instanceId !== options.instanceId) {
          return input.initialModel;
        }

        const piModel = parsePiModelSlug(selection.model);
        if (!piModel) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: input.operation,
            issue: `Model '${selection.model}' is not a valid Pi provider/model selection.`,
          });
        }

        yield* input.runtime
          .setModel(piModel)
          .pipe(Effect.mapError((error) => runtimeRequestError("set_model", error)));

        const requestedThinkingLevel = getModelSelectionStringOptionValue(
          selection,
          "reasoningEffort",
        );
        if (!requestedThinkingLevel) {
          return makePiModelSlug(piModel);
        }

        const levels = yield* input.runtime
          .getAvailableThinkingLevels()
          .pipe(
            Effect.mapError((error) => runtimeRequestError("get_available_thinking_levels", error)),
          );
        if (!levels.includes(requestedThinkingLevel)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: input.operation,
            issue: `Pi model '${selection.model}' does not support thinking level '${requestedThinkingLevel}'.`,
          });
        }

        yield* input.runtime
          .setThinkingLevel(requestedThinkingLevel)
          .pipe(Effect.mapError((error) => runtimeRequestError("set_thinking_level", error)));
        return makePiModelSlug(piModel);
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (
            input.providerInstanceId !== undefined &&
            input.providerInstanceId !== options.instanceId
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected Pi runtime instance '${options.instanceId}' but received '${input.providerInstanceId}'.`,
            });
          }

          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const sessionScope = yield* Scope.make("sequential");
          let transferred = false;
          yield* Effect.addFinalizer(() =>
            transferred ? Effect.void : Scope.close(sessionScope, Exit.void).pipe(Effect.ignore),
          );

          const runtime = yield* runtimeFactory({
            binaryPath: piSettings.binaryPath,
            configDirectory: piSettings.configDirectory,
            launchArgs: piSettings.launchArgs,
            cwd: input.cwd ?? process.cwd(),
            ...(options.environment ? { environment: options.environment } : {}),
            sessionDirectory: options.sessionDirectory,
            sessionId: input.threadId,
          }).pipe(
            Effect.provideContext(runtimeContext),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((error) => runtimeProcessError(input.threadId, error)),
          );
          const state = yield* runtime
            .start()
            .pipe(Effect.mapError((error) => runtimeProcessError(input.threadId, error)));
          const initialModel = state.model
            ? makePiModelSlug({ provider: state.model.provider, modelId: state.model.id })
            : undefined;
          const model = yield* applyModelSelection({
            runtime,
            modelSelection: input.modelSelection,
            initialModel,
            operation: "startSession",
          });
          const now = DateTime.formatIso(yield* DateTime.now);
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(model ? { model } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: 1,
              sessionId: input.threadId,
            },
            createdAt: now,
            updatedAt: now,
          };
          const context: PiAdapterSessionContext = {
            threadId: input.threadId,
            scope: sessionScope,
            runtime,
            session,
            stopped: false,
          };
          sessions.set(input.threadId, context);
          transferred = true;
          return session;
        }),
      );

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      requireSession(input.threadId).pipe(
        Effect.flatMap((context) =>
          applyModelSelection({
            runtime: context.runtime,
            modelSelection: input.modelSelection,
            initialModel: context.session.model,
            operation: "sendTurn",
          }).pipe(
            Effect.tap((model) =>
              Effect.map(DateTime.now, DateTime.formatIso).pipe(
                Effect.tap((updatedAt) =>
                  Effect.sync(() => {
                    context.session = {
                      ...context.session,
                      ...(model ? { model } : {}),
                      updatedAt,
                    };
                  }),
                ),
              ),
            ),
            Effect.andThen(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "prompt",
                detail: TURN_DELIVERY_MESSAGE,
              }),
            ),
          ),
        ),
      );

    const unavailableOperation = (method: string, threadId: ThreadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: UNSUPPORTED_OPERATION_MESSAGE,
            }),
          ),
        ),
      );

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: PROVIDER,
      // Pi natively applies model/thinking changes to a live RPC session.
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn: (threadId) => unavailableOperation("abort", threadId),
      respondToRequest: (threadId) => unavailableOperation("extension_ui_response", threadId),
      respondToUserInput: (threadId) => unavailableOperation("extension_ui_response", threadId),
      stopSession: (threadId) =>
        requireSession(threadId).pipe(Effect.flatMap(stopSessionInternal), Effect.asVoid),
      listSessions: () =>
        Effect.sync(() =>
          Array.from(sessions.values(), (context) => context.session).filter(
            (session) => !sessions.get(session.threadId)?.stopped,
          ),
        ),
      hasSession: (threadId) => Effect.succeed(Boolean(sessions.get(threadId)?.stopped === false)),
      readThread: (threadId) => unavailableOperation("get_messages", threadId),
      rollbackThread: (threadId) => unavailableOperation("rollback", threadId),
      stopAll: () =>
        Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true }),
      // Runtime event mapping is deliberately introduced with Pi prompt
      // delivery. Preserve raw transport events on the runtime until then.
      streamEvents: Stream.empty,
    };

    yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));
    return adapter;
  });
}
