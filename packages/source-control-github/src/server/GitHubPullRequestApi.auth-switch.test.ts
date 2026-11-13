import {
  Effect,
  GitHubAppAccess,
  GitHubCredentials,
  GitHubPullRequestApi,
  GitHubQuota,
  GitHubRest,
  HttpClient,
  HttpClientResponse,
  Layer,
  NodeServices,
  Redacted,
  SourceControlRateLimit,
  TestSourceControlHost,
  appSignedOut,
  encodeJson,
  expect,
  it,
} from "./GitHubPullRequestApi-fixtures.testkit.ts";

it.effect(
  "keeps a verified credential through an auth switch and separates token fingerprints",
  () =>
    Effect.gen(function* () {
      let activeToken = "broad-credential";
      const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> =
        [];
      const credentials = Layer.succeed(
        GitHubCredentials.GitHubCredentials,
        GitHubCredentials.GitHubCredentials.of({
          get: (host) =>
            Effect.sync(() => ({
              host,
              token: Redacted.make(activeToken),
              source: "gh" as const,
              fingerprint: `${host}:${activeToken.length}${activeToken.at(-1)}`,
            })),
          saved: () => Effect.succeedNone,
          fingerprint: (host, token) => Effect.succeed(`${host}:${token}`),
          invalidate: () => Effect.void,
        }),
      );
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push({ url: request.url, authorization: request.headers["authorization"] });
            const body = request.url.endsWith("/user")
              ? { id: 123, login: "same-account" }
              : {
                  data: {
                    repository: { pullRequest: { id: "PR_1" } },
                    addComment: { clientMutationId: null },
                  },
                };
            return HttpClientResponse.fromWeb(
              request,
              new Response(encodeJson(body), { headers: { "content-type": "application/json" } }),
            );
          }),
        ),
      );
      const cli = yield* GitHubPullRequestApi.make.pipe(
        Effect.provide(
          GitHubAppAccess.layer.pipe(
            Layer.provideMerge(GitHubRest.layer),
            Layer.provideMerge(Layer.mergeAll(credentials, http, appSignedOut)),
            Layer.provideMerge(GitHubQuota.layer),
            Layer.provideMerge(SourceControlRateLimit.layer),
            Layer.merge(TestSourceControlHost.layer()),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
      const input = { cwd: "/repo", host: "github.com" };
      const first = yield* cli.withVerifiedCredential(input, (identity) =>
        Effect.gen(function* () {
          activeToken = "restricted-credential";
          expect(yield* cli.getViewerLogin(input)).toBe("same-account");
          yield* cli.commentOnPullRequest({
            ...input,
            repository: "owner/repo",
            number: 1,
            body: "comment",
          });
          return identity;
        }),
      );
      const second = yield* cli.withVerifiedCredential(input, Effect.succeed);
      expect(first.accountId).toBe(second.accountId);
      expect(first.credentialFingerprint).not.toBe(second.credentialFingerprint);
      expect(encodeJson([first, second])).not.toContain("broad-credential");
      expect(encodeJson([first, second])).not.toContain("restricted-credential");
      expect(
        requests
          .filter((request) => request.url.endsWith("/graphql"))
          .map((request) => request.authorization),
      ).toEqual(["Bearer broad-credential", "Bearer broad-credential"]);
      expect(
        requests
          .filter((request) => request.url.endsWith("/user"))
          .map((request) => request.authorization),
      ).toEqual(["Bearer broad-credential", "Bearer restricted-credential"]);
      expect(yield* cli.getRoutingIdentity(input)).toEqual({
        accountId: "123",
        viewer: "same-account",
      });
    }),
);
