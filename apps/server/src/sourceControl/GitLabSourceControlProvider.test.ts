import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitLabCli from "./GitLabCli.ts";
import { parseGitLabAuthStatusHosts } from "./gitLabAuthStatus.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";

function makeProvider(gitlab: Partial<GitLabCli.GitLabCli["Service"]>) {
  return GitLabSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(GitLabCli.GitLabCli)(gitlab)),
  );
}

it.effect("maps GitLab MR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getMergeRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add GitLab provider",
          url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "closed",
          closedAt: "2026-08-23T10:00:00Z",
          isCrossRepository: true,
          headRepositoryNameWithOwner: "fork/t3code",
          headRepositoryOwnerLogin: "fork",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "gitlab",
      number: 42,
      title: "Add GitLab provider",
      url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "closed",
      closedAt: "2026-08-23T10:00:00Z",
      mergedAt: null,
      updatedAt: Option.none(),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "fork/t3code",
      headRepositoryOwnerLogin: "fork",
    });
  }),
);

it.effect("adds repository context while retaining GitLab CLI causes", () =>
  Effect.gen(function* () {
    const cause = new GitLabCli.GitLabCliCommandError({
      operation: "execute",
      command: "glab",
      cwd: "/repo",
      cause: new Error("raw upstream detail that should remain in the cause"),
    });
    const provider = yield* makeProvider({
      createRepository: () => Effect.fail(cause),
    });

    const error = yield* provider
      .createRepository({
        cwd: "/repo",
        repository: "owner/repo",
        visibility: "private",
      })
      .pipe(Effect.flip);

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        command: error.command,
        cwd: error.cwd,
        repository: error.repository,
        detail: error.detail,
      },
      {
        provider: "gitlab",
        operation: "createRepository",
        command: "glab",
        cwd: "/repo",
        repository: "owner/repo",
        detail: "GitLab CLI command failed.",
      },
    );
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes("raw upstream detail"), false);
  }),
);

it.effect("lists GitLab MRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let listInput: Parameters<GitLabCli.GitLabCli["Service"]["listMergeRequests"]>[0] | null = null;
    const provider = yield* makeProvider({
      listMergeRequests: (input) => {
        listInput = input;
        return Effect.succeed([]);
      },
    });

    yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/provider",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(listInput, {
      cwd: "/repo",
      headSelector: "feature/provider",
      state: "all",
      limit: 10,
    });
  }),
);

it.effect("sanitizes GitLab list-MR errors before transport", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      listMergeRequests: () =>
        Effect.fail(
          new GitLabCli.GitLabCliCommandError({
            operation: "execute",
            command: "glab",
            cwd: "/repo",
            cause: new Error(
              "raw upstream https://secret:token@gitlab.example.test/group/repo?access_token=secret",
            ),
          }),
        ),
    });

    const error = yield* provider
      .listChangeRequests({
        cwd: "/repo",
        headSelector:
          "https://user:token@gitlab.example.test/group/repo?access_token=secret#fragment",
        state: "open",
      })
      .pipe(Effect.flip);

    assert.equal(error.provider, "gitlab");
    assert.equal(error.operation, "listChangeRequests");
    assert.equal(error.command, "glab");
    assert.equal(error.reference, "https://gitlab.example.test/group/repo");
    assert.equal(error.detail, "GitLab CLI command failed.");
    assert.deepStrictEqual(error.cause, {
      _tag: "GitLabCliCommandError",
      name: "GitLabCliCommandError",
      command: "glab",
      operation: "execute",
      detail: "GitLab CLI command failed.",
      message: "GitLab CLI failed in execute: GitLab CLI command failed.",
    });
  }),
);

