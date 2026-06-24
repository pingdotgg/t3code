import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import { DesktopSshPasswordPromptResolutionInputSchema } from "@t3tools/contracts";
import type { SshPasswordRequest } from "@t3tools/ssh/auth";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { SSH_PASSWORD_PROMPT_CHANNEL } from "../ipc/channels.ts";

const DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT_MS = 3 * 60 * 1000;

type DesktopSshPasswordPromptResolutionInput =
  typeof DesktopSshPasswordPromptResolutionInputSchema.Type;

const DesktopSshPromptWindowAvailabilityStage = Schema.Literals([
  "before-request",
  "before-presentation",
  "after-send",
  "after-restore",
]);

const DesktopSshPromptPresentationOperation = Schema.Literals([
  "check-window-before-request",
  "check-window-before-presentation",
  "register-window-close-listener",
  "send-prompt-request",
  "check-window-after-send",
  "check-window-minimized",
  "restore-window",
  "check-window-after-restore",
  "focus-window",
  "remove-window-close-listener",
]);
type DesktopSshPromptPresentationOperation = typeof DesktopSshPromptPresentationOperation.Type;

export class DesktopSshPromptRequestIdGenerationError extends Schema.TaggedErrorClass<DesktopSshPromptRequestIdGenerationError>()(
  "DesktopSshPromptRequestIdGenerationError",
  {
    destination: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Secure randomness is unavailable.";
  }
}

export class DesktopSshPromptWindowUnavailableError extends Schema.TaggedErrorClass<DesktopSshPromptWindowUnavailableError>()(
  "DesktopSshPromptWindowUnavailableError",
  {
    destination: Schema.String,
    requestId: Schema.NullOr(Schema.String),
    stage: DesktopSshPromptWindowAvailabilityStage,
  },
) {
  override get message(): string {
    const request = this.requestId === null ? "before a request id was assigned" : this.requestId;
    return `T3 Code window is unavailable during ${this.stage} for SSH authentication to ${this.destination} (request: ${request}).`;
  }
}

