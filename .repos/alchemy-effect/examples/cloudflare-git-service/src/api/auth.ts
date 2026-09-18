/**
 * Who a user is. Better Auth holds the users, their sessions (browsers),
 * and their API keys (`git` clients, `gh`); the engine holds none of it.
 */
import { BetterAuth } from "@alchemy.run/better-auth";
import { apiKey } from "@better-auth/api-key";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

/** Better Auth's users, sessions, and API keys. */
export const AuthDb = Cloudflare.D1.Database("AuthDb");

/** Better Auth, yielded wherever it is needed; the engine de-dupes the declaration. */
export const Auth = BetterAuth({
  basePath: "/api/auth",
  emailAndPassword: { enabled: true },
  plugins: [apiKey()],
});

/** The user record routes see. */
export const User = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
});

/** 401 — no usable credential, on a route that needs one. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {},
  { httpApiStatus: 401 },
) {}

/**
 * Who is calling: the signed-in user, or `null` on an anonymous read of
 * a public repository. Every route runs with it in context.
 */
export class Session extends Context.Service<
  Session,
  { readonly user: typeof User.Type | null }
>()("app/Session") {}
