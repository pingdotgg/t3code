import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import { DesktopSshPasswordPromptResolutionInputSchema } from "@t3tools/contracts";
import type { SshPasswordRequest } from "@t3tools/ssh/auth";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as IpcChannels from "../ipc/channels.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

const DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT_MS = 3 * 60 * 1000;
const WINDOW_UNAVAILABLE_MESSAGE = "T3 Code window is not available for SSH authentication.";

type DesktopSshPasswordPromptResolutionInput =
  typeof DesktopSshPasswordPromptResolutionInputSchema.Type;

export class DesktopSshPromptUnavailableError extends Data.TaggedError(
  "DesktopSshPromptUnavailableError",
)<{
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}

export class DesktopSshPromptWindowUnavailableError extends Data.TaggedError(
  "DesktopSshPromptWindowUnavailableError",
)<{
  readonly destination: string;
}> {
  override get message() {
    return WINDOW_UNAVAILABLE_MESSAGE;
  }
}

export class DesktopSshPromptSendError extends Data.TaggedError("DesktopSshPromptSendError")<{
  readonly requestId: string;
  readonly destination: string;
  readonly cause: unknown;
}> {
  override get message() {
    return WINDOW_UNAVAILABLE_MESSAGE;
  }
}

export class DesktopSshPromptTimedOutError extends Data.TaggedError(
  "DesktopSshPromptTimedOutError",
)<{
  readonly requestId: string;
  readonly destination: string;
}> {
  override get message() {
    return `SSH authentication timed out for ${this.destination}.`;
  }
}

export class DesktopSshPromptCancelledError extends Data.TaggedError(
  "DesktopSshPromptCancelledError",
)<{
  readonly requestId: string;
  readonly destination: string;
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}

export class DesktopSshPromptInvalidRequestIdError extends Data.TaggedError(
  "DesktopSshPromptInvalidRequestIdError",
)<{
  readonly requestId: string;
}> {
  override get message() {
    return "Invalid SSH password prompt id.";
  }
}

export class DesktopSshPromptExpiredError extends Data.TaggedError("DesktopSshPromptExpiredError")<{
  readonly requestId: string;
}> {
  override get message() {
    return "SSH password prompt expired. Try connecting again.";
  }
}

export type DesktopSshPasswordPromptRequestError =
  | DesktopSshPromptUnavailableError
  | DesktopSshPromptWindowUnavailableError
  | DesktopSshPromptSendError
  | DesktopSshPromptTimedOutError
  | DesktopSshPromptCancelledError;

export type DesktopSshPasswordPromptResolveError =
  | DesktopSshPromptInvalidRequestIdError
  | DesktopSshPromptExpiredError;

export type DesktopSshPasswordPromptError =
  | DesktopSshPasswordPromptRequestError
  | DesktopSshPasswordPromptResolveError;

export function isDesktopSshPasswordPromptCancellation(
  error: unknown,
): error is DesktopSshPromptCancelledError | DesktopSshPromptTimedOutError {
  return (
    error instanceof DesktopSshPromptCancelledError ||
    error instanceof DesktopSshPromptTimedOutError
  );
}

export interface DesktopSshPasswordPromptsShape {
  readonly request: (
    request: SshPasswordRequest,
  ) => Effect.Effect<string, DesktopSshPasswordPromptRequestError>;
  readonly resolve: (
    input: DesktopSshPasswordPromptResolutionInput,
  ) => Effect.Effect<void, DesktopSshPasswordPromptResolveError>;
  readonly cancelPending: (reason: string) => Effect.Effect<void>;
}

export class DesktopSshPasswordPrompts extends Context.Service<
  DesktopSshPasswordPrompts,
  DesktopSshPasswordPromptsShape
>()("t3/desktop/SshPasswordPrompts") {}

interface PendingSshPasswordPrompt {
  readonly requestId: string;
  readonly destination: string;
  readonly deferred: Deferred.Deferred<string, DesktopSshPasswordPromptRequestError>;
  readonly timeoutFiber: Fiber.Fiber<void, never>;
}

interface LayerOptions {
  readonly passwordPromptTimeoutMs?: number;
}

const removePending = (
  pendingRef: Ref.Ref<Map<string, PendingSshPasswordPrompt>>,
  requestId: string,
) =>
  Ref.modify(pendingRef, (pending) => {
    const entry = pending.get(requestId);
    if (entry === undefined) {
      return [Option.none<PendingSshPasswordPrompt>(), pending] as const;
    }

    const nextPending = new Map(pending);
    nextPending.delete(requestId);
    return [Option.some(entry), nextPending] as const;
  });

const interruptTimeout = (pending: PendingSshPasswordPrompt) =>
  Fiber.interrupt(pending.timeoutFiber).pipe(Effect.ignore);

const failPending = (
  pending: PendingSshPasswordPrompt,
  error: DesktopSshPasswordPromptRequestError,
) =>
  interruptTimeout(pending).pipe(
    Effect.andThen(Deferred.fail(pending.deferred, error)),
    Effect.asVoid,
  );

