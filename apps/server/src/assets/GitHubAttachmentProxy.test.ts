import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { ExitCode } from "effect/unstable/process/ChildProcessSpawner";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubAttachmentProxy from "./GitHubAttachmentProxy.ts";

const ATTACHMENT_URL = "https://github.com/user-attachments/assets/4dcab2ba";
const STORAGE_URL = "https://objects.example.test/signed/4dcab2ba";

const notImplemented = () => Effect.die("not implemented in this test");

describe("GitHubAttachmentProxy", () => {
  it.effect("resolves the redirect with the gh token and caches the token read", () =>
    Effect.gen(function* () {
      const cliCalls: Array<ReadonlyArray<string>> = [];
      const authorizations: Array<string | undefined> = [];
      const gitHubCli = Layer.succeed(
        GitHubCli.GitHubCli,
        GitHubCli.GitHubCli.of({
          execute: ({ args }) => {
            cliCalls.push(args);
            return Effect.succeed({
              exitCode: ExitCode(0),
              stdout: "gh-token-1\n",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          },
          listOpenPullRequests: notImplemented,
          getPullRequest: notImplemented,
          getRepositoryCloneUrls: notImplemented,
          createRepository: notImplemented,
          createPullRequest: notImplemented,
          getDefaultBranch: notImplemented,
          checkoutPullRequest: notImplemented,
        }),
      );
      const httpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            authorizations.push(request.headers["authorization"]);
            return HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: 302, headers: { location: STORAGE_URL } }),
            );
          }),
        ),
      );

      const proxy = yield* GitHubAttachmentProxy.GitHubAttachmentProxy.pipe(
        Effect.provide(
          GitHubAttachmentProxy.layer.pipe(Layer.provide(gitHubCli), Layer.provide(httpClient)),
        ),
      );
      const first = yield* proxy.resolveAttachmentLocation(ATTACHMENT_URL);
      const second = yield* proxy.resolveAttachmentLocation(ATTACHMENT_URL);

      expect([first, second]).toEqual([STORAGE_URL, STORAGE_URL]);
      expect(authorizations).toEqual(["token gh-token-1", "token gh-token-1"]);
      expect(cliCalls).toEqual([["auth", "token", "--hostname", "github.com"]]);
    }),
  );
});
