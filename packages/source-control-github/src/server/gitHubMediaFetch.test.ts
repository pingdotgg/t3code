import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubMediaFetch from "./gitHubMediaFetch.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

const unusedRest = Layer.mock(GitHubRest.GitHubRest)({});

describe("GitHubMediaFetch", () => {
  it.effect("loads private media immediately after login with the GitHub credential", () => {
    let lookups = 0;
    const authorizations: Array<string | undefined> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      const request = {
        url: "https://raw.githubusercontent.com/owner/repo/main/shot.png",
        headers: {},
      };
      expect((yield* fetchMedia(request))?.status).toBe(404);
      expect((yield* fetchMedia(request))?.status).toBe(200);
      expect((yield* fetchMedia(request))?.status).toBe(200);
      expect(lookups).toBe(3);
      expect(authorizations).toEqual([undefined, "Bearer signed-in", "Bearer signed-in"]);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubCredentials.GitHubCredentials)({
          get: (host) =>
            ++lookups === 1
              ? Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host }))
              : Effect.succeed({
                  host,
                  token: Redacted.make("signed-in"),
                  source: "gh" as const,
                  fingerprint: "fingerprint",
                }),
        }).pipe(Layer.merge(unusedRest)),
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

  it.effect("keeps the credential off the object store a redirect hands the media to", () => {
    const authorizations: Array<[string, string | undefined]> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      const response = yield* fetchMedia({
        url: "https://github.com/user-attachments/assets/1a1842fb",
        headers: { range: "bytes=0-1" },
      });
      expect(response?.status).toBe(200);
      expect(authorizations).toEqual([
        ["github.com", "Bearer signed-in"],
        ["objects.example.com", undefined],
      ]);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubCredentials.GitHubCredentials)({
          get: (host) =>
            Effect.succeed({
              host,
              token: Redacted.make("signed-in"),
              source: "gh" as const,
              fingerprint: "fingerprint",
            }),
        }).pipe(Layer.merge(unusedRest)),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const url = new URL(request.url);
          authorizations.push([url.hostname, request.headers.authorization]);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              url.hostname === "github.com"
                ? new Response(null, {
                    status: 302,
                    headers: { location: "https://objects.example.com/signed" },
                  })
                : new Response(null, { status: 200 }),
            ),
          );
        }),
      ),
      Effect.scoped,
    );
  });

  describe("release downloads", () => {
    const url = "https://github.com/owner/private/releases/download/v1%2Btest/shot%20%231%25.png";
    const credential = {
      host: "github.com",
      token: Redacted.make("release-test-token"),
      source: "gh" as const,
      fingerprint: "release-test",
    };
    const objectUrl = "https://release-assets.githubusercontent.com/shot.png?signature=test";

    it.effect(
      "downloads the exact release asset for a tag with a slash through the API without leaking auth on redirect",
      () => {
        const tag = "release%2Fv1";
        const requests: Array<{ url: string; authorization: string | undefined }> = [];
        const lookups: Array<GitHubRest.GitHubRestInput> = [];
        const downloadUrl = "https://api.github.com/repos/owner/private/releases/assets/42";
        return Effect.gen(function* () {
          const fetchMedia = yield* GitHubMediaFetch.make;
          const response = yield* fetchMedia({ url: url.replace("v1%2Btest", tag), headers: {} });
          expect(response?.status).toBe(200);
          expect(response && (yield* response.text)).toBe("release-image-bytes");
          expect(lookups).toMatchObject([
            {
              host: "github.com",
              operation: "getReleaseByTag",
              path: `repos/owner/private/releases/tags/${tag}`,
            },
          ]);
          expect(requests).toEqual([
            { url: downloadUrl, authorization: "Bearer release-test-token" },
            { url: objectUrl, authorization: undefined },
          ]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(GitHubCredentials.GitHubCredentials)({
                get: () => Effect.succeed(credential),
              }),
              Layer.mock(GitHubRest.GitHubRest)({
                rest: (input) =>
                  Effect.sync(() => {
                    lookups.push(input);
                    return {
                      status: 200,
                      headers: {},
                      truncated: false,
                      invalidUtf8: false,
                      body: JSON.stringify({
                        assets: [
                          { id: 41, name: "shot #1%.png.bak" },
                          {
                            id: 42,
                            name: "shot #1%.png",
                            url: "https://untrusted.invalid/ignored",
                          },
                        ],
                      }),
                    };
                  }),
              }),
            ),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              requests.push({ url: request.url, authorization: request.headers.authorization });
              if (request.url === downloadUrl) {
                expect(request.headers.accept).toBe("application/octet-stream");
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(null, { status: 302, headers: { location: objectUrl } }),
                  ),
                );
              }
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response("release-image-bytes", {
                    status: request.url === objectUrl ? 200 : 404,
                  }),
                ),
              );
            }),
          ),
          Effect.scoped,
        );
      },
    );

    it.effect.each(["no credential", "lookup fails"])(
      "loads public release bytes anonymously when %s",
      (mode) => {
        const requests: Array<{ url: string; authorization: string | undefined }> = [];
        let lookups = 0;
        return Effect.gen(function* () {
          const fetchMedia = yield* GitHubMediaFetch.make;
          expect((yield* fetchMedia({ url, headers: {} }))?.status).toBe(200);
          expect(requests).toEqual([
            { url, authorization: undefined },
            { url: objectUrl, authorization: undefined },
          ]);
          expect(lookups).toBe(mode === "no credential" ? 0 : 1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(GitHubCredentials.GitHubCredentials)({
                get: (host) =>
                  mode === "no credential"
                    ? Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host }))
                    : Effect.succeed(credential),
              }),
              Layer.mock(GitHubRest.GitHubRest)({
                rest: () =>
                  Effect.suspend(() => {
                    lookups += 1;
                    return Effect.fail(
                      new GitHubRequestPolicy.GitHubApiAuthenticationError({
                        host: "github.com",
                        operation: "getReleaseByTag",
                      }),
                    );
                  }),
              }),
            ),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              requests.push({ url: request.url, authorization: request.headers.authorization });
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  request.url === url
                    ? new Response(null, { status: 302, headers: { location: objectUrl } })
                    : new Response(null, { status: request.url === objectUrl ? 200 : 404 }),
                ),
              );
            }),
          ),
          Effect.scoped,
        );
      },
    );
  });
});
