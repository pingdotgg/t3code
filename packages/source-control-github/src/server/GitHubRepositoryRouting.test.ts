import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import { DEFAULT_SERVER_SETTINGS, SourceControlProviderKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubApi from "./GitHubRest.ts";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import { makeChecksRevalidator } from "./gitHubConditionalChecks.ts";

function harness(
  refusalStatus = 401,
  successfulGraphql = false,
  options: {
    readonly missingOwners?: ReadonlyArray<string>;
    readonly fallbackGh?: boolean;
    readonly sameToken?: boolean;
    readonly rateLimited?: boolean;
  } = {},
) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const helperPaths: string[] = [];
  const refused = new Set<string>();
  let generation = 1;
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request);
      const token = request.headers.authorization ?? "";
      const pathname = new URL(request.url).pathname;
      const result = refused.has(token)
        ? json(
            { message: options.rateLimited ? "API rate limit exceeded" : "Bad credentials" },
            refusalStatus,
          )
        : pathname === "/user"
          ? json({ id: 123, login: "Chinoman10" })
          : pathname.startsWith("/repos/")
            ? json({
                full_name: pathname.slice("/repos/".length),
                html_url: `https://github.com/${pathname.slice(7)}`,
                ssh_url: `git@github.com:${pathname.slice(7)}.git`,
              })
            : successfulGraphql
              ? json({
                  data: {
                    repository: { pullRequest: { id: "PR_1" }, pullRequests: { nodes: [] } },
                    addComment: { clientMutationId: null },
                    addReaction: { reaction: { content: "THUMBS_UP" } },
                    _0_markFileAsViewed: { clientMutationId: null },
                    _1_unmarkFileAsViewed: { clientMutationId: null },
                    _0_repository: { pullRequests: { nodes: [] } },
                  },
                })
              : json({ message: "Not Found" }, 404);
      return Effect.succeed(HttpClientResponse.fromWeb(request, result));
    }),
  );
  const host = TestSourceControlHost.layer({
    settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      sourceControlHosts: {
        github: { tokens: options.fallbackGh ? {} : { "github.com": "host-default" } },
      },
    }),
    process: {
      run: (input) =>
        Effect.sync(() => {
          if (input.command === "gh")
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: `fake-gh-${generation}\n`,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          const path = /path=(.*)\n/.exec(input.stdin ?? "")?.[1] ?? "";
          if (path) helperPaths.push(path);
          if (options.missingOwners?.includes(path.split("/")[0] ?? ""))
            return {
              exitCode: ChildProcessSpawner.ExitCode(128),
              stdout: "",
              stderr: `fatal: could not read Username for 'https://github.com/${path}': terminal prompts disabled\n`,
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          return {
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: `protocol=https\nhost=github.com\nusername=Chinoman10\npassword=fake-${options.sameToken ? "shared" : path.split("/")[0]}-${generation}\n`,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    },
  });
  const api = GitHubApi.layerWithDependencies.pipe(
    Layer.provideMerge(host),
    Layer.provideMerge(http),
    Layer.provide(NodeCrypto.layer),
  );
  const layer = GitHubPullRequestApi.layer.pipe(
    Layer.provideMerge(api),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(
      Layer.succeed(HostProcess.Environment, { T3CODE_GITHUB_USE_GIT_CREDENTIALS: "1" }),
    ),
    Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/trusted")),
  );
  return {
    layer,
    requests,
    helperPaths,
    refused,
    rotate: () => {
      generation++;
    },
  };
}

describe("native GitHub repository routing", () => {
  it.effect("forwards the repository to every conditional checks endpoint", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const ref = { cwd: "/w", host: "github.com", repository: "OwnerA/Repo", number: 1 };
      const sha = "a".repeat(40);
      const revalidate = yield* makeChecksRevalidator.pipe(
        Effect.provideService(GitHubApi.GitHubRest, {
          credential: () => Effect.die("already pinned"),
          rest: (input) => {
            expect(input.repository).toBe(ref.repository);
            expect(input.host).toBe(ref.host);
            calls.push(input.path);
            return Effect.succeed({
              status: 200,
              headers: {},
              body: JSON.stringify({ head: { sha, repo: { id: 1 } }, base: { repo: { id: 1 } } }),
              truncated: false,
              invalidUtf8: false,
            });
          },
        }),
      );
      const result = yield* revalidate(
        ref,
        Effect.succeed({ state: "open" as const, checks: [], headSha: sha }),
      ).pipe(
        Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
          host: ref.host,
          repository: "ownera/repo",
          token: Redacted.make("synthetic"),
          credentialFingerprint: "synthetic-fingerprint",
        }),
      );
      expect(result).toEqual({ state: "open", checks: [] });
      expect(calls).toEqual([
        "repos/OwnerA/Repo/pulls/1",
        `repos/OwnerA/Repo/commits/${sha}/check-runs?filter=all&per_page=100&page=1`,
        `repos/OwnerA/Repo/commits/${sha}/status?per_page=100&page=1`,
      ]);
    }),
  );
  it.effect("a verified fallback credential stays scoped to the requested repository", () => {
    const { layer, requests, helperPaths } = harness(401, false, { missingOwners: ["OwnerA"] });
    return Effect.gen(function* () {
      const prs = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const api = yield* GitHubApi.GitHubRest;
      const error = yield* prs.withVerifiedCredential(
        { cwd: "/w", host: "github.com", repository: "OwnerA/Repo" },
        () =>
          api
            .rest({
              host: "github.com",
              repository: "OwnerB/Repo",
              operation: "test",
              path: "repos/OwnerB/Repo",
            })
            .pipe(Effect.flip),
      );
      expect(error._tag).toBe("GitHubApiAuthenticationError");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.authorization).toBe("Bearer host-default");
      const ownB = yield* api.credential("github.com", "OwnerB/Repo");
      expect(Redacted.value(ownB.token)).toBe("fake-OwnerB-1");
      expect(helperPaths).toEqual(["OwnerA/Repo.git", "OwnerB/Repo.git"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("an operation wrapper cannot reuse repository A's fallback credential for B", () => {
    const { layer, requests, helperPaths, refused } = harness(404, false, {
      missingOwners: ["OwnerA"],
    });
    refused.add("Bearer host-default");
    return Effect.gen(function* () {
      const prs = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const api = yield* GitHubApi.GitHubRest;
      const error = yield* prs
        .revalidateChecks(
          { cwd: "/w", host: "github.com", repository: "OwnerA/Repo", number: 1 },
          api
            .rest({
              host: "github.com",
              repository: "OwnerB/Repo",
              operation: "test",
              path: "repos/OwnerB/Repo",
            })
            .pipe(Effect.as({ state: "open" as const, checks: [], headSha: "a".repeat(40) })),
        )
        .pipe(Effect.flip);
      expect(error._tag).toBe("GitHubApiAuthenticationError");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toContain("/repos/OwnerA/Repo/");
      expect(helperPaths).toEqual(["OwnerA/Repo.git"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("validates requested repository context before returning a host-only pin", () => {
    const { layer, requests, helperPaths } = harness();
    return Effect.gen(function* () {
      const prs = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const api = yield* GitHubApi.GitHubRest;
      const error = yield* prs.withVerifiedCredential({ cwd: "/w", host: "github.com" }, () =>
        api.credential("github.com", "owner/repo\npassword=unsafe").pipe(Effect.flip),
      );
      expect(error._tag).toBe("GitHubGitCredentialError");
      expect(requests).toHaveLength(1);
      expect(helperPaths).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([401, 403])(
    "invalidates a scoped gh fallback after HTTP %s while retaining B's helper token",
    (status) => {
      const { layer, requests, helperPaths, refused, rotate } = harness(status, false, {
        missingOwners: ["OwnerA"],
        fallbackGh: true,
      });
      return Effect.gen(function* () {
        const prs = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const api = yield* GitHubApi.GitHubRest;
        yield* api.credential("github.com", "OwnerB/Repo");
        const ref = { cwd: "/w", host: "github.com", repository: "OwnerA/Repo", number: 1 };
        const error = yield* prs
          .withVerifiedCredential(ref, () =>
            Effect.sync(() => refused.add("Bearer fake-gh-1")).pipe(
              Effect.andThen(
                prs.submitReview({ ...ref, verdict: "comment", body: "Fake review", comments: [] }),
              ),
            ),
          )
          .pipe(Effect.flip);
        expect(error._tag).toBe(
          status === 401 ? "GitHubApiAuthenticationError" : "GitHubApiResponseError",
        );
        expect(requests.map((request) => request.headers.authorization)).toEqual([
          "Bearer fake-gh-1",
          "Bearer fake-gh-1",
        ]);
        rotate();
        expect(Redacted.value((yield* api.credential("github.com", "OwnerA/Repo")).token)).toBe(
          "fake-gh-2",
        );
        expect(Redacted.value((yield* api.credential("github.com", "OwnerB/Repo")).token)).toBe(
          "fake-OwnerB-1",
        );
        expect(helperPaths).toEqual(["OwnerB/Repo.git", "OwnerA/Repo.git"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("routes native PR writes through the repository PAT", () => {
    const { layer, requests } = harness(401, true);
    return Effect.gen(function* () {
      const prs = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const ref = { cwd: "/w", host: "github.com", repository: "OwnerA/Repo", number: 1 };
      yield* prs.commentOnPullRequest({ ...ref, body: "Fake test comment" });
      yield* prs.submitReview({ ...ref, verdict: "comment", body: "Fake review", comments: [] });
      yield* prs.setLabels({ ...ref, labels: ["bug"], applied: true });
      yield* prs.setReaction({ ...ref, content: "thumbs-up", reacted: true });
      yield* prs.setPullRequestFilesViewed({
        ...ref,
        files: [
          { path: "file.ts", viewed: true },
          { path: "other.ts", viewed: false },
        ],
      });
      expect(requests).toHaveLength(6);
      expect(
        requests.every((request) => request.headers.authorization === "Bearer fake-OwnerA-1"),
      ).toBe(true);
      expect(requests.every((request) => request.method === "POST")).toBe(true);
      const viewed = requests.at(-1)?.body;
      expect(viewed?._tag).toBe("Uint8Array");
      if (viewed?._tag === "Uint8Array") {
        const payload = JSON.parse(new TextDecoder().decode(viewed.body));
        expect(payload.query).toContain("_0_markFileAsViewed");
        expect(payload.query).toContain("_1_unmarkFileAsViewed");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("a newly disabled host rejects a captured pin before another request", () => {
    const { layer, requests, helperPaths } = harness();
    return Effect.gen(function* () {
      const prs = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const api = yield* GitHubApi.GitHubRest;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      const error = yield* prs.withVerifiedCredential(
        { cwd: "/w", host: "github.com", repository: "OwnerA/Repo" },
        () =>
          settings
            .update({
              sourceControlHosts: { github: { hosts: { "github.com": { enabled: false } } } },
            })
            .pipe(
              Effect.andThen(
                api.rest({
                  host: "github.com",
                  repository: "OwnerA/Repo",
                  operation: "test",
                  path: "repos/OwnerA/Repo",
                }),
              ),
              Effect.flip,
            ),
      );
      expect(error._tag).toBe("GitHubHostDisabledError");
      expect(requests).toHaveLength(1);
      expect(helperPaths).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps scoped rate-limit 403 cached and leaves repository B unpaused", () => {
    const { layer, requests, refused, helperPaths } = harness(403, false, { rateLimited: true });
    refused.add("Bearer fake-OwnerA-1");
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubRest;
      const error = yield* api
        .rest({
          host: "github.com",
          repository: "OwnerA/Repo",
          operation: "test",
          path: "repos/OwnerA/Repo",
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("GitHubApiRateLimitError");
      yield* api.credential("github.com", "OwnerA/Repo");
      yield* api.rest({
        host: "github.com",
        repository: "OwnerB/Repo",
        operation: "test",
        path: "repos/OwnerB/Repo",
      });
      expect(requests).toHaveLength(2);
      expect(helperPaths).toEqual(["OwnerA/Repo.git", "OwnerB/Repo.git"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("invalidates a non-rate-limited 403 without retrying with another token", () => {
    const { layer, requests, refused, helperPaths, rotate } = harness(403);
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubRest;
      refused.add("Bearer fake-OwnerA-1");
      const error = yield* api
        .rest({
          host: "github.com",
          repository: "OwnerA/Repo",
          operation: "test",
          path: "repos/OwnerA/Repo",
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("GitHubApiResponseError");
      expect(requests).toHaveLength(1);
      rotate();
      expect(Redacted.value((yield* api.credential("github.com", "OwnerA/Repo")).token)).toBe(
        "fake-OwnerA-2",
      );
      expect(helperPaths).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "offers repository lookup without claiming a host-wide login in helper-only mode",
    () => {
      const commands: string[] = [];
      return Effect.gen(function* () {
        const discovery = yield* GitHubSourceControlProvider.makeDiscovery;
        const available = yield* discovery.probe("/untrusted-checkout");
        expect(available.status).toBe("available");
        expect(available.auth.status).toBe("unknown");
        expect(Option.isNone(available.auth.account)).toBe(true);
        expect(Option.getOrNull(available.auth.detail)).toContain("per repository");
        const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
        yield* settings.update({
          sourceControlHosts: { github: { hosts: { "github.com": { enabled: false } } } },
        });
        yield* discovery.probe("/untrusted-checkout");
        expect(commands.filter((command) => command === "git")).toHaveLength(1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(GitHubApi.GitHubRest)({}),
            TestSourceControlHost.layer({
              process: {
                run: (input) =>
                  Effect.sync(() => {
                    commands.push(input.command);
                    return {
                      exitCode: ChildProcessSpawner.ExitCode(input.command === "git" ? 0 : 1),
                      stdout: input.command === "git" ? "git version 2.43.0\n" : "",
                      stderr: "",
                      stdoutTruncated: false,
                      stderrTruncated: false,
                    };
                  }),
              },
            }),
          ),
        ),
        Effect.provideService(HostProcess.Environment, { T3CODE_GITHUB_USE_GIT_CREDENTIALS: "1" }),
        Effect.provideService(HostProcess.WorkingDirectory, "/trusted"),
      );
    },
  );

  it.effect.each(
    ["Settings", "GH_TOKEN", "GITHUB_TOKEN"].flatMap((source) =>
      ["refusal", "request failure"].map((failure) => ({ source, failure })),
    ),
  )(
    "preserves $source $failure diagnostics in repository discovery fallback",
    ({ source, failure }) => {
      const savedToken = source === "Settings";
      const diagnostic =
        failure === "refusal"
          ? savedToken
            ? "GitHub refused the token saved in Settings. Replace or remove it in Settings → Source Control."
            : `GitHub refused the token in ${source}. Replace it, or unset it to use \`gh auth login\`.`
          : `Could not check ${savedToken ? "the token saved in Settings" : `the token in ${source}`}: Could not reach GitHub at github.com.`;
      let requests = 0;
      return Effect.gen(function* () {
        const discovery = yield* GitHubSourceControlProvider.makeDiscovery;
        const available = yield* discovery.probe("/untrusted-checkout");
        expect(available.status).toBe("available");
        expect(available.auth.status).toBe("unknown");
        expect(Option.isNone(available.auth.account)).toBe(true);
        expect(Option.getOrNull(available.auth.host)).toBe("github.com");
        expect(Option.getOrNull(available.auth.detail)).toBe(
          `${diagnostic} Git credentials are resolved per repository. Enter an owner/repository or GitHub URL; host-wide operations still need a default GitHub credential.`,
        );
        expect(requests).toBe(1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(GitHubApi.GitHubRest)({
              rest: (input) => {
                expect(input).toEqual({ host: "github.com", operation: "discovery", path: "user" });
                requests++;
                return Effect.fail(
                  failure === "refusal"
                    ? new GitHubRequestPolicy.GitHubApiAuthenticationError({
                        host: "github.com",
                        operation: "discovery",
                      })
                    : new GitHubRequestPolicy.GitHubApiRequestError({
                        host: "github.com",
                        operation: "discovery",
                        cause: "synthetic offline",
                      }),
                );
              },
            }),
            TestSourceControlHost.layer({
              settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
                sourceControlHosts: {
                  github: { tokens: savedToken ? { "github.com": "synthetic-token" } : {} },
                },
              }),
              process: {
                run: (input) => {
                  if (input.command === "git") {
                    expect(input.args).toEqual(["--version"]);
                    expect(input.cwd).toBe("/trusted");
                  }
                  return Effect.succeed(
                    TestSourceControlHost.processOutput(
                      input.command === "git" ? "git version 2.43.0\n" : "",
                      { exitCode: ChildProcessSpawner.ExitCode(input.command === "git" ? 0 : 1) },
                    ),
                  );
                },
              },
            }),
          ),
        ),
        Effect.provideService(HostProcess.Environment, {
          T3CODE_GITHUB_USE_GIT_CREDENTIALS: "1",
          ...(savedToken ? {} : { [source]: "synthetic-token" }),
        }),
        Effect.provideService(HostProcess.WorkingDirectory, "/trusted"),
      );
    },
  );

  it.effect(
    "keeps create-owner identity and repository creation on the explicit repository credential",
    () => {
      const { layer, requests, helperPaths } = harness();
      return Effect.gen(function* () {
        const provider = yield* GitHubSourceControlProvider.make;
        for (const repository of ["OwnerA/NewRepo", "OwnerB/NewRepo"]) {
          // The mock intentionally refuses creation; this is a routing check, not a mutation.
          yield* provider
            .createRepository({ cwd: "/synthetic-checkout", repository, visibility: "private" })
            .pipe(Effect.result);
        }
        expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
          "/user",
          "/orgs/OwnerA/repos",
          "/user",
          "/orgs/OwnerB/repos",
        ]);
        expect(requests.map((request) => request.headers.authorization)).toEqual([
          "Bearer fake-OwnerA-1",
          "Bearer fake-OwnerA-1",
          "Bearer fake-OwnerB-1",
          "Bearer fake-OwnerB-1",
        ]);
        expect(helperPaths).toEqual(["OwnerA/NewRepo.git", "OwnerB/NewRepo.git"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("pins create-owner identity and creation across a Settings token rotation", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const helperPaths: string[] = [];
    const host = TestSourceControlHost.layer({
      settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        sourceControlHosts: { github: { tokens: { "github.com": "synthetic-A" } } },
      }),
      process: {
        run: (input) =>
          Effect.sync(() => {
            expect(input.command).toBe("git");
            helperPaths.push(/path=(.*)\n/.exec(input.stdin ?? "")?.[1] ?? "");
            return {
              exitCode: ChildProcessSpawner.ExitCode(128),
              stdout: "",
              stderr:
                "fatal: could not read Username for 'https://github.com/Alice/NewRepo.git': terminal prompts disabled\n",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      },
    });
    const http = Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
        return HttpClient.make((request) =>
          Effect.gen(function* () {
            requests.push(request);
            const owner = request.headers.authorization === "Bearer synthetic-A" ? "Alice" : "Bob";
            const isViewer = new URL(request.url).pathname === "/user";
            if (isViewer) {
              yield* settings.update({
                sourceControlHosts: { github: { tokens: { "github.com": "synthetic-B" } } },
              });
            }
            const body = isViewer
              ? { id: owner === "Alice" ? 1 : 2, login: owner }
              : {
                  full_name: `${owner}/NewRepo`,
                  html_url: `https://github.com/${owner}/NewRepo`,
                  ssh_url: `git@github.com:${owner}/NewRepo.git`,
                };
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(body), {
                headers: { "content-type": "application/json" },
              }),
            );
          }),
        );
      }),
    ).pipe(Layer.provide(host));
    const layer = GitHubApi.layerWithDependencies.pipe(
      Layer.provideMerge(http),
      Layer.provideMerge(host),
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(
        Layer.succeed(HostProcess.Environment, { T3CODE_GITHUB_USE_GIT_CREDENTIALS: "1" }),
      ),
      Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/trusted")),
    );
    return Effect.gen(function* () {
      const provider = yield* GitHubSourceControlProvider.make;
      const input = { cwd: "/synthetic-checkout", visibility: "private" as const };
      const first = yield* provider.createRepository({ ...input, repository: "Alice/NewRepo" });
      expect(requests.map((request) => request.headers.authorization)).toEqual([
        "Bearer synthetic-A",
        "Bearer synthetic-A",
      ]);
      expect(first).toEqual({
        nameWithOwner: "Alice/NewRepo",
        url: "https://github.com/Alice/NewRepo",
        sshUrl: "git@github.com:Alice/NewRepo.git",
      });
      const api = yield* GitHubApi.GitHubRest;
      yield* api.rest({
        host: "github.com",
        repository: "Alice/NewRepo",
        operation: "getViewer",
        path: "user",
      });
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/user",
        "/user/repos",
        "/user",
      ]);
      expect(requests[2]?.headers.authorization).toBe("Bearer synthetic-B");
      expect(helperPaths).toEqual(["Alice/NewRepo.git"]);
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcess.Environment, { T3CODE_GITHUB_USE_GIT_CREDENTIALS: "1" }),
    );
  });

  it.effect("routes repository lookup before cloning for shorthand and full URLs", () => {
    const { layer, requests, helperPaths } = harness();
    return Effect.gen(function* () {
      const provider = yield* GitHubSourceControlProvider.make;
      for (const repository of ["OwnerA/Repo", "https://github.com/OwnerB/Repo.git"]) {
        yield* provider.getRepositoryCloneUrls({ cwd: "/checkout-does-not-exist", repository });
      }
      expect(requests.map((request) => request.headers.authorization)).toEqual([
        "Bearer fake-OwnerA-1",
        "Bearer fake-OwnerB-1",
      ]);
      expect(helperPaths).toEqual(["OwnerA/Repo.git", "OwnerB/Repo.git"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "keeps host-only discovery on the default and repository viewers distinct by PAT",
    () => {
      const { layer, requests, helperPaths } = harness();
      return Effect.gen(function* () {
        const api = yield* GitHubApi.GitHubRest;
        const prs = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        yield* api.rest({ host: "github.com", operation: "discovery", path: "user" });
        for (const repository of ["OwnerA/Repo", "OwnerB/Repo", "OwnerA/Repo"]) {
          expect(
            yield* prs.getRoutingIdentity({ cwd: "/w", host: "github.com", repository }),
          ).toEqual({ accountId: "123", viewer: "Chinoman10" });
        }
        expect(requests.map((request) => request.headers.authorization)).toEqual([
          "Bearer host-default",
          "Bearer fake-OwnerA-1",
          "Bearer fake-OwnerB-1",
        ]);
        expect(helperPaths).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("rejects a repository-scoped pin for another repository or host before HTTP", () => {
    const { layer, requests } = harness();
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubRest;
      const prs = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const errors = yield* prs.withVerifiedCredential(
        { cwd: "/w", host: "github.com", repository: "OwnerA/Repo" },
        () =>
          Effect.all([
            api
              .rest({
                host: "github.com",
                repository: "OwnerB/Repo",
                operation: "test",
                path: "repos/OwnerB/Repo",
              })
              .pipe(Effect.flip),
            api
              .rest({
                host: "evil.example",
                repository: "OwnerA/Repo",
                operation: "test",
                path: "user",
              })
              .pipe(Effect.flip),
          ]),
      );
      expect(errors.map((error) => error._tag)).toEqual([
        "GitHubApiAuthenticationError",
        "GitHubApiAuthenticationError",
      ]);
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("invalidates only the refused repository with no default-token retry", () => {
    const { layer, requests, helperPaths, refused, rotate } = harness();
    return Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubRest;
      yield* api.credential("github.com", "OwnerB/Repo");
      refused.add("Bearer fake-OwnerA-1");
      const error = yield* api
        .rest({
          host: "github.com",
          repository: "OwnerA/Repo",
          operation: "test",
          path: "repos/OwnerA/Repo",
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("GitHubApiAuthenticationError");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.authorization).toBe("Bearer fake-OwnerA-1");
      rotate();
      expect(Redacted.value((yield* api.credential("github.com", "OwnerA/Repo")).token)).toBe(
        "fake-OwnerA-2",
      );
      expect(Redacted.value((yield* api.credential("github.com", "OwnerB/Repo")).token)).toBe(
        "fake-OwnerB-1",
      );
      expect(helperPaths).toEqual(["OwnerB/Repo.git", "OwnerA/Repo.git", "OwnerA/Repo.git"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("separates summary/watch GraphQL batches even for PATs with the same login", () => {
    const { layer, requests } = harness();
    return Effect.gen(function* () {
      const prs = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      for (const read of [prs.getPullRequestSummary, prs.getPullRequestWatchFingerprint]) {
        const pending = yield* Effect.all(
          ["OwnerA/Repo", "OwnerB/Repo"].map((repository) =>
            Effect.gen(function* () {
              yield* read({ cwd: "/w", host: "github.com", repository, number: 1 });
            }).pipe(Effect.flip),
          ),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 millis");
        const errors = yield* Fiber.join(pending);
        expect(errors.map((error) => error._tag)).toEqual([
          "GitHubApiNotFoundError",
          "GitHubApiNotFoundError",
        ]);
      }
      const queries = requests.filter((request) => new URL(request.url).pathname === "/graphql");
      expect(queries).toHaveLength(4);
      expect(queries.map((request) => request.headers.authorization).sort()).toEqual([
        "Bearer fake-OwnerA-1",
        "Bearer fake-OwnerA-1",
        "Bearer fake-OwnerB-1",
        "Bearer fake-OwnerB-1",
      ]);
    }).pipe(Effect.provide(layer));
  });
  it.effect("keeps the same token scoped to each repository in summary batches", () => {
    const { layer, requests, helperPaths } = harness(404, false, { sameToken: true });
    return Effect.gen(function* () {
      const prs = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const pending = yield* Effect.forEach(
        ["OwnerA/Repo", "OwnerB/Repo"],
        (repository) =>
          prs
            .getPullRequestSummary({ cwd: "/w", host: "github.com", repository, number: 1 })
            .pipe(Effect.flip),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(pending);
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.headers.authorization)).toEqual([
        "Bearer fake-shared-1",
        "Bearer fake-shared-1",
      ]);
      expect(helperPaths).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["open", "all"] as const)(
    "separates source head resolver credentials for %s lookups",
    (state) => {
      const { layer, requests } = harness(401, true);
      return Effect.gen(function* () {
        const provider = yield* GitHubSourceControlProvider.make;
        const pending = yield* Effect.forEach(
          ["OwnerA", "OwnerB"],
          (owner) =>
            provider.listChangeRequests({
              cwd: "/w",
              state,
              headSelector: "feature",
              context: {
                provider: {
                  kind: SourceControlProviderKind.make("github"),
                  name: "GitHub",
                  baseUrl: "https://github.com",
                },
                remoteName: "origin",
                remoteUrl: `https://github.com/${owner}/Repo.git`,
              },
            }),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("500 millis");
        expect(yield* Fiber.join(pending)).toEqual([[], []]);
        expect(requests).toHaveLength(2);
        expect(requests.map((request) => request.headers.authorization).sort()).toEqual([
          "Bearer fake-OwnerA-1",
          "Bearer fake-OwnerB-1",
        ]);
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(HostProcess.Environment, { T3CODE_GITHUB_USE_GIT_CREDENTIALS: "1" }),
      );
    },
  );

  it.effect.each([401, 403, 404])("makes only one GraphQL attempt after HTTP %s", (status) => {
    const { layer, requests, refused } = harness(status);
    refused.add("Bearer fake-OwnerA-1");
    return Effect.gen(function* () {
      const prs = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const pending = yield* prs
        .getPullRequestSummary({
          cwd: "/w",
          host: "github.com",
          repository: "OwnerA/Repo",
          number: 1,
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("10 millis");
      expect((yield* Fiber.join(pending))._tag).toBe(
        status === 401
          ? "GitHubApiAuthenticationError"
          : status === 404
            ? "GitHubApiNotFoundError"
            : "GitHubApiResponseError",
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.authorization).toBe("Bearer fake-OwnerA-1");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects context-free requests under a repository pin", () => {
    const { layer, requests } = harness();
    return Effect.gen(function* () {
      const prs = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const api = yield* GitHubApi.GitHubRest;
      const error = yield* prs.withVerifiedCredential(
        { cwd: "/w", host: "github.com", repository: "OwnerA/Repo" },
        () => api.rest({ host: "github.com", operation: "test", path: "user" }).pipe(Effect.flip),
      );
      expect(error._tag).toBe("GitHubApiAuthenticationError");
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not share the node-id cache after a repository token rotates", () => {
    const { layer, requests, rotate } = harness(401, true);
    return Effect.gen(function* () {
      const prs = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const ref = { cwd: "/w", host: "github.com", repository: "OwnerA/Repo", number: 1 };
      yield* prs.commentOnPullRequest({ ...ref, body: "first" });
      rotate();
      yield* TestClock.adjust("5 minutes");
      yield* prs.commentOnPullRequest({ ...ref, body: "second" });
      expect(requests).toHaveLength(4);
      expect(requests.map((request) => request.headers.authorization)).toEqual([
        "Bearer fake-OwnerA-1",
        "Bearer fake-OwnerA-1",
        "Bearer fake-OwnerA-2",
        "Bearer fake-OwnerA-2",
      ]);
    }).pipe(Effect.provide(layer));
  });
});
