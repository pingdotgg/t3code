import { isGitHubAttachmentUrl } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";

const GITHUB_HOST = "github.com";
const TOKEN_CACHE_TTL_MS = Duration.toMillis(Duration.minutes(5));
const RESOLVE_TIMEOUT = Duration.seconds(15);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Turns a GitHub upload link into the time-limited download GitHub answers a
 * signed-in reader with. Only the redirect target is read; the bytes go from
 * GitHub's storage straight to the client.
 */
export class GitHubAttachmentResolver extends Context.Service<
  GitHubAttachmentResolver,
  {
    /** The signed download URL, or `null` when GitHub refuses or answers with a page. */
    readonly resolve: (url: string) => Effect.Effect<string | null>;
  }
>()("t3/assets/GitHubAttachmentResolver") {}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const github = yield* GitHubCli.GitHubCli;
  const httpClient = yield* HttpClient.HttpClient;

  // `gh` owns the credential, so login state and GH_TOKEN keep working as they do for
  // every other GitHub call. A found token is cached so a body full of screenshots
  // does not spawn one process per image; a missing one is not, so `gh auth login`
  // takes effect on the next image. Without a token the request goes out
  // anonymously, which is what a public repository needs and what a private one
  // already failed with.
  const tokenCache = yield* Ref.make<{ token: string; expiresAt: number } | null>(null);
  const tokenLookup = yield* Semaphore.make(1);
  const token = tokenLookup.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = yield* Ref.get(tokenCache);
      if (cached !== null && cached.expiresAt > now) return cached.token;
      const found = yield* github
        .execute({ cwd: config.stateDir, args: ["auth", "token", "--hostname", GITHUB_HOST] })
        .pipe(
          Effect.map((output) => output.stdout.trim() || null),
          Effect.orElseSucceed(() => null),
        );
      if (found !== null) {
        yield* Ref.set(tokenCache, { token: found, expiresAt: now + TOKEN_CACHE_TTL_MS });
      }
      return found;
    }),
  );

  const resolve = Effect.fn("GitHubAttachmentResolver.resolve")(function* (url: string) {
    // The claims were signed from a checked resource, but the credential goes on the
    // wire here, so this is where the allowlist is enforced.
    if (!isGitHubAttachmentUrl(url)) return null;
    const authorization = yield* token;
    // Read outward from `get`: the request runs with `redirect: "manual"`, so the
    // signed target on another host is reported, not followed, and never downloaded.
    return yield* httpClient
      .get(url, {
        headers: authorization === null ? {} : { authorization: `token ${authorization}` },
      })
      .pipe(
        Effect.map((response) => {
          const location = response.headers.location?.trim();
          return REDIRECT_STATUSES.has(response.status) &&
            location !== undefined &&
            isHttpsUrl(location)
            ? location
            : null;
        }),
        Effect.scoped,
        Effect.timeoutOption(RESOLVE_TIMEOUT),
        Effect.map(Option.getOrNull),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to resolve a GitHub attachment.", { url, cause }),
        ),
        Effect.orElseSucceed(() => null),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      );
  });

  return GitHubAttachmentResolver.of({ resolve });
});

export const layer = Layer.effect(GitHubAttachmentResolver, make);
