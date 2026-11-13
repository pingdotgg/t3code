import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubMediaFetch from "./gitHubMediaFetch.ts";
import * as GitHubRest from "./GitHubRest.ts";
import { definition } from "../shared/definition.ts";

const PR_REPOSITORY = "enterprise/private";
const ENTERPRISE_HOST = "ghe.example.com";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const UPLOAD_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const COMMITTED_GIF = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0]);

/**
 * A GitHub Enterprise Server 3.21.4 without subdomain isolation, answering the way a real one did:
 * its web routes send a token to the sign-in page, it has no `raw.` host, the Contents API serves
 * files, and an upload redirects to a signed same-host URL that refuses the token.
 */
const enterpriseServer = () => {
  const respond = (
    request: HttpClientRequest.HttpClientRequest,
    body: BodyInit | null,
    init?: ResponseInit,
  ) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, init)));
  const client = HttpClient.make((request) => {
    const url = new URL(request.url);
    const authorization = request.headers.authorization;
    if (url.host === `raw.${ENTERPRISE_HOST}`) {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            cause: new Error(`getaddrinfo ENOTFOUND ${url.host}`),
          }),
        }),
      );
    }
    if (url.host !== ENTERPRISE_HOST) return Effect.die(`unexpected request to ${url.host}`);
    if (url.pathname === "/user-attachments/assets/abc-123" && authorization) {
      return respond(request, null, {
        status: 302,
        headers: { location: "/storage/abc-123?token=signed" },
      });
    }
    if (url.pathname === "/storage/abc-123" && url.searchParams.get("token") === "signed") {
      return authorization
        ? respond(request, "Not Found", { status: 404 })
        : respond(request, UPLOAD_PNG, { headers: { "content-type": "image/png" } });
    }
    const contents = /^\/api\/v3\/repos\/OWNER\/REPO\/contents\/(.+)$/u.exec(url.pathname);
    if (contents) {
      const ref = url.searchParams.get("ref") ?? "";
      return authorization &&
        contents[1] === "docs/evidence/demo.gif" &&
        [COMMIT, "test/pr-images"].includes(ref)
        ? respond(request, COMMITTED_GIF, {
            headers: {
              "content-type": "application/vnd.github.raw; charset=utf-8",
              "content-length": String(COMMITTED_GIF.length),
            },
          })
        : respond(request, "Not Found", { status: 404 });
    }
    return respond(request, "<html>Sign in</html>", {
      status: 302,
      headers: {
        location: `https://${ENTERPRISE_HOST}/login`,
        "content-type": "text/html; charset=utf-8",
      },
    });
  });
  return { client };
};

/** An SSO organization: the upload URL answers with a sign-in page, a rendered signed URL with bytes. */
const makeSsoFixture = (uploadUrl: string) => {
  const state = { account: "account-a", expired: new Set<string>() };
  const rendered: Array<GitHubRest.GitHubRestInput> = [];
  const signedUrls: Array<string> = [];
  const requests: Array<{ url: string; authorization?: string; range?: string }> = [];
  const credential = (host: string) =>
    Effect.sync(() => ({
      host,
      token: Redacted.make(state.account),
      fingerprint: state.account,
      source: "gh" as const,
    }));
  const layer = Layer.mergeAll(
    Layer.mock(GitHubCredentials.GitHubCredentials)({ get: credential }),
    Layer.mock(GitHubRest.GitHubRest)({
      rest: (input) =>
        Effect.sync(() => {
          rendered.push(input);
          const signed = `https://private-user-images.githubusercontent.com/1/upload.mp4?jwt=${state.account}-${rendered.length}&x=1`;
          const inRepository =
            (input.body as { readonly context?: string } | undefined)?.context === PR_REPOSITORY;
          if (inRepository) signedUrls.push(signed);
          return {
            status: 200,
            headers: {},
            body: `<p><img src="${inRepository ? signed.replaceAll("&", "&amp;") : uploadUrl}" alt=""></p>`,
            truncated: false,
            invalidUtf8: false,
          };
        }),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push({
            url: request.url,
            ...(request.headers.authorization
              ? { authorization: request.headers.authorization }
              : {}),
            ...(request.headers.range ? { range: request.headers.range } : {}),
          });
          if (request.url === uploadUrl) {
            return HttpClientResponse.fromWeb(
              request,
              new Response("<html>Sign in with SSO</html>", {
                headers: { "content-type": "text/html; charset=utf-8" },
              }),
            );
          }
          expect(signedUrls).toContain(request.url);
          const status = state.expired.has(request.url) ? 403 : request.headers.range ? 206 : 200;
          return HttpClientResponse.fromWeb(
            request,
            new Response(null, { status, headers: { "content-type": "video/mp4" } }),
          );
        }),
      ),
    ),
  );
  return { layer, state, rendered, signedUrls, requests };
};

