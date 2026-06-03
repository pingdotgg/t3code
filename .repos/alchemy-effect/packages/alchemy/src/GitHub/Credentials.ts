import { Octokit } from "@octokit/rest";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AuthError, getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, Profile } from "../Auth/Profile.ts";
import {
  GITHUB_AUTH_PROVIDER_NAME,
  type GitHubAuthConfig,
  type GitHubResolvedCredentials,
} from "./AuthProvider.ts";

export interface GitHubCredentialsService {
  readonly token: Redacted.Redacted<string>;
  readonly octokit: () => Octokit;
}

export class GitHubCredentials extends Context.Service<
  GitHubCredentials,
  GitHubCredentialsService
>()("GitHub::Credentials") {}

const make = (token: Redacted.Redacted<string>): GitHubCredentialsService => ({
  token,
  octokit: () => new Octokit({ auth: Redacted.value(token) }),
});

/**
 * Build a `GitHubCredentials` layer from a literal token. Useful for
 * tests or when callers already have a PAT in hand.
 */
export const fromToken = (token: string | Redacted.Redacted<string>) =>
  Layer.succeed(
    GitHubCredentials,
    make(typeof token === "string" ? Redacted.make(token) : token),
  );

/**
 * Build a `GitHubCredentials` layer that reads the token from
 * `GITHUB_ACCESS_TOKEN` or `GITHUB_TOKEN` at layer build time.
 */
export const fromEnv = () =>
  Layer.effect(
    GitHubCredentials,
    Effect.gen(function* () {
      const access = yield* Config.redacted("GITHUB_ACCESS_TOKEN").pipe(
        Config.option,
      );
      const token = yield* Config.redacted("GITHUB_TOKEN").pipe(Config.option);
      const value =
        access._tag === "Some"
          ? access.value
          : token._tag === "Some"
            ? token.value
            : undefined;
      if (value == null) {
        return yield* new AuthError({
          message:
            "GitHub credentials not found. Set GITHUB_ACCESS_TOKEN or GITHUB_TOKEN.",
        });
      }
      return make(value);
    }).pipe(Effect.orDie),
  );

/**
 * Build a `GitHubCredentials` layer that resolves a token via the
 * Alchemy AuthProvider for the configured profile (defaults to
 * `default`, overridable with `ALCHEMY_PROFILE`).
 */
export const fromAuthProvider = () =>
  Layer.effect(
    GitHubCredentials,
    Effect.gen(function* () {
      const profile = yield* Profile;
      const auth = yield* getAuthProvider<
        GitHubAuthConfig,
        GitHubResolvedCredentials
      >(GITHUB_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as GitHubAuthConfig),
        ),
        Effect.map((creds) => make(creds.token)),
        Effect.mapError(
          (e) =>
            new AuthError({
              message: `Failed to resolve GitHub credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
      );
    }).pipe(Effect.orDie),
  );