const make = (options: LayerOptions = {}) =>
  Effect.gen(function* () {
    const serviceScope = yield* Scope.Scope;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const pendingRef = yield* Ref.make(new Map<string, PendingSshPasswordPrompt>());
    const passwordPromptTimeoutMs =
      options.passwordPromptTimeoutMs ?? DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT_MS;

    const cancelPending = (reason: string): Effect.Effect<void> =>
      Ref.getAndSet(pendingRef, new Map()).pipe(
        Effect.flatMap((pending) =>
          Effect.forEach(
            pending.values(),
            (entry) =>
              failPending(
                entry,
                new DesktopSshPromptCancelledError({
                  requestId: entry.requestId,
                  destination: entry.destination,
                  reason,
                }),
              ),
            { discard: true },
          ),
        ),
        Effect.asVoid,
      );

    yield* Scope.addFinalizer(
      serviceScope,
      cancelPending("SSH password prompt service stopped.").pipe(Effect.ignore),
    );

    const resolve = (
      input: DesktopSshPasswordPromptResolutionInput,
    ): Effect.Effect<void, DesktopSshPasswordPromptResolveError> =>
      Effect.gen(function* () {
        const requestId = input.requestId.trim();
        if (requestId.length === 0) {
          return yield* new DesktopSshPromptInvalidRequestIdError({ requestId: input.requestId });
        }

        const pending = yield* removePending(pendingRef, requestId);
        if (Option.isNone(pending)) {
          return yield* new DesktopSshPromptExpiredError({ requestId });
        }

        const entry = pending.value;
        if (input.password === null) {
          yield* failPending(
            entry,
            new DesktopSshPromptCancelledError({
              requestId,
              destination: entry.destination,
              reason: `SSH authentication cancelled for ${entry.destination}.`,
            }),
          );
          return;
        }

        yield* interruptTimeout(entry);
        yield* Deferred.succeed(entry.deferred, input.password).pipe(Effect.asVoid);
      });

    const request = (
      input: SshPasswordRequest,
    ): Effect.Effect<string, DesktopSshPasswordPromptRequestError> =>
      Effect.gen(function* () {
        const window = yield* electronWindow.main;
        if (Option.isNone(window) || window.value.isDestroyed()) {
          return yield* new DesktopSshPromptWindowUnavailableError({
            destination: input.destination,
          });
        }

        const requestId = yield* Random.nextUUIDv4;
        const now = yield* DateTime.now;
        const expiresAt = DateTime.formatIso(
          DateTime.add(now, { milliseconds: passwordPromptTimeoutMs }),
        );
        const promptRequest: DesktopSshPasswordPromptRequest = {
          requestId,
          destination: input.destination,
          username: input.username,
          prompt: input.prompt,
          expiresAt,
        };
        const deferred = yield* Deferred.make<string, DesktopSshPasswordPromptRequestError>();
        const timeoutFiber = yield* Effect.sleep(Duration.millis(passwordPromptTimeoutMs)).pipe(
          Effect.andThen(removePending(pendingRef, requestId)),
          Effect.flatMap((pending) =>
            Option.match(pending, {
              onNone: () => Effect.void,
              onSome: (entry) =>
                Deferred.fail(
                  entry.deferred,
                  new DesktopSshPromptTimedOutError({
                    requestId,
                    destination: input.destination,
                  }),
                ).pipe(Effect.asVoid),
            }),
          ),
          Effect.forkIn(serviceScope),
        );
        const pending: PendingSshPasswordPrompt = {
          requestId,
          destination: input.destination,
          deferred,
          timeoutFiber,
        };
        yield* Ref.update(pendingRef, (entries) => new Map(entries).set(requestId, pending));

        const cancelOnWindowClosed = () => {
          Effect.runFork(
            removePending(pendingRef, requestId).pipe(
              Effect.flatMap((entry) =>
                Option.match(entry, {
                  onNone: () => Effect.void,
                  onSome: (pending) =>
                    failPending(
                      pending,
                      new DesktopSshPromptCancelledError({
                        requestId,
                        destination: input.destination,
                        reason: "SSH authentication was cancelled because the app window closed.",
                      }),
                    ),
                }),
              ),
            ),
          );
        };
        const cleanup = Effect.sync(() => {
          if (!window.value.isDestroyed()) {
            window.value.removeListener("closed", cancelOnWindowClosed);
          }
        }).pipe(
          Effect.andThen(removePending(pendingRef, requestId)),
          Effect.andThen(interruptTimeout(pending)),
        );

        return yield* Effect.try({
          try: () => {
            if (window.value.isDestroyed()) {
              throw new Error(WINDOW_UNAVAILABLE_MESSAGE);
            }
            window.value.once("closed", cancelOnWindowClosed);
            window.value.webContents.send(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, promptRequest);
            if (window.value.isDestroyed()) {
              throw new Error(WINDOW_UNAVAILABLE_MESSAGE);
            }
            if (window.value.isMinimized()) {
              window.value.restore();
            }
            if (window.value.isDestroyed()) {
              throw new Error(WINDOW_UNAVAILABLE_MESSAGE);
            }
            window.value.focus();
          },
          catch: (cause) =>
            new DesktopSshPromptSendError({
              requestId,
              destination: input.destination,
              cause,
            }),
        }).pipe(Effect.andThen(Deferred.await(deferred)), Effect.ensuring(cleanup));
      });

    return DesktopSshPasswordPrompts.of({
      request,
      resolve,
      cancelPending,
    });
  });

export const layer = (options: LayerOptions = {}) =>
  Layer.effect(DesktopSshPasswordPrompts, make(options));
