import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  SourceControlProviderKind,
  VcsRepositoryDetectionError,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Provider from "./CodeCommitSourceControlProvider.ts";

const context = {
  provider: {
    kind: SourceControlProviderKind.make("aws-codecommit"),
    name: "AWS CodeCommit",
    baseUrl: "https://git-codecommit.us-east-1.amazonaws.com",
  },
  remoteName: "origin",
  remoteUrl: "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/Repo",
};
const pullRequest = (id: string, merged: boolean, repositoryName = "Repo") =>
  JSON.stringify({
    pullRequest: {
      pullRequestId: id,
      title: `PR ${id}`,
      pullRequestStatus: "CLOSED",
      lastActivityDate: "2025-02-03T04:05:06Z",
      pullRequestTargets: [
        {
          repositoryName,
          sourceReference: "refs/heads/feature",
          destinationReference: "refs/heads/main",
          sourceCommit: "abc",
          mergeMetadata: { isMerged: merged },
        },
      ],
    },
  });

it.effect(
  "pages and distinguishes merged from closed while applying remote region and configured profile",
  () => {
    const calls: ReadonlyArray<string>[] = [];
    return Effect.gen(function* () {
      const provider = yield* Provider.make;
      const results = yield* provider.listChangeRequests({
        cwd: "/repo",
        context,
        headSelector: "feature",
        state: "merged",
      });
      assert.deepStrictEqual(
        results.map((pr) => [pr.number, pr.state, pr.headRefName, pr.baseRefName]),
        [[2, "merged", "feature", "main"]],
      );
      assert.strictEqual(
        results[0]!.repositoryKey,
        "git-codecommit.us-east-1.amazonaws.com/123456789012/v1/repos/Repo",
      );
      assert.strictEqual(calls.filter((args) => args[1] === "get-repository").length, 1);
      assert.isTrue(Option.isSome(results[0]!.updatedAt));
      assert.isTrue(
        calls.every(
          (args) =>
            args.includes("--profile") &&
            args.includes("work") &&
            args.includes("us-east-1") &&
            !args.includes("eu-west-1"),
        ),
      );
      assert.isTrue(calls.some((args) => args.includes("--next-token") && args.includes("next")));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          TestSourceControlHost.layer({
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              sourceControlHosts: {
                ...DEFAULT_SERVER_SETTINGS.sourceControlHosts,
                "aws-codecommit": { profile: "work", region: "eu-west-1" },
              },
            },
            process: {
              run: ({ args }) => {
                calls.push(args);
                const op = args[1];
                return Effect.succeed(
                  TestSourceControlHost.processOutput(
                    op === "get-repository"
                      ? metadata()
                      : op === "list-pull-requests"
                        ? JSON.stringify(
                            args.includes("--next-token")
                              ? { pullRequestIds: ["2"] }
                              : { pullRequestIds: ["1"], nextToken: "next" },
                          )
                        : pullRequest(
                            args[args.indexOf("--pull-request-id") + 1]!,
                            args.includes("2"),
                          ),
                  ),
                );
              },
            },
          }),
        ),
      ),
    );
  },
);

it.effect("rejects links for another repository or region and verifies the API target", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.make;
    for (const reference of [
      "https://us-east-1.console.aws.amazon.com/codesuite/codecommit/repositories/Other/pull-requests/1/details?region=us-east-1",
      "https://eu-west-1.console.aws.amazon.com/codesuite/codecommit/repositories/Repo/pull-requests/1/details?region=eu-west-1",
      "1",
    ]) {
      const result = yield* Effect.result(
        provider.getChangeRequest({ cwd: "/repo", context, reference }),
      );
      assert.isTrue(Result.isFailure(result));
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        TestSourceControlHost.layer({
          process: {
            run: () =>
              Effect.succeed(TestSourceControlHost.processOutput(pullRequest("1", false, "Other"))),
          },
        }),
      ),
    ),
  ),
);

it.effect("refuses public repository creation without running AWS", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.make;
    const result = yield* Effect.result(
      provider.createRepository({ cwd: "/repo", repository: "Repo", visibility: "public" }),
    );
    assert.isTrue(Result.isFailure(result));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestSourceControlHost.layer()))),
);

