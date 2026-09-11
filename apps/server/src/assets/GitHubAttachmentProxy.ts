import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";

/** `gh auth token` spawns a process; one cached read serves a whole page of images. */
const TOKEN_CACHE_TTL = "5 minutes";

/**
 * Resolves GitHub `user-attachments` uploads, which GitHub serves only to an authenticated
 * viewer, into their signed-storage redirect targets using the developer's `gh` credentials.
 * Only the redirect is resolved here — the bytes never pass through the server, and the token
 * never leaves it. Without a token the request still goes out: public-repository uploads
 * redirect anonymously.
 */
export class GitHubAttachmentProxy extends Context.Service<
  GitHubAttachmentProxy,
  {
    /** `null` on any failure; the route answers 404 and the client shows its fallback. */
    readonly resolveAttachmentLocation: (url: string) => Effect.Effect<string | null>;
  }
>()("t3/assets/GitHubAttachmentProxy") {}

const make = Effect.gen(function* () {
  const gitHubCli = yield* GitHubCli.GitHubCli;
  const httpClient = yield* HttpClient.HttpClient;

  const readToken = yield* Effect.cachedWithTTL(
    gitHubCli
      // `auth token` ignores the cwd; the home directory always exists.
      .execute({ cwd: NodeOS.homedir(), args: ["auth", "token", "--hostname", "github.com"] })
      .pipe(
        Effect.map((output) => output.stdout.trim() || null),
        Effect.orElseSucceed(() => null),
      ),
    TOKEN_CACHE_TTL,
  );

  const resolveAttachmentLocation = (url: string) =>
    Effect.gen(function* () {
      const token = yield* readToken;
      const request = HttpClientRequest.get(url, {
        headers: token === null ? {} : { authorization: `token ${token}` },
      });
      // Scoped so the unread body is aborted on exit instead of holding the connection.
      const response = yield* HttpClient.withScope(httpClient)
        .execute(request)
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      if (response.status < 300 || response.status >= 400) return null;
      const location = response.headers["location"];
      return location !== undefined && location.startsWith("https://") ? location : null;
    }).pipe(
      Effect.scoped,
      Effect.tapError((cause) =>
        Effect.logWarning("Failed to resolve a GitHub attachment.", { url, cause }),
      ),
      Effect.orElseSucceed(() => null),
    );

  return { resolveAttachmentLocation } satisfies GitHubAttachmentProxy["Service"];
});

export const layer = Layer.effect(GitHubAttachmentProxy, make);
