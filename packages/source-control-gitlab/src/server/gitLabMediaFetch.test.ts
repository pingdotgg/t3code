import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitLabMediaFetch from "./gitLabMediaFetch.ts";

it.effect("loads an uploaded avatar over HTTP and never sends a GitLab token", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const requests: Array<{ url: string; authorization?: string }> = [];
  return Effect.gen(function* () {
    const fetchMedia = yield* GitLabMediaFetch.make;
    const url = "https://git.example.test/uploads/-/system/user/avatar/857/avatar.png?v=1";
    const response = yield* fetchMedia({ url, headers: {} });
    expect(requests).toEqual([{ url }]);
    expect(response?.status).toBe(200);
    expect(new Uint8Array(yield* response!.arrayBuffer)).toEqual(png);
  }).pipe(
    Effect.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push({
              url: request.url,
              ...(request.headers.authorization
                ? { authorization: request.headers.authorization }
                : {}),
            });
            return HttpClientResponse.fromWeb(
              request,
              new Response(png, { headers: { "content-type": "image/png" } }),
            );
          }),
        ),
      ),
    ),
  );
});

it.effect("returns nothing when the host answers with a sign-in page", () =>
  Effect.gen(function* () {
    const fetchMedia = yield* GitLabMediaFetch.make;
    const response = yield* fetchMedia({
      url: "https://git.example.test/uploads/-/system/user/avatar/857/avatar.png",
      headers: {},
    });
    expect(response).toBeNull();
  }).pipe(
    Effect.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() =>
            HttpClientResponse.fromWeb(
              request,
              new Response("<html>Sign in</html>", {
                status: 200,
                headers: { "content-type": "text/html; charset=utf-8" },
              }),
            ),
          ),
        ),
      ),
    ),
  ),
);
