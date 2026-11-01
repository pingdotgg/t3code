import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubMediaFetch from "./gitHubMediaFetch.ts";

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
      Effect.provide(Layer.mock(GitHubRest.GitHubRest)({})),
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
        }),
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
      Effect.provide(Layer.mock(GitHubRest.GitHubRest)({})),
      Effect.scoped,
    );
  });
  it.effect(
    "resolves private attachment image and video responses without leaking credentials",
    () =>
      Effect.gen(function* () {
        for (const status of [200, 401, 403, 404, 429, 500]) {
          for (const contentType of ["image/png", "video/mp4"]) {
            for (const rendered of [
              {
                body: '<img src="https://private-user-images.githubusercontent.com/signed?jwt=a&amp;x=b">',
                truncated: false,
                invalidUtf8: false,
              },
              {
                body: '<img src="https://example.com/secret">',
                truncated: false,
                invalidUtf8: false,
              },
              {
                body: '<img src="https://private-user-images.githubusercontent.com/signed">',
                truncated: true,
                invalidUtf8: false,
              },
              {
                body: '<img src="https://private-user-images.githubusercontent.com/signed">',
                truncated: false,
                invalidUtf8: true,
              },
            ]) {
              const requests: Array<[string, string | undefined, string | undefined]> = [];
              let markdownCalls = 0;
              const response = yield* Effect.gen(function* () {
                const fetchMedia = yield* GitHubMediaFetch.make;
                return yield* fetchMedia({
                  url: "https://github.com/user-attachments/assets/abc-123",
                  repositoryUrl: "https://github.com/owner/repo",
                  headers: { range: "bytes=0-1" },
                });
              }).pipe(
                Effect.provide(
                  Layer.merge(
                    Layer.mock(GitHubCredentials.GitHubCredentials)({
                      get: (host) =>
                        Effect.succeed({
                          host,
                          token: Redacted.make("signed-in"),
                          source: "gh" as const,
                          fingerprint: "fingerprint",
                        }),
                    }),
                    Layer.mock(GitHubRest.GitHubRest)({
                      rest: (input) => {
                        markdownCalls++;
                        expect(input.path).toBe("markdown");
                        expect(input.body).toEqual({
                          mode: "gfm",
                          text: "![](<https://github.com/user-attachments/assets/abc-123>)",
                          context: "owner/repo",
                        });
                        return Effect.succeed({
                          status: 200,
                          headers: {},
                          ...rendered,
                        });
                      },
                    }),
                  ),
                ),
                Effect.provideService(
                  HttpClient.HttpClient,
                  HttpClient.make((request) => {
                    requests.push([
                      request.url,
                      request.headers.authorization,
                      request.headers.range,
                    ]);
                    return Effect.succeed(
                      HttpClientResponse.fromWeb(
                        request,
                        request.url.includes("private-user-images")
                          ? new Response(null, {
                              status: 206,
                              headers: { "content-type": contentType },
                            })
                          : new Response(null, {
                              status,
                              headers: { "content-type": "text/html; charset=utf-8" },
                            }),
                      ),
                    );
                  }),
                ),
              );
              if (status === 429 || status === 500) {
                expect(markdownCalls).toBe(0);
                expect(response?.status).toBe(status);
                expect(requests).toHaveLength(1);
                continue;
              }
              if (
                rendered.truncated ||
                rendered.invalidUtf8 ||
                rendered.body.includes("example.com")
              ) {
                expect(response).toBeNull();
                expect(markdownCalls).toBe(1);
                expect(requests).toHaveLength(1);
                continue;
              }
              expect(response?.status).toBe(206);
              expect(response?.headers["content-type"]).toBe(contentType);
              expect(markdownCalls).toBe(1);
              expect(requests).toEqual([
                [
                  "https://github.com/user-attachments/assets/abc-123",
                  "Bearer signed-in",
                  "bytes=0-1",
                ],
                [
                  "https://private-user-images.githubusercontent.com/signed?jwt=a&x=b",
                  undefined,
                  "bytes=0-1",
                ],
              ]);
            }
          }
        }
      }).pipe(Effect.scoped),
  );
});