it.effect("lists GitLab MRs against the requested remote repository context", () =>
  Effect.gen(function* () {
    let listInput: Parameters<GitLabCli.GitLabCli["Service"]["listMergeRequests"]>[0] | null = null;
    const provider = yield* makeProvider({
      listMergeRequests: (input) => {
        listInput = input;
        return Effect.succeed([]);
      },
    });

    yield* provider.listChangeRequests({
      cwd: "/repo",
      context: {
        provider: {
          kind: "gitlab",
          name: "GitLab Self-Hosted",
          baseUrl: "https://gitlab.example.test",
        },
        remoteName: "upstream",
        remoteUrl: "https://gitlab.example.test/group/subgroup/repo.git",
      },
      headSelector: "feature/provider",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(listInput, {
      cwd: "/repo",
      headSelector: "feature/provider",
      repository: "https://gitlab.example.test/group/subgroup/repo",
      state: "all",
      limit: 10,
    });
  }),
);

it.effect("does not duplicate a self-hosted GitLab base path", () =>
  Effect.gen(function* () {
    let listInput: Parameters<GitLabCli.GitLabCli["Service"]["listMergeRequests"]>[0] | null = null;
    const provider = yield* makeProvider({
      listMergeRequests: (input) => {
        listInput = input;
        return Effect.succeed([]);
      },
    });

    yield* provider.listChangeRequests({
      cwd: "/repo",
      context: {
        provider: {
          kind: "gitlab",
          name: "GitLab Self-Hosted",
          baseUrl: "https://gitlab.example.test/gitlab",
        },
        remoteName: "upstream",
        remoteUrl: "https://gitlab.example.test/gitlab/group/repo.git",
      },
      headSelector: "feature/provider",
      state: "open",
    });

    assert.deepStrictEqual(listInput, {
      cwd: "/repo",
      headSelector: "feature/provider",
      repository: "https://gitlab.example.test/gitlab/group/repo",
      state: "open",
    });
  }),
);

it.effect("uses GitLab Avatar API results for commit author avatars", () =>
  Effect.gen(function* () {
    let avatarInput: Parameters<GitLabCli.GitLabCli["Service"]["getCommitAvatarUrl"]>[0] | null =
      null;
    const provider = yield* makeProvider({
      getCommitAvatarUrl: (input) => {
        avatarInput = input;
        return Effect.succeed(
          "https://gitlab.example.test/uploads/-/system/user/avatar/123/avatar.png",
        );
      },
    });

    const avatarUrl = yield* provider.getCommitAvatarUrl({
      cwd: "/repo",
      context: {
        provider: {
          kind: "gitlab",
          name: "GitLab Self-Hosted",
          baseUrl: "https://gitlab.example.test",
        },
        remoteName: "upstream",
        remoteUrl: "https://gitlab.example.test/group/subgroup/repo.git",
      },
      sha: "abc123",
      authorEmail: "author@example.test",
    });

    assert.strictEqual(
      avatarUrl,
      "https://gitlab.example.test/uploads/-/system/user/avatar/123/avatar.png",
    );
    assert.deepStrictEqual(avatarInput, {
      cwd: "/repo",
      email: "author@example.test",
      providerBaseUrl: "https://gitlab.example.test",
    });
  }),
);

it.effect("does not call the GitLab Avatar API without a commit author email", () =>
  Effect.gen(function* () {
    let avatarLookupCount = 0;
    const provider = yield* makeProvider({
      getCommitAvatarUrl: () => {
        avatarLookupCount += 1;
        return Effect.succeed("https://gitlab.example.test/avatar.png");
      },
    });

    const avatarUrl = yield* provider.getCommitAvatarUrl({
      cwd: "/repo",
      sha: "abc123",
      authorEmail: null,
    });

    assert.strictEqual(avatarUrl, null);
    assert.strictEqual(avatarLookupCount, 0);
  }),
);

it.effect("creates GitLab MRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput: Parameters<GitLabCli.GitLabCli["Service"]["createMergeRequest"]>[0] | null =
      null;
    const provider = yield* makeProvider({
      createMergeRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "owner:feature/provider",
      title: "Provider MR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "owner:feature/provider",
      source: {
        owner: "owner",
        refName: "feature/provider",
      },
      title: "Provider MR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

it("accepts authenticated GitLab hosts when another configured host fails", () => {
  const auth = GitLabSourceControlProvider.discovery.parseAuth({
    exitCode: ChildProcessSpawner.ExitCode(1),
    stdout: `gitlab.com
  x gitlab.com: API call failed: 401 Unauthorized
  ! No token found
self-hosted.example.test
  ✓ Logged in to self-hosted.example.test as gitlab-user
  ✓ Token found: ******
`,
    stderr: "",
  });

  assert.deepStrictEqual(
    {
      status: auth.status,
      account: auth.account,
      host: auth.host,
    },
    {
      status: "authenticated",
      account: Option.some("gitlab-user"),
      host: Option.some("self-hosted.example.test"),
    },
  );
});

it("refines unknown GitLab remotes with mixed-case provider hosts", () => {
  const provider = GitLabSourceControlProvider.discovery.refineUnknownRemote?.({
    cwd: "/repo",
    context: {
      provider: {
        kind: "unknown",
        name: "Self-Hosted.Example.Test",
        baseUrl: "https://Self-Hosted.Example.Test",
      },
      remoteName: "origin",
      remoteUrl: "https://Self-Hosted.Example.Test/group/project.git",
    },
    auth: {
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: `self-hosted.example.test
  ✓ Logged in to self-hosted.example.test as gitlab-user
  ✓ Token found: ******
`,
      stderr: "",
    },
  });

  assert.deepStrictEqual(provider, {
    kind: "gitlab",
    name: "GitLab Self-Hosted",
    baseUrl: "https://Self-Hosted.Example.Test",
  });
});

it("parses authenticated GitLab auth status hosts with ports and single-label names", () => {
  assert.deepStrictEqual(
    parseGitLabAuthStatusHosts(`localhost:8080
  ✓ Logged in to localhost:8080 as local-user
selfhosted
  ✓ Logged in to selfhosted as single-label-user
`),
    [
      { host: "localhost:8080", account: "local-user" },
      { host: "selfhosted", account: "single-label-user" },
    ],
  );
});

for (const kind of ["merge_requests", "issues"]) {
  it.effect(`resolves ${kind} subjects on the linked host without using the checkout`, () =>
    Effect.gen(function* () {
      const provider = yield* makeProvider({
        execute: (input) => {
          assert.deepStrictEqual(input.args, [
            "api",
            "--hostname",
            "gitlab.com",
            `projects/group%2Fsubgroup%2Fproject/${kind}/42`,
          ]);
          assert.strictEqual(input.maxOutputBytes, 32_000);
          assert.strictEqual(input.timeoutMs, 3_000);
          return Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: JSON.stringify({
              title: "Pairing expiry",
              description: "Preserve remote access",
            }),
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        },
      });
      const lookup = provider.resolveLink?.({
        cwd: "/unrelated",
        url: new URL(`https://gitlab.com/group/subgroup/project/-/${kind}/42`),
      });
      assert.ok(lookup);
      assert.deepStrictEqual(yield* lookup, {
        title: "Pairing expiry",
        body: "Preserve remote access",
      });
      assert.strictEqual(
        provider.resolveLink?.({
          cwd: "/unrelated",
          url: new URL("https://gitlab.com/owner/repo"),
        }),
        undefined,
      );
    }),
  );
}

for (const stage of ["read", "decode"] as const) {
  it.effect(`retains the ${stage} failure without exposing its raw contents`, () =>
    Effect.gen(function* () {
      const cause = new GitLabCli.GitLabCliCommandError({
        command: "glab",
        cwd: "/repo",
        operation: "execute",
        cause: new Error("private response text"),
      });
      const provider = yield* makeProvider({
        execute: () =>
          stage === "read"
            ? Effect.fail(cause)
            : Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "private response text",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
      });
      const lookup = provider.resolveLink?.({
        cwd: "/repo",
        url: new URL("https://gitlab.com/owner/repo/-/issues/42"),
      });
      assert.ok(lookup);
      const error = yield* Effect.flip(lookup);
      assert.strictEqual(error.operation, stage === "read" ? "resolveLink" : "resolveLink.decode");
      assert.strictEqual(error.detail, "The linked subject could not be read.");
      assert.notInclude(error.message, "private response text");
      if (stage === "read") assert.strictEqual(error.cause, cause);
      else assert.propertyVal(error.cause, "_tag", "SchemaError");
    }),
  );
}