export class DesktopSshPromptPresentationError extends Schema.TaggedErrorClass<DesktopSshPromptPresentationError>()(
  "DesktopSshPromptPresentationError",
  {
    requestId: Schema.NullOr(Schema.String),
    destination: Schema.String,
    operation: DesktopSshPromptPresentationOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to present SSH password prompt for ${this.destination}.`;
  }
}

export class DesktopSshPromptTimedOutError extends Schema.TaggedErrorClass<DesktopSshPromptTimedOutError>()(
  "DesktopSshPromptTimedOutError",
  {
    requestId: Schema.String,
    destination: Schema.String,
  },
) {
  override get message(): string {
    return `SSH authentication timed out for ${this.destination}.`;
  }
}

export class DesktopSshPromptCancelledError extends Schema.TaggedErrorClass<DesktopSshPromptCancelledError>()(
  "DesktopSshPromptCancelledError",
  {
    requestId: Schema.String,
    destination: Schema.String,
  },
) {
  override get message(): string {
    return `SSH authentication cancelled for ${this.destination}.`;
  }
}

export class DesktopSshPromptWindowClosedError extends Schema.TaggedErrorClass<DesktopSshPromptWindowClosedError>()(
  "DesktopSshPromptWindowClosedError",
  {
    requestId: Schema.String,
    destination: Schema.String,
  },
) {
  override get message(): string {
    return "SSH authentication was cancelled because the app window closed.";
  }
}

export class DesktopSshPromptServiceStoppedError extends Schema.TaggedErrorClass<DesktopSshPromptServiceStoppedError>()(
  "DesktopSshPromptServiceStoppedError",
  {
    requestId: Schema.String,
    destination: Schema.String,
  },
) {
  override get message(): string {
    return "SSH password prompt service stopped.";
  }
}

export class DesktopSshPromptInvalidRequestIdError extends Schema.TaggedErrorClass<DesktopSshPromptInvalidRequestIdError>()(
  "DesktopSshPromptInvalidRequestIdError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return "Invalid SSH password prompt id.";
  }
}

export class DesktopSshPromptExpiredError extends Schema.TaggedErrorClass<DesktopSshPromptExpiredError>()(
  "DesktopSshPromptExpiredError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return "SSH password prompt expired. Try connecting again.";
  }
}

export type DesktopSshPasswordPromptRequestError =
  | DesktopSshPromptRequestIdGenerationError
  | DesktopSshPromptWindowUnavailableError
  | DesktopSshPromptPresentationError
  | DesktopSshPromptTimedOutError
  | DesktopSshPromptCancelledError
  | DesktopSshPromptWindowClosedError
  | DesktopSshPromptServiceStoppedError;

export type DesktopSshPasswordPromptResolveError =
  | DesktopSshPromptInvalidRequestIdError
  | DesktopSshPromptExpiredError;

export type DesktopSshPasswordPromptError =
  | DesktopSshPasswordPromptRequestError
  | DesktopSshPasswordPromptResolveError;

export const DesktopSshPasswordPromptCancellation = Schema.Union([
  DesktopSshPromptCancelledError,
  DesktopSshPromptWindowClosedError,
  DesktopSshPromptServiceStoppedError,
  DesktopSshPromptTimedOutError,
]);
export type DesktopSshPasswordPromptCancellation = typeof DesktopSshPasswordPromptCancellation.Type;

export const isDesktopSshPasswordPromptCancellation = Schema.is(
  DesktopSshPasswordPromptCancellation,
);

export class DesktopSshPasswordPrompts extends Context.Service<
  DesktopSshPasswordPrompts,
  {
    readonly request: (
      request: SshPasswordRequest,
    ) => Effect.Effect<string, DesktopSshPasswordPromptRequestError>;
    readonly resolve: (
      input: DesktopSshPasswordPromptResolutionInput,
    ) => Effect.Effect<void, DesktopSshPasswordPromptResolveError>;
  }
>()("@t3tools/desktop/ssh/DesktopSshPasswordPrompts") {}

interface PendingSshPasswordPrompt {
  readonly requestId: string;
  readonly destination: string;
  readonly deferred: Deferred.Deferred<string, DesktopSshPasswordPromptRequestError>;
}

export interface DesktopSshPasswordPromptsOptions {
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

const failPending = (
  pending: PendingSshPasswordPrompt,
  error: DesktopSshPasswordPromptRequestError,
) => Deferred.fail(pending.deferred, error).pipe(Effect.asVoid);

export const make = Effect.fn("desktop.sshPasswordPrompts.make")(function* (
  options: DesktopSshPasswordPromptsOptions = {},
) {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const crypto = yield* Crypto.Crypto;
  const pendingRef = yield* Ref.make(new Map<string, PendingSshPasswordPrompt>());
  const passwordPromptTimeoutMs =
    options.passwordPromptTimeoutMs ?? DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT_MS;

  const cancelPending = () =>
    Ref.getAndSet(pendingRef, new Map()).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach(
          pending.values(),
          (entry) =>
            failPending(
              entry,
              new DesktopSshPromptServiceStoppedError({
                requestId: entry.requestId,
                destination: entry.destination,
              }),
            ),
          { discard: true },
        ),
      ),
      Effect.asVoid,
    );

  yield* Effect.addFinalizer(() => cancelPending().pipe(Effect.ignore));

  const resolve: DesktopSshPasswordPrompts["Service"]["resolve"] = Effect.fn(
    "desktop.sshPasswordPrompts.resolve",
  )(function* (input) {
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
        }),
      );
      return;
    }

    yield* Deferred.succeed(entry.deferred, input.password).pipe(Effect.asVoid);
  });

  const request: DesktopSshPasswordPrompts["Service"]["request"] = Effect.fn(
    "desktop.sshPasswordPrompts.request",
  )(function* (input) {
    const window = yield* electronWindow.main;
    if (Option.isNone(window)) {
      return yield* new DesktopSshPromptWindowUnavailableError({
        destination: input.destination,
        requestId: null,
        stage: "before-request",
      });
    }

    const unavailableBeforeRequest = yield* Effect.try({
      try: () => window.value.isDestroyed(),
      catch: (cause) =>
        new DesktopSshPromptPresentationError({
          requestId: null,
          destination: input.destination,
          operation: "check-window-before-request",
          cause,
        }),
    });
    if (unavailableBeforeRequest) {
      return yield* new DesktopSshPromptWindowUnavailableError({
        destination: input.destination,
        requestId: null,
        stage: "before-request",
      });
    }

    const requestId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new DesktopSshPromptRequestIdGenerationError({
            destination: input.destination,
            cause,
          }),
      ),
    );
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
    const pending: PendingSshPasswordPrompt = {
      requestId,
      destination: input.destination,
      deferred,
    };
    yield* Ref.update(pendingRef, (entries) => new Map(entries).set(requestId, pending));

    const context = yield* Effect.context();
    const runFork = Effect.runForkWith(context);

    const cancelOnWindowClosed = () => {
      runFork(
        removePending(pendingRef, requestId).pipe(
          Effect.flatMap((entry) =>
            Option.match(entry, {
              onNone: () => Effect.void,
              onSome: (pending) =>
                failPending(
                  pending,
                  new DesktopSshPromptWindowClosedError({
                    requestId,
                    destination: input.destination,
                  }),
                ),
            }),
          ),
        ),
      );
    };
    const runPresentationOperation = <A>(
      operation: DesktopSshPromptPresentationOperation,
      evaluate: () => A,
    ) =>
      Effect.try({
        try: evaluate,
        catch: (cause) =>
          new DesktopSshPromptPresentationError({
            requestId,
            destination: input.destination,
            operation,
            cause,
          }),
      });
    const cleanup = runPresentationOperation("remove-window-close-listener", () => {
      if (!window.value.isDestroyed()) {
        window.value.removeListener("closed", cancelOnWindowClosed);
      }
    }).pipe(Effect.orDie, Effect.ensuring(removePending(pendingRef, requestId)), Effect.asVoid);
    const waitForPassword = Deferred.await(deferred).pipe(
      Effect.timeoutOption(Duration.millis(passwordPromptTimeoutMs)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new DesktopSshPromptTimedOutError({
                requestId,
                destination: input.destination,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    const preferSubmittedPassword = (error: DesktopSshPasswordPromptRequestError) =>
      Deferred.poll(deferred).pipe(
        Effect.flatMap(
          Option.match({
            onSome: (completion) => completion,
            onNone: () =>
              Ref.get(pendingRef).pipe(
                Effect.flatMap((entries) =>
                  entries.has(requestId) ? Effect.fail(error) : Deferred.await(deferred),
                ),
              ),
          }),
        ),
      );

    return yield* Effect.gen(function* () {
      const unavailableBeforePresentation = yield* runPresentationOperation(
        "check-window-before-presentation",
        () => window.value.isDestroyed(),
      );
      if (unavailableBeforePresentation) {
        return yield* new DesktopSshPromptWindowUnavailableError({
          destination: input.destination,
          requestId,
          stage: "before-presentation",
        });
      }
      yield* runPresentationOperation("register-window-close-listener", () =>
        window.value.once("closed", cancelOnWindowClosed),
      );
      return yield* Effect.gen(function* () {
        yield* runPresentationOperation("send-prompt-request", () =>
          window.value.webContents.send(SSH_PASSWORD_PROMPT_CHANNEL, promptRequest),
        );
        yield* Effect.yieldNow;
        const unavailableAfterSend = yield* runPresentationOperation(
          "check-window-after-send",
          () => window.value.isDestroyed(),
        );
        if (unavailableAfterSend) {
          return yield* new DesktopSshPromptWindowUnavailableError({
            destination: input.destination,
            requestId,
            stage: "after-send",
          });
        }
        const minimized = yield* runPresentationOperation("check-window-minimized", () =>
          window.value.isMinimized(),
        );
        if (minimized) {
          yield* runPresentationOperation("restore-window", () => window.value.restore());
        }
        const unavailableAfterRestore = yield* runPresentationOperation(
          "check-window-after-restore",
          () => window.value.isDestroyed(),
        );
        if (unavailableAfterRestore) {
          return yield* new DesktopSshPromptWindowUnavailableError({
            destination: input.destination,
            requestId,
            stage: "after-restore",
          });
        }
        yield* runPresentationOperation("focus-window", () => window.value.focus());
        return yield* waitForPassword;
      }).pipe(Effect.catch(preferSubmittedPassword));
    }).pipe(Effect.ensuring(cleanup));
  });

  return DesktopSshPasswordPrompts.of({
    request,
    resolve,
  });
});

export const layer = (options: DesktopSshPasswordPromptsOptions = {}) =>
  Layer.effect(DesktopSshPasswordPrompts, make(options));
