import * as Users from "@distilled.cloud/github/users";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { Credentials, config } from "./Credentials.ts";
import type * as GitHub from "./Providers.ts";

export interface PersonalAccessTokenProps {
  /**
   * The token to capture. Defaults to the provider's credential (the token
   * `alchemy login` or `GITHUB_TOKEN` resolves).
   */
  token?: Redacted.Redacted<string>;
}

export interface PersonalAccessToken extends Resource<
  "GitHub.PersonalAccessToken",
  PersonalAccessTokenProps,
  {
    /** The token value. Yield it inside a host to bind it into the host's environment. */
    value: Redacted.Redacted<string>;
    /** REST API base URL the token authenticates against. */
    apiUrl: string;
    /** The login the token authenticates as. */
    login: string;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub token captured as a resource, so a Worker or Function can
 * authenticate with it at runtime.
 *
 * GitHub has no API to mint personal access tokens, so this resource does not
 * create one. It captures a token (the `token` prop, or the provider's
 * credential by default), validates it, and stores it in state. The `GitHub.*Http`
 * binding layers capture one per host and bind its `value` into the host.
 * Deleting the resource only forgets the token; revoking it stays a manual step.
 *
 * ### Capturing a Token
 * **Example:** The provider's credential
 * ```typescript
 * const token = yield* GitHub.PersonalAccessToken("BotToken");
 * ```
 *
 * **Example:** An explicit token
 * ```typescript
 * const token = yield* GitHub.PersonalAccessToken("BotToken", {
 *   token: Redacted.make(process.env.BOT_GITHUB_TOKEN!),
 * });
 * ```
 *
 * @resource
 * @product Repository
 */
export const PersonalAccessToken = Resource<PersonalAccessToken>("GitHub.PersonalAccessToken");

/** Read the login the token authenticates as. */
const validate = (token: Redacted.Redacted<string>, apiUrl: string) =>
  Users.getAuthenticated({}).pipe(
    Effect.map((user) => ({ login: user.login })),
    Effect.provideService(Credentials, Effect.succeed(config(token, apiUrl))),
  );

export const PersonalAccessTokenProvider = () =>
  Provider.succeed(PersonalAccessToken, {
    stables: ["value", "apiUrl", "login"],
    // GitHub cannot enumerate personal access tokens.
    list: () => Effect.succeed([]),
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      // A token revoked out-of-band reads as gone, so the next deploy
      // captures a working one.
      const probe = yield* validate(output.value, output.apiUrl).pipe(Effect.result);
      return Result.isSuccess(probe) ? { ...output, ...probe.success } : undefined;
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const credentials = yield* yield* Credentials;
      const token = news?.token ?? credentials.token;
      const apiUrl = credentials.apiBaseUrl;
      const { login } = yield* validate(token, apiUrl);
      return { value: token, apiUrl, login };
    }),
    delete: () => Effect.void,
  });
