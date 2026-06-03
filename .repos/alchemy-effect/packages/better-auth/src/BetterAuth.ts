import type { RuntimeContext } from "alchemy";
import type { HttpEffect } from "alchemy/Http";
import { type Auth } from "better-auth";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export class BetterAuth extends Context.Service<
  BetterAuth,
  {
    auth: Effect.Effect<Auth<any>, never, RuntimeContext>;
    fetch: HttpEffect<RuntimeContext>;
  }
>()("BetterAuth") {}