const metadata = (repositoryName = "Repo", accountId = "123456789012") =>
  JSON.stringify({
    repositoryMetadata: {
      repositoryName,
      accountId,
      Arn: `arn:aws:codecommit:us-east-1:${accountId}:${repositoryName}`,
      cloneUrlHttp: `https://git-codecommit.us-east-1.amazonaws.com/v1/repos/${repositoryName}`,
      cloneUrlSsh: `ssh://git-codecommit.us-east-1.amazonaws.com/v1/repos/${repositoryName}`,
      defaultBranch: "main",
    },
  });

it.effect("reads full clone URLs in their region and rejects inconsistent AWS metadata", () => {
  const calls: ReadonlyArray<string>[] = [];
  let badMetadata = true;
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    const failure = yield* Effect.result(
      provider.getRepositoryCloneUrls({ cwd: "/repo", repository: context.remoteUrl }),
    );
    assert.isTrue(Result.isFailure(failure));
    badMetadata = false;
    const urls = yield* provider.getRepositoryCloneUrls({
      cwd: "/repo",
      repository: context.remoteUrl,
    });
    assert.strictEqual(urls.nameWithOwner, "Repo");
    assert.isTrue(calls[0]!.includes("us-east-1"));
    assert.strictEqual(calls.length, 2);
    const fipsUrl = context.remoteUrl.replace("git-codecommit.", "git-codecommit-fips.");
    assert.strictEqual(
      (yield* provider.getRepositoryCloneUrls({ cwd: "/repo", repository: fipsUrl })).url,
      fipsUrl,
    );
    const hosted = yield* provider.getRepositoryCloneUrls({
      cwd: "/repo",
      context,
      repository: "Repo",
      host: "us-east-1.console.aws.amazon.com",
    });
    assert.strictEqual(hosted.url, context.remoteUrl);
    assert.isTrue(
      Result.isFailure(
        yield* Effect.result(
          provider.getRepositoryCloneUrls({
            cwd: "/repo",
            context,
            repository: "Repo",
            host: "us-west-2.console.aws.amazon.com",
          }),
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        TestSourceControlHost.layer({
          process: {
            run: ({ args }) => {
              calls.push(args);
              return Effect.succeed(
                TestSourceControlHost.processOutput(
                  metadata("Repo", badMetadata ? "bad" : "123456789012"),
                ),
              );
            },
          },
        }),
      ),
    ),
  );
});

it.effect("checks out a verified pull request by resetting from its remote tracking ref", () => {
  const actions: string[] = [];
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    yield* provider.checkoutChangeRequest({ cwd: "/repo", context, reference: "1", force: true });
    assert.deepStrictEqual(actions, [
      "fetch:feature",
      "checkout --no-track -B feature refs/remotes/origin/feature --",
      "upstream:feature",
      "switch:feature",
    ]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        TestSourceControlHost.layer({
          process: {
            run: ({ args }) =>
              Effect.succeed(
                TestSourceControlHost.processOutput(
                  args[1] === "get-repository" ? metadata() : pullRequest("1", false),
                ),
              ),
          },
          git: {
            listLocalBranchNames: () => Effect.succeed(["feature"]),
            fetchRemoteTrackingBranch: ({ remoteBranch }) =>
              Effect.sync(() => {
                actions.push(`fetch:${remoteBranch}`);
              }),
            execute: ({ args }) =>
              Effect.sync(() => {
                actions.push(args.join(" "));
                return TestSourceControlHost.processOutput("");
              }),
            setBranchUpstream: ({ branch }) =>
              Effect.sync(() => {
                actions.push(`upstream:${branch}`);
              }),
            switchRef: ({ refName }) =>
              Effect.sync(() => {
                actions.push(`switch:${refName}`);
                return { refName, previousRefName: null };
              }),
          },
        }),
      ),
    ),
  );
});

it.effect("refines an identity only after verifying account and repository metadata", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.make;
    const identity = {
      canonicalKey: "old",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: context.remoteUrl,
      },
      rootPath: "/repo",
    };
    const refined = yield* provider.refineRepositoryIdentity!({
      identity,
      resolveContext: () => Effect.succeed(null),
    });
    assert.strictEqual(
      refined?.canonicalKey,
      "git-codecommit.us-east-1.amazonaws.com/123456789012/v1/repos/Repo",
    );
    assert.strictEqual(refined?.owner, "123456789012");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        TestSourceControlHost.layer({
          process: { run: () => Effect.succeed(TestSourceControlHost.processOutput(metadata())) },
        }),
      ),
    ),
  ),
);

