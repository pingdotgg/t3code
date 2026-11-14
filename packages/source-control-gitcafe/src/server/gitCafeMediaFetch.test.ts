import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitCafeCredentials from "./GitCafeCredentials.ts";
import * as GitCafeMediaFetch from "./gitCafeMediaFetch.ts";

const ATTACHMENT = "https://git.cafe/api/attachments/attach_01m6hzm1mhene8zncba8bn5fb2";

const signedIn = (signedInAfter = 0, invalidated: Array<string> = []) => {
  let lookups = 0;
  return Layer.mock(GitCafeCredentials.GitCafeCredentials)({
    get: (host) =>
      ++lookups <= signedInAfter
        ? Effect.fail(new GitCafeCredentials.GitCafeNotSignedInError({ host }))
        : Effect.succeed({ host, token: Redacted.make("cafe-token"), source: "cafe" as const }),
    invalidate: (host) => Effect.sync(() => void invalidated.push(host)),
  });
};

describe("GitCafeMediaFetch", () => {
  it.effect("loads a private repository's attachment with the viewer's token", () => {
    const sent: Array<[string, string | undefined]> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* GitCafeMediaFetch.make;
      // Signed out reads the attachment anonymously, which a private repository refuses.
      expect((yield* fetchMedia({ url: ATTACHMENT, headers: {} }))?.status).toBe(404);
      const response = yield* fetchMedia({ url: ATTACHMENT, headers: { range: "bytes=0-1" } });
      expect(response?.status).toBe(200);
      expect(response?.headers["content-type"]).toBe("image/png");
      expect(sent).toEqual([
        [ATTACHMENT, undefined],
        [ATTACHMENT, "Bearer cafe-token"],
      ]);
    }).pipe(
      Effect.provide(signedIn(1)),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          sent.push([request.url, request.headers.authorization]);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.headers.authorization === "Bearer cafe-token"
                ? new Response("png", { status: 200, headers: { "content-type": "image/png" } })
                : new Response(null, {
                    status: 404,
                    headers: { "content-type": "application/problem+json" },
                  }),
            ),
          );
        }),
      ),
      Effect.scoped,
    );
  });

  it.effect("keeps the token off storage a redirect hands the attachment to", () => {
    const sent: Array<[string, string | undefined]> = [];
    const invalidated: Array<string> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* GitCafeMediaFetch.make;
      expect((yield* fetchMedia({ url: ATTACHMENT, headers: {} }))?.status).toBe(401);
      expect(sent).toEqual([
        ["git.cafe", "Bearer cafe-token"],
        ["objects.example.com", undefined],
      ]);
      // Storage refusing its own signature says nothing about the GitCafe token.
      expect(invalidated).toEqual([]);
    }).pipe(
      Effect.provide(signedIn(0, invalidated)),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const url = new URL(request.url);
          sent.push([url.hostname, request.headers.authorization]);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              url.hostname === "git.cafe"
                ? new Response(null, {
                    status: 302,
                    headers: { location: "https://objects.example.com/signed" },
                  })
                : new Response(null, { status: 401 }),
            ),
          );
        }),
      ),
      Effect.scoped,
    );
  });
});
