import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoMediaFetch from "./forgejoMediaFetch.ts";

const request = {
  url: "http://git.example.test:3000/team/repo/raw/branch/main/shot.png",
  headers: {},
};

describe("ForgejoMediaFetch", () => {
  it.effect("reads a private file with the token its login holds", () => {
    const authorizations: Array<string | undefined> = [];
    let lookups = 0;
    return Effect.gen(function* () {
      const fetchMedia = yield* ForgejoMediaFetch.make;
      expect((yield* fetchMedia(request))?.status).toBe(404);
      expect((yield* fetchMedia(request))?.status).toBe(200);
      expect(authorizations).toEqual([undefined, "token secret"]);
    }).pipe(
      Effect.provide(
        Layer.mock(ForgejoCli.ForgejoCli)({
          mediaToken: (host) =>
            Effect.succeed(host === "git.example.test:3000" && ++lookups > 1 ? "secret" : null),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          authorizations.push(request.headers.authorization);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: request.headers.authorization ? 200 : 404,
                headers: { "content-type": "image/png" },
              }),
            ),
          );
        }),
      ),
      Effect.scoped,
    );
  });

  it.effect("keeps the token off the object store a redirect hands the media to", () => {
    const authorizations: Array<[string, string | undefined]> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* ForgejoMediaFetch.make;
      const response = yield* fetchMedia({ ...request, headers: { range: "bytes=0-1" } });
      expect(response?.status).toBe(200);
      expect(authorizations).toEqual([
        ["git.example.test:3000", "token secret"],
        ["objects.example.test", undefined],
      ]);
    }).pipe(
      Effect.provide(
        Layer.mock(ForgejoCli.ForgejoCli)({
          mediaToken: () => Effect.succeed("secret"),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const url = new URL(request.url);
          authorizations.push([url.host, request.headers.authorization]);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              url.host === "git.example.test:3000"
                ? new Response(null, {
                    status: 302,
                    headers: { location: "http://objects.example.test/signed" },
                  })
                : new Response(null, { status: 200 }),
            ),
          );
        }),
      ),
      Effect.scoped,
    );
  });
});
