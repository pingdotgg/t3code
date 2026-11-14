import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitLabCredentials from "./GitLabCredentials.ts";
import * as GitLabMediaFetch from "./gitLabMediaFetch.ts";

const SECRET = "66dbcd21ec5d24ed6ea225176098d52b";
const UPLOAD = `https://gitlab.example.com/group/app/uploads/${SECRET}/shot.png`;
const API = `https://gitlab.example.com/api/v4/projects/group%2Fapp/uploads/${SECRET}/shot.png`;

/** A GitLab that answers `respond`, with `token` as the stored `glab` login. */
function fetchWith(
  token: string | null,
  respond: (url: string, authorization: string | undefined) => Response,
  url = UPLOAD,
) {
  const requests: Array<[string, string | undefined]> = [];
  const invalidated: Array<string> = [];
  const layer = Layer.merge(
    Layer.mock(GitLabCredentials.GitLabCredentials)({
      get: () => Effect.succeed(Option.fromNullishOr(token).pipe(Option.map(Redacted.make))),
      invalidate: (host) => Effect.sync(() => void invalidated.push(host)),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push([request.url, request.headers.authorization]);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, respond(request.url, request.headers.authorization)),
        );
      }),
    ),
  );
  const status = Effect.gen(function* () {
    const fetchMedia = yield* GitLabMediaFetch.make;
    return (yield* fetchMedia({ url, headers: {} }))?.status;
  }).pipe(Effect.provide(layer), Effect.scoped);
  return { status, requests, invalidated };
}

describe("GitLabMediaFetch", () => {
  it.effect("reads the upload through the API with the glab login for its host", () => {
    const { status, requests } = fetchWith("stored", () => new Response(null, { status: 200 }));
    return Effect.gen(function* () {
      expect(yield* status).toBe(200);
      expect(requests).toEqual([[API, "Bearer stored"]]);
    });
  });

  it.effect("keeps the token off the object store a redirect hands the upload to", () => {
    const { status, requests } = fetchWith("stored", (url) =>
      url === API
        ? new Response(null, { status: 302, headers: { location: "https://objects.example/s" } })
        : new Response(null, { status: 200 }),
    );
    return Effect.gen(function* () {
      expect(yield* status).toBe(200);
      expect(requests).toEqual([
        [API, "Bearer stored"],
        ["https://objects.example/s", undefined],
      ]);
    });
  });

  it.effect("loads a gitlab.com upload without a login, as a public project serves it", () => {
    const upload = `https://gitlab.com/group/app/uploads/${SECRET}/shot.png`;
    const { status, requests } = fetchWith(null, () => new Response(null, { status: 200 }), upload);
    return Effect.gen(function* () {
      expect(yield* status).toBe(200);
      expect(requests).toEqual([[upload, undefined]]);
    });
  });

  it.effect("asks no host that glab is not signed in to", () => {
    const { status, requests } = fetchWith(null, () => new Response(null, { status: 200 }));
    return Effect.gen(function* () {
      expect(yield* status).toBeUndefined();
      expect(requests).toEqual([]);
    });
  });

  it.effect("drops a refused token and falls back to the upload itself", () => {
    const { status, requests, invalidated } = fetchWith(
      "revoked",
      (url) => new Response(null, { status: url === API ? 401 : 200 }),
    );
    return Effect.gen(function* () {
      expect(yield* status).toBe(200);
      expect(requests).toEqual([
        [API, "Bearer revoked"],
        [UPLOAD, undefined],
      ]);
      expect(invalidated).toEqual(["gitlab.example.com"]);
    });
  });
});
