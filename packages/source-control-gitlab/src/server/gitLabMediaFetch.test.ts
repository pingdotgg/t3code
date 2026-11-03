import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabMediaFetch from "./gitLabMediaFetch.ts";

const UPLOAD = "/api/v4/projects/acme%2Fweb/uploads/871cca6041e4d445daf391a8a17d8fb2/clip.mp4";

/** `glab` with the given tokens per host, each read handing out the next one. */
const glab = (tokens: Record<string, Array<string>>, calls: Array<string>) =>
  Layer.mock(GitLabCli.GitLabCli)({
    execute: (input) =>
      Effect.sync(() => {
        calls.push(input.args.join(" "));
        const host = input.args.at(-1) ?? "";
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: input.args[0] === "config" ? (tokens[host]?.shift() ?? "") : "{}",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });

const respondWith = (
  respond: (request: { url: string; authorization: string | undefined }) => Response,
) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        respond({ url: request.url, authorization: request.headers.authorization }),
      ),
    ),
  );

describe("GitLabMediaFetch", () => {
  it.effect("sends nothing to a host glab has no account on", () => {
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* GitLabMediaFetch.make;
      expect(
        yield* fetchMedia({ url: `https://gitlab.evil.test${UPLOAD}`, headers: {} }),
      ).toBeNull();
      expect(requests).toEqual([]);
    }).pipe(
      Effect.provide(glab({}, [])),
      Effect.provideService(
        HttpClient.HttpClient,
        respondWith(({ url }) => {
          requests.push(url);
          return new Response(null, { status: 200 });
        }),
      ),
      Effect.scoped,
    );
  });

  it.effect("refreshes an expired OAuth token through glab and asks again", () => {
    const calls: Array<string> = [];
    const authorizations: Array<string | undefined> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* GitLabMediaFetch.make;
      const response = yield* fetchMedia({ url: `https://gitlab.com${UPLOAD}`, headers: {} });
      expect(response?.status).toBe(200);
      expect(authorizations).toEqual(["Bearer expired", "Bearer fresh"]);
      expect(calls).toEqual([
        "config get token --host gitlab.com",
        "api user",
        "config get token --host gitlab.com",
      ]);
    }).pipe(
      Effect.provide(glab({ "gitlab.com": ["expired\n", "fresh\n"] }, calls)),
      Effect.provideService(
        HttpClient.HttpClient,
        respondWith(({ authorization }) => {
          authorizations.push(authorization);
          return new Response(null, { status: authorization === "Bearer fresh" ? 200 : 401 });
        }),
      ),
      Effect.scoped,
    );
  });

  it.effect("keeps the token off the object store a redirect hands the upload to", () => {
    const authorizations: Array<[string, string | undefined]> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* GitLabMediaFetch.make;
      const response = yield* fetchMedia({ url: `https://gitlab.com${UPLOAD}`, headers: {} });
      expect(response?.status).toBe(200);
      expect(authorizations).toEqual([
        ["gitlab.com", "Bearer token"],
        ["storage.example.com", undefined],
      ]);
    }).pipe(
      Effect.provide(glab({ "gitlab.com": ["token"] }, [])),
      Effect.provideService(
        HttpClient.HttpClient,
        respondWith(({ url, authorization }) => {
          const { hostname } = new URL(url);
          authorizations.push([hostname, authorization]);
          return hostname === "gitlab.com"
            ? new Response(null, {
                status: 302,
                headers: { location: "https://storage.example.com/signed" },
              })
            : new Response(null, { status: 200 });
        }),
      ),
      Effect.scoped,
    );
  });
});
