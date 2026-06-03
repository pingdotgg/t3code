import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Clank from "../Util/Clank.ts";
import { AuthError } from "./AuthProvider.ts";

export const getEnv = (key: string) =>
  Config.string(key).pipe(Effect.orElseSucceed(() => undefined));

export const getEnvRequired = (key: string) =>
  Config.string(key).pipe(
    Effect.catch(() =>
      Effect.fail(new AuthError({ message: `Missing required env: ${key}` })),
    ),
  );

export const getEnvRedacted = (key: string) =>
  Config.redacted(key).pipe(Effect.orElseSucceed(() => undefined));

export const getEnvRedactedRequired = (key: string) =>
  Config.redacted(key).pipe(
    Effect.catch(() =>
      Effect.fail(new AuthError({ message: `Missing required env: ${key}` })),
    ),
  );

export const retryOnce = <A, R>(
  self: Effect.Effect<A, Clank.PromptCancelled, R>,
) =>
  self.pipe(
    Effect.retry({
      times: 1,
      while: (e) => e instanceof Clank.PromptCancelled,
    }),
    Effect.mapError(
      (e) => new AuthError({ message: "User cancelled prompt", cause: e }),
    ),
  );