it.effect(
  "creates private repositories from returned metadata and rejects repeated pagination tokens",
  () => {
    const calls: ReadonlyArray<string>[] = [];
    return Effect.gen(function* () {
      const provider = yield* Provider.make;
      const repo = yield* provider.createRepository({
        cwd: "/repo",
        repository: "Repo",
        visibility: "private",
      });
      assert.strictEqual(repo.url, context.remoteUrl);
      const failure = yield* Effect.result(
        provider.listChangeRequests({
          cwd: "/repo",
          context,
          headSelector: "feature",
          state: "all",
        }),
      );
      assert.isTrue(Result.isFailure(failure));
      assert.strictEqual(calls.filter((args) => args[1] === "list-pull-requests").length, 2);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          TestSourceControlHost.layer({
            process: {
              run: ({ args }) => {
                calls.push(args);
                return Effect.succeed(
                  TestSourceControlHost.processOutput(
                    args[1] === "create-repository" || args[1] === "get-repository"
                      ? metadata()
                      : JSON.stringify({ pullRequestIds: [], nextToken: "repeat" }),
                  ),
                );
              },
            },
          }),
        ),
      ),
    );
  },
);

it.effect("does not issue a checkout for a pull request belonging to another repository", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.make;
    const failure = yield* Effect.result(
      provider.checkoutChangeRequest({ cwd: "/repo", context, reference: "1", force: true }),
    );
    assert.isTrue(Result.isFailure(failure));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        TestSourceControlHost.layer({
          process: {
            run: () =>
              Effect.succeed(TestSourceControlHost.processOutput(pullRequest("1", false, "Other"))),
          },
        }),
      ),
    ),
  ),
);

it.effect("clones a bare name without a git checkout using the configured region", () => {
  const calls: ReadonlyArray<string>[] = [];
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    const result = yield* provider.getRepositoryCloneUrls({ cwd: "/empty", repository: "Repo" });
    assert.strictEqual(result.nameWithOwner, "Repo");
    assert.isTrue(calls[0]!.includes("us-east-1"));
    const hosted = yield* provider.getRepositoryCloneUrls({
      cwd: "/empty",
      repository: "Repo",
      host: "us-east-1.console.aws.amazon.com",
    });
    assert.strictEqual(hosted.url, result.url);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        TestSourceControlHost.layer({
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sourceControlHosts: {
              ...DEFAULT_SERVER_SETTINGS.sourceControlHosts,
              "aws-codecommit": { profile: "work", region: "us-east-1" },
            },
          },
          git: {
            remotes: () =>
              Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "remotes",
                  cwd: "/empty",
                  detail: "not a repository",
                }),
              ),
          },
          process: {
            run: ({ args }) => {
              calls.push(args);
              return Effect.succeed(TestSourceControlHost.processOutput(metadata()));
            },
          },
        }),
      ),
    ),
  );
});

it.effect("creates pull requests with source and destination refs in JSON", () => {
  let args: ReadonlyArray<string> = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bodyFile = yield* fs.makeTempFileScoped();
    yield* fs.writeFileString(bodyFile, "body");
    const provider = yield* Provider.make;
    yield* provider.createChangeRequest({
      cwd: "/repo",
      context,
      headSelector: "feature",
      baseRefName: "main",
      target: { refName: "release" },
      title: "--title",
      bodyFile,
    });
    assert.deepStrictEqual(JSON.parse(args[args.indexOf("--cli-input-json") + 1]!), {
      title: "--title",
      description: "body",
      targets: [
        { repositoryName: "Repo", sourceReference: "feature", destinationReference: "release" },
      ],
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        TestSourceControlHost.layer({
          process: {
            run: (input) => {
              args = input.args;
              return Effect.succeed(TestSourceControlHost.processOutput("{}"));
            },
          },
        }),
      ),
    ),
  );
});

it.effect("surfaces a useful authentication error without exposing CLI output", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.make;
    const result = yield* Effect.result(
      provider.getChangeRequest({ cwd: "/repo", context, reference: "1" }),
    );
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result))
      assert.match(result.failure.detail, /credentials.*expired.*access was denied/i);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        TestSourceControlHost.layer({
          process: {
            run: () =>
              Effect.fail(
                new VcsProcessExitError({
                  operation: "CodeCommit.execute",
                  command: "aws",
                  cwd: "/repo",
                  exitCode: 1,
                  detail: "Authentication failed.",
                  failureKind: "authentication",
                }),
              ),
          },
        }),
      ),
    ),
  ),
);

