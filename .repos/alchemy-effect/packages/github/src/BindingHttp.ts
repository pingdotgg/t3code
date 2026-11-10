import type { GithubOpContext } from "@distilled.cloud/github";
import { Credentials } from "@distilled.cloud/github/Credentials";
import { Self } from "alchemy/Self";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { normalizeGitHubBaseUrl } from "./BaseUrl.ts";
import { config } from "./Credentials.ts";
import { PersonalAccessToken } from "./PersonalAccessToken.ts";
import type { Repository } from "./Repository.ts";

/**
 * Shared scaffolding for the GitHub `*Http` and `*Local` binding layers.
 *
 * Each binding declares its distilled call once with {@link operation}.
 * `make` runs it with a {@link PersonalAccessToken} bound into the host (one
 * token resource per host, shared by every GitHub binding on it);
 * `BindingLocal.make` runs it with the provider's current credentials.
 *
 * NOT exported from `index.ts`.
 */

/** The bound repository, as an operation sees it. */
export interface BoundRepository {
  readonly owner: string;
  readonly repository: string;
}

/**
 * One distilled call, implemented by both the `*Http` and `*Local` layers.
 * `name` names the span (`GitHub.issues.get`).
 */
export interface Operation<Request extends ReadonlyArray<any>, Out, E> {
  readonly name: string;
  readonly call: (
    repo: BoundRepository,
  ) => (...request: Request) => Effect.Effect<Out, E, GithubOpContext>;
}

export const operation = <Request extends ReadonlyArray<any>, Out, E>(
  name: string,
  call: Operation<Request, Out, E>["call"],
): Operation<Request, Out, E> => ({ name, call });

/** Where a client's calls authenticate: a token and the REST API base URL. */
export interface TokenSource {
  readonly token: Effect.Effect<Redacted.Redacted<string>>;
  readonly apiUrl: Effect.Effect<string | undefined>;
}

/**
 * Bind a repository and return the runtime client for `op`. The repository's
 * `fullName` is bound into the host, so the client resolves it at runtime.
 */
export const makeOperationClient = <Request extends ReadonlyArray<any>, Out, E>(
  op: Operation<Request, Out, E>,
  source: TokenSource,
) =>
  Effect.fn(function* (repo: Repository) {
    const fullName = yield* repo.fullName;
    // A per-repository `baseUrl` prop wins over the token's host.
    const repoBaseUrl =
      typeof repo.Props?.baseUrl === "string"
        ? yield* normalizeGitHubBaseUrl(repo.Props.baseUrl).pipe(Effect.orDie)
        : undefined;
    // Credentials resolve per request, so the bound token is read at runtime.
    const github = Layer.mergeAll(
      Layer.succeed(
        Credentials,
        Effect.all([source.token, source.apiUrl]).pipe(
          Effect.map(([token, apiUrl]) => config(token, repoBaseUrl ?? apiUrl)),
        ),
      ),
      FetchHttpClient.layer,
    );
    return Effect.fn(`GitHub.${op.name}`)(function* (...request: Request) {
      const [owner, repository] = (yield* fullName).split("/") as [string, string];
      return yield* op
        .call({ owner, repository })(...request)
        .pipe(Effect.provide(github));
    });
  });

/**
 * The token-backed implementation of a GitHub binding. Pass it to
 * `Layer.effect(Tag, BindingHttp.make(op))`.
 */
export const make = <Request extends ReadonlyArray<any>, Out, E>(op: Operation<Request, Out, E>) =>
  Effect.gen(function* () {
    const Token = yield* PersonalAccessToken;
    const self = yield* Self;
    const token = yield* Token(`${self.LogicalId}GitHubToken`);
    return makeOperationClient(op, {
      token: yield* token.value,
      apiUrl: yield* token.apiUrl,
    });
  });
