import {
  type SourceControlAppAccess,
  type SourceControlAppAccessInput,
  SourceControlSignInError,
  type SourceControlSignInInput,
  type SourceControlSignInPrompt,
  type SourceControlSignInResult,
  type SourceControlStarredInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SourceControlBuiltInDrivers from "./builtInDrivers.ts";

/** Signs the server in to a forge through the forge's own app, and reads what its account did. */
export class SourceControlSignIn extends Context.Service<
  SourceControlSignIn,
  {
    readonly start: (
      input: SourceControlSignInInput,
    ) => Effect.Effect<SourceControlSignInPrompt, SourceControlSignInError>;
    readonly wait: (
      input: SourceControlSignInInput,
    ) => Effect.Effect<SourceControlSignInResult, SourceControlSignInError>;
    readonly cancel: (
      input: SourceControlSignInInput,
    ) => Effect.Effect<void, SourceControlSignInError>;
    readonly access: (input: SourceControlAppAccessInput) => Effect.Effect<SourceControlAppAccess>;
    readonly starred: (input: SourceControlStarredInput) => Effect.Effect<boolean>;
  }
>()("t3/sourceControl/SourceControlSignIn") {}

const make = Effect.gen(function* () {
  const drivers = yield* SourceControlBuiltInDrivers.SourceControlDrivers;

  const signInFor = (input: SourceControlSignInInput) => {
    const signIn = drivers.find(({ driver }) => driver.kind === input.provider)?.instance.signIn;
    return signIn === undefined
      ? Effect.fail(
          new SourceControlSignInError({
            provider: input.provider,
            host: input.host,
            reason: "unsupported",
            detail: `This server cannot sign in to ${input.provider}. Use a token or the host's CLI.`,
          }),
        )
      : Effect.succeed(signIn);
  };

  return SourceControlSignIn.of({
    start: Effect.fn("SourceControlSignIn.start")(function* (input) {
      return yield* (yield* signInFor(input)).start(input.host);
    }),
    wait: Effect.fn("SourceControlSignIn.wait")(function* (input) {
      return yield* (yield* signInFor(input)).wait(input.host);
    }),
    cancel: Effect.fn("SourceControlSignIn.cancel")(function* (input) {
      return yield* (yield* signInFor(input)).cancel(input.host);
    }),
    access: Effect.fn("SourceControlSignIn.access")(function* (input) {
      const signIn = drivers.find(({ driver }) => driver.kind === input.provider)?.instance.signIn;
      return {
        status:
          signIn === undefined ? "signed-out" : yield* signIn.access(input.host, input.repository),
      } satisfies SourceControlAppAccess;
    }),
    starred: Effect.fn("SourceControlSignIn.starred")(function* (input) {
      const isStarred = drivers.find(({ driver }) => driver.kind === input.provider)?.instance
        .isRepositoryStarred;
      return isStarred === undefined ? false : yield* isStarred(input.host, input.repository);
    }),
  });
});

export const layer = Layer.effect(SourceControlSignIn, make);
