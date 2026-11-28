import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as GitLabMediaFetch from "./gitLabMediaFetch.ts";

const AVATAR = "https://git.example.test/uploads/-/system/user/avatar/857/avatar.png";

const httpLayer = (onRequest: (request: HttpClientRequest.HttpClientRequest) => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => HttpClientResponse.fromWeb(request, onRequest(request))),
    ),
  );

it.effect("loads an uploaded avatar over HTTP and never sends a GitLab token", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const requests: Array<{ url: string; authorization?: string }> = [];
  return Effect.gen(function* () {
    const fetchMedia = yield* GitLabMediaFetch.make;
    const url = `${AVATAR}?v=1`;
    const response = yield* fetchMedia({ url, headers: {} });
    expect(requests).toEqual([{ url }]);
    expect(response?.status).toBe(200);
    expect(new Uint8Array(yield* response!.arrayBuffer)).toEqual(png);
  }).pipe(
    Effect.provide(
      httpLayer((request) => {
        requests.push({
          url: request.url,
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
        });
        return new Response(png, { headers: { "content-type": "image/png" } });
      }),
    ),
  );
});

it.effect("returns nothing when the host answers with a sign-in page", () =>
  Effect.gen(function* () {
    const fetchMedia = yield* GitLabMediaFetch.make;
    const response = yield* fetchMedia({ url: AVATAR, headers: {} });
    expect(response).toBeNull();
  }).pipe(
    Effect.provide(
      httpLayer(
        () =>
          new Response("<html>Sign in</html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      ),
    ),
  ),
);

it.effect("does not fetch an avatar from a loopback or link-local address", () => {
  const requests: string[] = [];
  return Effect.gen(function* () {
    const fetchMedia = yield* GitLabMediaFetch.make;
    expect(
      yield* fetchMedia({
        url: "http://169.254.169.254/uploads/-/system/user/avatar/857/avatar.png",
        headers: {},
      }),
    ).toBeNull();
    expect(requests).toEqual([]);
  }).pipe(
    Effect.provide(
      httpLayer((request) => {
        requests.push(request.url);
        return new Response(null, { status: 500 });
      }),
    ),
  );
});

it.effect("does not follow an avatar redirect onto a loopback or link-local address", () => {
  const requests: string[] = [];
  const internal = "https://169.254.169.254/uploads/-/system/user/avatar/857/avatar.png";
  return Effect.gen(function* () {
    const fetchMedia = yield* GitLabMediaFetch.make;
    expect(yield* fetchMedia({ url: AVATAR, headers: {} })).toBeNull();
    expect(requests).toEqual([AVATAR]);
  }).pipe(
    Effect.provide(
      httpLayer((request) => {
        requests.push(request.url);
        return new Response(null, { status: 302, headers: { location: internal } });
      }),
    ),
  );
});