describe("GitHubMediaFetch", () => {
  it.effect("fetches nothing for an Enterprise host the user has not signed in to", () => {
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      const response = yield* fetchMedia({
        url: "https://raw.unknown.example/owner/repo/main/a.png",
        headers: {},
        host: "unknown.example",
      });
      expect(response).toBeNull();
      expect(requests).toEqual([]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(GitHubRest.GitHubRest)({}),
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: (host) => Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host })),
          }),
        ),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request.url);
          return Effect.die("unexpected request");
        }),
      ),
    );
  });

  it.effect("sends an Enterprise Server token only to that host", () => {
    const requests: Array<{ url: string; authorization?: string; accept?: string }> = [];
    const hosts: Array<string> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      yield* fetchMedia({
        url: `https://raw.${ENTERPRISE_HOST}/OWNER/REPO/${COMMIT}/a.png`,
        headers: {},
        host: ENTERPRISE_HOST,
      });
      // A github.com image in an Enterprise pull request keeps github.com's account.
      yield* fetchMedia({
        url: "https://raw.githubusercontent.com/owner/repo/main/b.png",
        headers: {},
        host: ENTERPRISE_HOST,
      });
      // A request naming another host cannot borrow the Enterprise token.
      yield* fetchMedia({
        url: "https://raw.elsewhere.example/owner/repo/main/c.png",
        headers: {},
        host: ENTERPRISE_HOST,
      });
      expect(hosts).toEqual([ENTERPRISE_HOST, "github.com", "github.com"]);
      expect(requests).toEqual([
        {
          url: `https://${ENTERPRISE_HOST}/api/v3/repos/OWNER/REPO/contents/a.png?ref=${COMMIT}`,
          authorization: `Bearer token-${ENTERPRISE_HOST}`,
          accept: "application/vnd.github.raw",
        },
        {
          url: "https://raw.githubusercontent.com/owner/repo/main/b.png",
          authorization: "Bearer token-github.com",
        },
        { url: "https://raw.elsewhere.example/owner/repo/main/c.png" },
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(GitHubRest.GitHubRest)({}),
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: (host) => {
              hosts.push(host);
              return Effect.succeed({
                host,
                token: Redacted.make(`token-${host}`),
                source: "gh" as const,
                fingerprint: host,
              });
            },
          }),
        ),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push({
            url: request.url,
            ...(request.headers.authorization
              ? { authorization: request.headers.authorization }
              : {}),
            ...(request.headers.accept ? { accept: request.headers.accept } : {}),
          });
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, { headers: { "content-type": "image/png" } }),
            ),
          );
        }),
      ),
    );
  });

  it.effect(
    "loads an Enterprise Server pull request's images from a server without a raw host",
    () => {
      const server = enterpriseServer();
      const images = {
        upload: [`https://${ENTERPRISE_HOST}/user-attachments/assets/abc-123`, UPLOAD_PNG],
        commit: [
          `https://${ENTERPRISE_HOST}/OWNER/REPO/blob/${COMMIT}/docs/evidence/demo.gif?raw=true`,
          COMMITTED_GIF,
        ],
        branch: [
          `https://${ENTERPRISE_HOST}/OWNER/REPO/blob/test/pr-images/docs/evidence/demo.gif?raw=true`,
          COMMITTED_GIF,
        ],
      } as const;
      return Effect.gen(function* () {
        const fetchMedia = yield* GitHubMediaFetch.make;
        for (const [name, [url, bytes]] of Object.entries(images)) {
          // Loaded straight from the client, every image is a redirect to the sign-in page.
          const direct = yield* server.client.get(url);
          expect.soft(direct.headers.location, name).toBe(`https://${ENTERPRISE_HOST}/login`);
          // The pull request panel names its media by the change request's host.
          const media = definition.mediaUrl(new URL(url), ENTERPRISE_HOST);
          expect.soft(media, name).not.toBeNull();
          const response = yield* fetchMedia({
            url: media?.fetchUrl ?? url,
            headers: {},
            host: ENTERPRISE_HOST,
          }).pipe(Effect.orElseSucceed(() => null));
          expect.soft(response?.status, name).toBe(200);
          if (response !== null)
            expect.soft(new Uint8Array(yield* response.arrayBuffer), name).toEqual(bytes);
        }
      }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(GitHubRest.GitHubRest)({}),
            Layer.mock(GitHubCredentials.GitHubCredentials)({
              get: (host) =>
                host === ENTERPRISE_HOST
                  ? Effect.succeed({
                      host,
                      token: Redacted.make("enterprise-token"),
                      source: "gh" as const,
                      fingerprint: host,
                    })
                  : Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host })),
            }),
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, server.client),
      );
    },
  );

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
        Layer.merge(
          Layer.mock(GitHubRest.GitHubRest)({}),
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
        Layer.merge(
          Layer.mock(GitHubRest.GitHubRest)({}),
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
    );
  });

  it.effect(
    "renders SSO uploads in the PR repository and reuses the signed URL for a range",
    () => {
      const url = "https://github.com/user-attachments/assets/explicit-pr-context";
      const fixture = makeSsoFixture(url);
      return Effect.gen(function* () {
        const fetchMedia = yield* GitHubMediaFetch.make;
        const request = { url, headers: {}, repository: PR_REPOSITORY };
        expect((yield* fetchMedia(request))?.status).toBe(200);
        expect((yield* fetchMedia({ ...request, headers: { range: "bytes=2-5" } }))?.status).toBe(
          206,
        );
        expect(fixture.rendered).toHaveLength(1);
        expect(fixture.rendered[0]).toMatchObject({
          host: "github.com",
          method: "POST",
          path: "markdown",
          accept: "text/html",
          body: { text: `![](${url})`, mode: "gfm", context: PR_REPOSITORY },
        });
        expect(fixture.requests).toEqual([
          { url, authorization: "Bearer account-a" },
          { url: fixture.signedUrls[0] },
          { url: fixture.signedUrls[0], range: "bytes=2-5" },
        ]);
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect("renders a legacy upload in the repository its path names", () => {
    const url = `https://github.com/${PR_REPOSITORY}/assets/123/legacy`;
    const fixture = makeSsoFixture(url);
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      const response = yield* fetchMedia({ url, headers: {}, repository: "personal/unrelated" });
      expect(response?.status).toBe(200);
      expect(fixture.rendered.map((input) => input.body)).toEqual([
        { text: `![](${url})`, mode: "gfm", context: PR_REPOSITORY },
      ]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("renders a fresh signed URL after an account switch, early expiry, or its TTL", () => {
    const url = "https://github.com/user-attachments/assets/cache-lifecycle";
    const fixture = makeSsoFixture(url);
    const request = { url, headers: {}, repository: PR_REPOSITORY };
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      yield* fetchMedia(request);
      fixture.state.account = "account-b";
      yield* fetchMedia(request);
      expect(fixture.rendered).toHaveLength(2);

      fixture.state.expired.add(fixture.signedUrls.at(-1)!);
      expect((yield* fetchMedia(request))?.status).toBe(200);
      expect(fixture.rendered).toHaveLength(3);

      yield* TestClock.adjust("6 minutes");
      yield* fetchMedia(request);
      expect(fixture.rendered).toHaveLength(4);
      expect(fixture.requests.at(-1)?.url).toBe(fixture.signedUrls.at(-1));
    }).pipe(Effect.provide(fixture.layer));
  });
});