it.effect("updates the identity cache key when the selected profile changes", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.make;
    const state = yield* TestSourceControlHost.TestSourceControlHostSettings;
    const before = yield* provider.repositoryIdentityCacheKey!;
    yield* state.update({
      sourceControlHosts: { "aws-codecommit": { profile: "other", region: "us-east-1" } },
    });
    const after = yield* provider.repositoryIdentityCacheKey!;
    assert.notStrictEqual(before, after);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestSourceControlHost.layer()))),
);

it.effect(
  "probes AWS credentials with the selected profile and reports the permission limit",
  () => {
    const calls: ReadonlyArray<string>[] = [];
    return Effect.gen(function* () {
      const discovery = yield* Provider.makeDiscovery;
      const result = yield* discovery.probe("/repo");
      assert.strictEqual(result.auth.status, "authenticated");
      assert.match(String(result.auth.detail), /CodeCommit permissions/);
      const sts = calls.find((args) => args[0] === "sts")!;
      assert.deepStrictEqual(sts.slice(-4), ["--profile", "work", "--region", "us-east-1"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          TestSourceControlHost.layer({
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              sourceControlHosts: {
                ...DEFAULT_SERVER_SETTINGS.sourceControlHosts,
                "aws-codecommit": { profile: "work", region: "us-east-1" },
              },
            },
            process: {
              run: ({ args }) => {
                calls.push(args);
                return Effect.succeed(
                  TestSourceControlHost.processOutput(
                    args[0] === "sts" ? '{"Account":"123456789012"}' : "aws-cli/2.0",
                  ),
                );
              },
            },
          }),
        ),
      ),
    );
  },
);

it.effect("uses the selected account for pull requests and omits owner-qualified probes", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.make;
    const state = yield* TestSourceControlHost.TestSourceControlHostSettings;
    const first = yield* provider.getChangeRequest({ cwd: "/repo", context, reference: "1" });
    yield* state.update({
      sourceControlHosts: { "aws-codecommit": { profile: "other", region: "us-east-1" } },
    });
    const second = yield* provider.getChangeRequest({ cwd: "/repo", context, reference: "1" });
    assert.strictEqual(
      first.repositoryKey,
      "git-codecommit.us-east-1.amazonaws.com/123456789012/v1/repos/Repo",
    );
    assert.strictEqual(
      second.repositoryKey,
      "git-codecommit.us-east-1.amazonaws.com/999999999999/v1/repos/Repo",
    );
    assert.deepStrictEqual(
      provider.headBranchProbe!({ headSelectors: ["feature", "owner:feature"], state: "open" })
        .headSelectors,
      ["feature"],
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        TestSourceControlHost.layer({
          process: {
            run: ({ args }) =>
              Effect.succeed(
                TestSourceControlHost.processOutput(
                  args[1] === "get-repository"
                    ? metadata("Repo", args.includes("other") ? "999999999999" : "123456789012")
                    : pullRequest("1", false),
                ),
              ),
          },
        }),
      ),
    ),
  ),
);

it.effect("shares concurrent reads and clears cached results after a write", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    const read = provider.getChangeRequest({ cwd: "/repo", context, reference: "1" });
    const [first, second] = yield* Effect.all([read, read], { concurrency: "unbounded" });
    assert.strictEqual(first.repositoryKey, second.repositoryKey);
    assert.deepStrictEqual(calls, ["get-pull-request", "get-repository"]);
    yield* provider.createRepository({ cwd: "/repo", repository: "Repo", visibility: "private" });
    yield* read;
    assert.deepStrictEqual(calls, [
      "get-pull-request",
      "get-repository",
      "create-repository",
      "get-pull-request",
      "get-repository",
    ]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        TestSourceControlHost.layer({
          process: {
            run: ({ args }) => {
              calls.push(args[1]!);
              return Effect.succeed(
                TestSourceControlHost.processOutput(
                  args[1] === "get-pull-request" ? pullRequest("1", false) : metadata(),
                ),
              );
            },
          },
        }),
      ),
    ),
  );
});

