import * as GitHub from "@alchemy.run/github";
import { Credentials, config } from "@alchemy.run/github/Credentials";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/**
 * Run distilled GitHub calls with the provider's credentials, outside a
 * provider test (out-of-band setup and verification).
 */
export const gh = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(GitHub.providers({ baseUrl: "github.com" })));

/**
 * Keep a provider's `list()` inside the test organization. GitHub's `list()`
 * walks every repository the token can see (`/user/repos`); this rewrites
 * that to `/orgs/{owner}/repos` and, with `only`, narrows the listing to one
 * fixture repository and refuses any request outside it.
 */
export const scopedToOwner =
  (owner: string, only?: { readonly repository: string; readonly path: string }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const orgRepos = `/orgs/${owner}/repos`;
      const scoped = client.pipe(
        HttpClient.mapRequest((request) => {
          const url = new URL(request.url);
          if (url.pathname !== "/user/repos") return request;
          url.pathname = orgRepos;
          return HttpClientRequest.setUrl(request, url.href);
        }),
        HttpClient.transform((response, request) => {
          if (only === undefined) return response;
          const url = new URL(request.url);
          const allowed = `/repos/${owner}/${only.repository}/${only.path}`;
          if (
            url.origin !== "https://api.github.com" ||
            (url.pathname !== orgRepos && url.pathname !== allowed)
          ) {
            return Effect.die(`Unsafe GitHub list request: ${url}`);
          }
          if (url.pathname !== orgRepos) return response;
          // Only the fixture repository, so enumeration stays on `allowed`.
          return Effect.flatMap(response, (res) =>
            Effect.map(res.json, (repos) =>
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify(
                    (repos as Array<{ name: string }>).filter(
                      (repo) => repo.name === only.repository,
                    ),
                  ),
                  { status: res.status, headers: { "content-type": "application/json" } },
                ),
              ),
            ),
          );
        }),
      );
      return yield* effect.pipe(Effect.provideService(HttpClient.HttpClient, scoped));
    });

/**
 * A fake GitHub for provider unit tests: the provider's credentials are a
 * dummy token and every request goes to `fetch` instead of the network.
 * Overrides the `Fetch` reference the stack's HTTP client reads per request
 * (the stack supplies its own `HttpClient`).
 */
export const mockGitHub = (
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) =>
  Layer.mergeAll(
    Layer.succeed(Credentials, Effect.succeed(config(Redacted.make("test-token"), undefined))),
    Layer.succeed(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch),
  );
