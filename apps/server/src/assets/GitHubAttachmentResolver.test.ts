import * as NodeServices from "@effect/platform-node/NodeServices";
import { VcsProcessExitError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubAttachmentResolver from "./GitHubAttachmentResolver.ts";

const ATTACHMENT_URL =
  "https://github.com/user-attachments/assets/0b1f6f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const SIGNED_URL =
  "https://github-production-user-asset-6210df.s3.amazonaws.com/1/2.png?X-Amz-Expires=300&X-Amz-Signature=abc";

interface RecordedRequest {
  readonly url: string;
  readonly authorization: string | undefined;
}

function makeResolverLayer(options: {
  token: string | null;
  readonly respond: () => Response;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
}) {
  const ghCalls: Array<ReadonlyArray<string>> = [];
  const requests: RecordedRequest[] = [];
  const vcsProcessLayer = Layer.succeed(VcsProcess.VcsProcess, {
    run: (input) => {
      ghCalls.push(input.args);
      if (options.token === null) {
        return Effect.fail(
          new VcsProcessExitError({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            exitCode: 1,
            detail: "not logged in",
            failureKind: "authentication",
          }),
        );
      }
      return Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: `${options.token}\n`,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    },
  });
  const httpClientLayer =
    options.httpClientLayer ??
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push({ url: request.url, authorization: request.headers.authorization });
          return HttpClientResponse.fromWeb(request, options.respond());
        }),
      ),
    );
  const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-github-attachment-test-",
  });
  const layer = GitHubAttachmentResolver.layer.pipe(
    Layer.provide(GitHubCli.layer),
    Layer.provide(vcsProcessLayer),
    Layer.provide(httpClientLayer),
    Layer.provide(configLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, ghCalls, requests };
}

const redirectTo = (location: string) => () =>
  new Response(null, { status: 302, headers: { location } });

describe("GitHubAttachmentResolver", () => {
  it.effect("sends the gh token and returns the signed redirect target", () => {
    const { layer, ghCalls, requests } = makeResolverLayer({
      token: "ghp_test",
      respond: redirectTo(SIGNED_URL),
    });
    return Effect.gen(function* () {
      const resolver = yield* GitHubAttachmentResolver.GitHubAttachmentResolver;
      expect(yield* resolver.resolve(ATTACHMENT_URL)).toBe(SIGNED_URL);
      expect(ghCalls).toEqual([["auth", "token", "--hostname", "github.com"]]);
      expect(requests).toEqual([{ url: ATTACHMENT_URL, authorization: "token ghp_test" }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads the token once for a body full of attachments", () => {
    const { layer, ghCalls, requests } = makeResolverLayer({
      token: "ghp_test",
      respond: redirectTo(SIGNED_URL),
    });
    return Effect.gen(function* () {
      const resolver = yield* GitHubAttachmentResolver.GitHubAttachmentResolver;
      yield* resolver.resolve(ATTACHMENT_URL);
      yield* resolver.resolve(`${ATTACHMENT_URL}2`);
      expect(ghCalls).toHaveLength(1);
      expect(requests).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks anonymously when gh has no token and picks up a later login", () => {
    const options = { token: null as string | null, respond: redirectTo(SIGNED_URL) };
    const { layer, ghCalls, requests } = makeResolverLayer(options);
    return Effect.gen(function* () {
      const resolver = yield* GitHubAttachmentResolver.GitHubAttachmentResolver;
      expect(yield* resolver.resolve(ATTACHMENT_URL)).toBe(SIGNED_URL);
      expect(requests).toEqual([{ url: ATTACHMENT_URL, authorization: undefined }]);

      options.token = "ghp_after_login";
      expect(yield* resolver.resolve(ATTACHMENT_URL)).toBe(SIGNED_URL);
      expect(ghCalls).toHaveLength(2);
      expect(requests[1]).toEqual({ url: ATTACHMENT_URL, authorization: "token ghp_after_login" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("yields nothing when GitHub answers with a page instead of a redirect", () => {
    const { layer } = makeResolverLayer({
      token: "ghp_test",
      respond: () => new Response("Not Found", { status: 404 }),
    });
    return Effect.gen(function* () {
      const resolver = yield* GitHubAttachmentResolver.GitHubAttachmentResolver;
      expect(yield* resolver.resolve(ATTACHMENT_URL)).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("never puts the token on the wire for a URL outside the allowlist", () => {
    const { layer, ghCalls, requests } = makeResolverLayer({
      token: "ghp_test",
      respond: redirectTo(SIGNED_URL),
    });
    return Effect.gen(function* () {
      const resolver = yield* GitHubAttachmentResolver.GitHubAttachmentResolver;
      expect(yield* resolver.resolve("https://github.com/pingdotgg/t3code/pull/1")).toBeNull();
      expect(yield* resolver.resolve("https://evil.example/user-attachments/assets/x")).toBeNull();
      expect(ghCalls).toHaveLength(0);
      expect(requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports the signed target without following it", () => {
    // The real fetch client, with fetch itself replaced: following the redirect
    // would download the file and hand the handler a 200 instead of the target.
    const inits: Array<RequestInit | undefined> = [];
    const fakeFetch = ((_input: unknown, init?: RequestInit) => {
      inits.push(init);
      return Promise.resolve(
        init?.redirect === "manual"
          ? new Response(null, { status: 302, headers: { location: SIGNED_URL } })
          : new Response("image bytes", { status: 200 }),
      );
    }) as typeof fetch;
    const { layer } = makeResolverLayer({
      token: "ghp_test",
      respond: () => {
        throw new Error("unused");
      },
      httpClientLayer: FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fakeFetch)),
      ),
    });
    return Effect.gen(function* () {
      const resolver = yield* GitHubAttachmentResolver.GitHubAttachmentResolver;
      expect(yield* resolver.resolve(ATTACHMENT_URL)).toBe(SIGNED_URL);
      expect(inits.map((init) => init?.redirect)).toEqual(["manual"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("yields nothing for a redirect that is not https", () => {
    const { layer } = makeResolverLayer({
      token: "ghp_test",
      respond: redirectTo("http://example.com/asset.png"),
    });
    return Effect.gen(function* () {
      const resolver = yield* GitHubAttachmentResolver.GitHubAttachmentResolver;
      expect(yield* resolver.resolve(ATTACHMENT_URL)).toBeNull();
    }).pipe(Effect.provide(layer));
  });
});
