import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Interaction from "../Interaction.ts";
import { AuthError } from "./AuthProvider.ts";

export const getEnv = (key: string) =>
  Config.option(Config.String(key)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError(
      (cause) =>
        new AuthError({
          message: `Could not read optional env: ${key}`,
          cause,
        }),
    ),
  );

export const getEnvRequired = (key: string) =>
  Config.String(key).pipe(
    Effect.mapError(
      (cause) =>
        new AuthError({ message: `Missing required env: ${key}`, cause }),
    ),
  );

export const getEnvRedacted = (key: string) =>
  Config.option(Config.Redacted(key)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError(
      (cause) =>
        new AuthError({
          message: `Could not read optional env: ${key}`,
          cause,
        }),
    ),
  );

export const getEnvRedactedRequired = (key: string) =>
  Config.Redacted(key).pipe(
    Effect.mapError(
      (cause) =>
        new AuthError({ message: `Missing required env: ${key}`, cause }),
    ),
  );

export const mapPromptCancellation = <A, R>(
  self: Effect.Effect<A, Interaction.InteractionError, R>,
) =>
  self.pipe(
    Effect.mapError(
      (cause) =>
        new AuthError({
          message:
            cause._tag === "TerminalCancelled"
              ? "User cancelled prompt"
              : cause.message,
          cause,
        }),
    ),
  );