it.effect("holds one selected profile for every call in a list operation", () => {
  const calls: ReadonlyArray<string>[] = [];
  let update: Effect.Effect<void> = Effect.void;
  return Effect.gen(function* () {
    const state = yield* TestSourceControlHost.TestSourceControlHostSettings;
    update = state.update({
      sourceControlHosts: { "aws-codecommit": { profile: "other", region: "us-east-1" } },
    });
    const provider = yield* Provider.make;
    const result = yield* provider.listChangeRequests({
      cwd: "/repo",
      context,
      headSelector: "feature",
      state: "closed",
    });
    assert.strictEqual(
      result[0]!.repositoryKey,
      "git-codecommit.us-east-1.amazonaws.com/123456789012/v1/repos/Repo",
    );
    assert.isTrue(calls.every((args) => args.includes("first") && !args.includes("other")));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        TestSourceControlHost.layer({
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sourceControlHosts: {
              ...DEFAULT_SERVER_SETTINGS.sourceControlHosts,
              "aws-codecommit": { profile: "first", region: "us-east-1" },
            },
          },
          process: {
            run: ({ args }) => {
              calls.push(args);
              const response =
                args[1] === "get-repository"
                  ? metadata()
                  : args[1] === "list-pull-requests"
                    ? JSON.stringify({ pullRequestIds: ["1"] })
                    : pullRequest("1", false);
              return (args[1] === "get-repository" ? update : Effect.void).pipe(
                Effect.as(TestSourceControlHost.processOutput(response)),
              );
            },
          },
        }),
      ),
    ),
  );
});

it.effect("does not publish an identity when the account cannot be verified", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.make;
    const identity = {
      canonicalKey: "old",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: context.remoteUrl,
      },
      rootPath: "/repo",
    };
    const refined = yield* provider.refineRepositoryIdentity!({
      identity,
      resolveContext: () => Effect.succeed(null),
    });
    assert.isNull(refined);
    const missingRoot = yield* provider.refineRepositoryIdentity!({
      identity: { canonicalKey: "old", locator: identity.locator },
      resolveContext: () => Effect.succeed(null),
    });
    assert.isNull(missingRoot);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        TestSourceControlHost.layer({
          process: {
            run: () => Effect.succeed(TestSourceControlHost.processOutput(metadata("Repo", "bad"))),
          },
        }),
      ),
    ),
  ),
);

it.effect(
  "resolves helper profiles and regions before verifying identity and preserves clone credentials",
  () => {
    const calls: ReadonlyArray<string>[] = [];
    const helperUrl = "codecommit://self@Repo";
    return Effect.gen(function* () {
      const provider = yield* Provider.make;
      const identity = {
        canonicalKey: "old",
        locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: helperUrl },
        rootPath: "/repo",
      };
      const refined = yield* provider.refineRepositoryIdentity!({
        identity,
        resolveContext: () => Effect.succeed(null),
      });
      assert.strictEqual(
        refined?.canonicalKey,
        "git-codecommit.us-east-1.amazonaws.com/123456789012/v1/repos/Repo",
      );
      const urls = yield* provider.getRepositoryCloneUrls({ cwd: "/repo", repository: helperUrl });
      assert.strictEqual(urls.url, helperUrl);
      assert.strictEqual(urls.sshUrl, helperUrl);
      assert.isTrue(calls.every((args) => args.includes("self")));
      assert.isTrue(calls.some((args) => args[0] === "configure"));
      const branch = yield* provider.getDefaultBranch({ cwd: "/repo" });
      assert.strictEqual(branch, "main");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          TestSourceControlHost.layer({
            git: {
              remotes: () =>
                Effect.succeed(
                  Effect.succeed({
                    remotes: [
                      { name: "origin", url: helperUrl, isPrimary: true, pushUrl: Option.none() },
                    ],
                    freshness: {
                      source: "live-local",
                      observedAt: DateTime.makeUnsafe(0),
                      expiresAt: Option.none(),
                    },
                  }),
                ),
            },
            process: {
              run: ({ args }) => {
                calls.push(args);
                return Effect.succeed(
                  TestSourceControlHost.processOutput(
                    args[0] === "configure" ? "us-east-1\n" : metadata(),
                  ),
                );
              },
            },
          }),
        ),
      ),
    );
  },
);

it.effect("rejects a helper profile conflicting with the selected profile", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.make;
    const result = yield* Effect.result(
      provider.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "codecommit::us-east-1://self@Repo",
      }),
    );
    assert.isTrue(Result.isFailure(result));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        TestSourceControlHost.layer({
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sourceControlHosts: {
              ...DEFAULT_SERVER_SETTINGS.sourceControlHosts,
              "aws-codecommit": { profile: "other", region: "us-east-1" },
            },
          },
          process: { run: () => Effect.die("must not call AWS") },
        }),
      ),
    ),
  ),
);
