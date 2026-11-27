import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Interaction from "../Interaction.ts";
import { AuthError } from "./AuthProvider.ts";

export const getEnv = (key: string) =>
  Config.option(Config.String(key)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError((cause) =>
      AuthError.make({
        message: `Could not read optional env: ${key}`,
        cause,
      }),
    ),
  );

export const getEnvRequired = (key: string) =>
  Config.String(key).pipe(
    Effect.mapError((cause) => AuthError.make({ message: `Missing required env: ${key}`, cause })),
  );

export const getEnvRedacted = (key: string) =>
  Config.option(Config.Redacted(key)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError((cause) =>
      AuthError.make({
        message: `Could not read optional env: ${key}`,
        cause,
      }),
    ),
  );

export const getEnvRedactedRequired = (key: string) =>
  Config.Redacted(key).pipe(
    Effect.mapError((cause) => AuthError.make({ message: `Missing required env: ${key}`, cause })),
  );

/** Turn a cancelled or unavailable prompt into an `AuthError`; other errors pass through. */
export const mapPromptCancellation = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchIf(
      (cause): cause is Extract<E, Interaction.InteractionError> =>
        cause instanceof Interaction.TerminalCancelled ||
        cause instanceof Interaction.NonInteractiveTerminal,
      (cause) =>
        Effect.fail(
          AuthError.make({
            message: cause._tag === "TerminalCancelled" ? "User cancelled prompt" : cause.message,
            cause,
          }),
        ),
    ),
  );
