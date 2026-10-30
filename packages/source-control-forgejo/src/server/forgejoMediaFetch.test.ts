import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoMediaFetch from "./forgejoMediaFetch.ts";

const UPLOAD = "/attachments/8e603325-bb2b-4e32-a9bc-f1fa20b6c40b";

const fetchWith = (
  routes: Record<string, { readonly status: number; readonly location?: string }>,
  sent: Array<[string, string | undefined]>,
) =>
  Effect.provide(
    Layer.mergeAll(
      Layer.mock(ForgejoCli.ForgejoCli)({
        mediaToken: (url) =>
          Effect.succeed(new URL(url).origin === "https://git.example.test" ? "fj-token" : null),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const url = new URL(request.url);
          sent.push([url.host, request.headers.authorization]);
          const route = routes[url.href] ?? routes[url.host] ?? { status: 404 };
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: route.status,
                headers: route.location ? { location: route.location } : {},
              }),
            ),
          );
        }),
      ),
    ),
  );

describe("ForgejoMediaFetch", () => {
  it.effect("sends fj's token to its server and never to a redirect target", () => {
    const sent: Array<[string, string | undefined]> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* ForgejoMediaFetch.make;
      const response = yield* fetchMedia({
        url: `https://git.example.test${UPLOAD}`,
        headers: { range: "bytes=0-1" },
      });
      expect(response).toBeNull();
      expect(sent).toEqual([["git.example.test", "token fj-token"]]);
    }).pipe(
      fetchWith(
        {
          "git.example.test": { status: 302, location: `https://objects.example.test${UPLOAD}` },
          "objects.example.test": { status: 200 },
        },
        sent,
      ),
      Effect.scoped,
    );
  });

  it.effect("loads a same-origin redirect with the configured token", () => {
    const sent: Array<[string, string | undefined]> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* ForgejoMediaFetch.make;
      const response = yield* fetchMedia({
        url: `https://git.example.test${UPLOAD}`,
        headers: { range: "bytes=0-1" },
      });
      expect(response?.status).toBe(206);
      expect(response?.request.headers.range).toBe("bytes=0-1");
      expect(sent).toEqual([
        ["git.example.test", "token fj-token"],
        ["git.example.test", "token fj-token"],
      ]);
    }).pipe(
      fetchWith(
        {
          [`https://git.example.test${UPLOAD}`]: { status: 302, location: "/files/image.png" },
          "https://git.example.test/files/image.png": { status: 206 },
        },
        sent,
      ),
      Effect.scoped,
    );
  });

  it.effect("does not request an unconfigured server", () => {
    const sent: Array<[string, string | undefined]> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* ForgejoMediaFetch.make;
      const response = yield* fetchMedia({ url: `https://codeberg.org${UPLOAD}`, headers: {} });
      expect(response).toBeNull();
      expect(sent).toEqual([]);
    }).pipe(fetchWith({ "codeberg.org": { status: 200 } }, sent), Effect.scoped);
  });
});
