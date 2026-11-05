import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubMediaFetch from "./gitHubMediaFetch.ts";
import * as GitHubRest from "./GitHubRest.ts";

const signedIn = Layer.mock(GitHubCredentials.GitHubCredentials)({
  get: (host) =>
    Effect.succeed({
      host,
      token: Redacted.make("signed-in"),
      source: "gh" as const,
      fingerprint: "fingerprint",
    }),
});

const checkout = TestSourceControlHost.layer({
  process: {
    run: (input) =>
      Effect.succeed(
        TestSourceControlHost.processOutput(
          input.args[0] === "remote" ? "origin\thttps://github.com/acme/widgets.git (fetch)\n" : "",
        ),
      ),
  },
});

const renderedMarkdown = (rest: Array<GitHubRest.GitHubRestInput>, html: string) =>
  Layer.mock(GitHubRest.GitHubRest)({
    rest: (input) => {
      rest.push(input);
      return Effect.succeed({
        status: 200,
        headers: { "content-type": "text/html;charset=utf-8" },
        body: html,
        truncated: false,
        invalidUtf8: false,
      });
    },
  });

describe("GitHubMediaFetch", () => {
  it.effect("loads private media immediately after login with the GitHub credential", () => {
    let lookups = 0;
    const authorizations: Array<string | undefined> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      const request = {
        url: "https://raw.githubusercontent.com/owner/repo/main/shot.png",
        cwd: "/repo",
        headers: {},
      };
      expect((yield* fetchMedia(request))?.status).toBe(404);
      expect((yield* fetchMedia(request))?.status).toBe(200);
      expect((yield* fetchMedia(request))?.status).toBe(200);
      expect(lookups).toBe(3);
      expect(authorizations).toEqual([undefined, "Bearer signed-in", "Bearer signed-in"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
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
          renderedMarkdown([], ""),
          checkout,
        ),
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
      Effect.provideService(HostProcess.Environment, {}),
      Effect.scoped,
    );
  });

  it.effect("loads attachments through a link the API signs, which SSO orgs honour", () => {
    const rest: Array<GitHubRest.GitHubRestInput> = [];
    const requests: Array<[string, string | undefined]> = [];
    const signed =
      "https://private-user-images.githubusercontent.com/1/2-1a1842fb.mp4?jwt=header.claims&sig=1";
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      const request = {
        url: "https://github.com/user-attachments/assets/1a1842fb",
        cwd: "/repo",
        headers: { range: "bytes=0-1" },
      };
      expect((yield* fetchMedia(request))?.status).toBe(206);
      expect((yield* fetchMedia(request))?.status).toBe(206);
      expect(rest).toHaveLength(1);
      yield* TestClock.adjust("5 minutes");
      expect((yield* fetchMedia(request))?.status).toBe(206);
      expect(rest).toHaveLength(2);
      expect(rest[0]).toMatchObject({
        host: "github.com",
        method: "POST",
        path: "markdown",
        body: {
          mode: "gfm",
          context: "acme/widgets",
          text: "![](https://github.com/user-attachments/assets/1a1842fb)",
        },
      });
      expect(requests).toEqual([
        [signed, undefined],
        [signed, undefined],
        [signed, undefined],
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          signedIn,
          renderedMarkdown(
            rest,
            `<p dir="auto"><a href="https://github.com/user-attachments/assets/1a1842fb"><img src="${signed.replace("&", "&amp;")}" alt=""></a></p>`,
          ),
          checkout,
        ),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push([request.url, request.headers.authorization]);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new URL(request.url).hostname === "github.com"
                ? new Response("<title>Sign in to acme</title>", {
                    status: 200,
                    headers: { "content-type": "text/html; charset=utf-8" },
                  })
                : new Response(null, { status: 206, headers: { "content-type": "video/mp4" } }),
            ),
          );
        }),
      ),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.scoped,
    );
  });

  it.effect(
    "falls back to the credential, kept off the object store, when the API won't sign",
    () => {
      const authorizations: Array<[string, string | undefined]> = [];
      return Effect.gen(function* () {
        const fetchMedia = yield* GitHubMediaFetch.make;
        const response = yield* fetchMedia({
          url: "https://github.com/user-attachments/assets/1a1842fb",
          cwd: "/repo",
          headers: { range: "bytes=0-1" },
        });
        expect(response?.status).toBe(200);
        expect(authorizations).toEqual([
          ["github.com", "Bearer signed-in"],
          ["objects.example.com", undefined],
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            signedIn,
            renderedMarkdown(
              [],
              `<p dir="auto"><img src="https://github.com/user-attachments/assets/1a1842fb" alt=""></p>`,
            ),
            checkout,
          ),
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
        Effect.provideService(HostProcess.Environment, {}),
        Effect.scoped,
      );
    },
  );
});
