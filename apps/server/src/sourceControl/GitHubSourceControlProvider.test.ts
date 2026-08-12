import { afterEach, assert, describe, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";
import { parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

const processResult = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function makeProvider(github: Partial<GitHubCli.GitHubCli["Service"]>) {
  return GitHubSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(GitHubCli.GitHubCli)(github)),
  );
}

const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();

const cliLayer = GitHubCli.layer.pipe(
  Layer.provide(
    Layer.mock(VcsProcess.VcsProcess)({
      run: mockRun,
    }),
  ),
);

afterEach(() => {
  mockRun.mockReset();
});

it.effect("maps GitHub PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add GitHub provider",
          url: "https://github.com/pingdotgg/t3code/pull/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open",
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
      provider: "github",
      number: 42,
      title: "Add GitHub provider",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "fork/t3code",
      headRepositoryOwnerLogin: "fork",
    });
  }),
);

it.effect("adds safe request context while retaining GitHub CLI causes", () =>
  Effect.gen(function* () {
    const cause = new GitHubCli.GitHubPullRequestNotFoundError({
      command: "gh",
      cwd: "/repo",
      cause: new Error("raw upstream detail that should remain in the cause"),
    });
    const provider = yield* makeProvider({
      getPullRequest: () => Effect.fail(cause),
    });

    const error = yield* provider
      .getChangeRequest({
        cwd: "/repo",
        reference: "https://user:secret@github.com/pingdotgg/t3code/pull/42?token=secret#diff",
      })
      .pipe(Effect.flip);

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        command: error.command,
        cwd: error.cwd,
        reference: error.reference,
        detail: error.detail,
      },
      {
        provider: "github",
        operation: "getChangeRequest",
        command: "gh",
        cwd: "/repo",
        reference: "https://github.com/pingdotgg/t3code/pull/42",
        detail: "Pull request not found. Check the PR number or URL and try again.",
      },
    );
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes("raw upstream detail"), false);
  }),
);

it.effect("uses gh json listing for non-open change request state queries", () =>
  Effect.gen(function* () {
    let executeArgs: ReadonlyArray<string> = [];
    const provider = yield* makeProvider({
      execute: (input) => {
        executeArgs = input.args;
        return Effect.succeed(
          processResult(
            JSON.stringify([
              {
                number: 7,
                title: "Merged work",
                url: "https://github.com/pingdotgg/t3code/pull/7",
                baseRefName: "main",
                headRefName: "feature/merged",
                state: "merged",
                updatedAt: "2026-01-02T00:00:00.000Z",
              },
            ]),
          ),
        );
      },
    });

    const changeRequests = yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/merged",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(executeArgs, [
      "pr",
      "list",
      "--head",
      "feature/merged",
      "--state",
      "all",
      "--limit",
      "10",
      "--json",
      "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
    ]);
    assert.strictEqual(changeRequests[0]?.provider, "github");
    assert.strictEqual(changeRequests[0]?.state, "merged");
    assert.deepStrictEqual(
      changeRequests[0]?.updatedAt,
      Option.some(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
    );
  }),
);

it.effect("treats empty non-open change request listing output as no results", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      execute: () => Effect.succeed(processResult("")),
    });

    const changeRequests = yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/empty",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(changeRequests, []);
  }),
);

it.effect("creates GitHub PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput: Parameters<GitHubCli.GitHubCli["Service"]["createPullRequest"]>[0] | null =
      null;
    const provider = yield* makeProvider({
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

it("accepts active authenticated GitHub accounts when another account fails", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "active-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
            {
              state: "error",
              active: false,
              host: "github.com",
              login: "stale-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
              error: "The token in keyring is invalid.",
            },
          ],
        },
      }),
    ),
  );

  assert.deepStrictEqual(
    {
      status: auth.status,
      account: auth.account,
      host: auth.host,
    },
    {
      status: "authenticated",
      account: Option.some("active-user"),
      host: Option.some("github.com"),
    },
  );
});

it("parses GitHub auth JSON from stdout when stderr has warnings", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "active-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
          ],
        },
      }),
      { stderr: "warning: ignored diagnostic from gh\n" },
    ),
  );

  assert.deepStrictEqual(
    {
      status: auth.status,
      account: auth.account,
      host: auth.host,
    },
    {
      status: "authenticated",
      account: Option.some("active-user"),
      host: Option.some("github.com"),
    },
  );
});

it("parses GitHub auth status accounts by host and active state", () => {
  assert.deepStrictEqual(
    parseGitHubAuthStatus(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "active-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
            {
              state: "error",
              active: false,
              host: "github.com",
              login: "stale-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
          ],
          "github.example.test": [
            {
              state: "success",
              active: false,
              host: "github.example.test",
              login: "enterprise-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
          ],
        },
      }),
    ).accounts,
    [
      {
        host: "github.com",
        account: "active-user",
        authenticated: true,
        active: true,
        error: null,
      },
      {
        host: "github.com",
        account: "stale-user",
        authenticated: false,
        active: false,
        error: null,
      },
      {
        host: "github.example.test",
        account: "enterprise-user",
        authenticated: true,
        active: false,
        error: null,
      },
    ],
  );
});

it("reports unauthenticated when GitHub JSON has accounts but none are valid", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "error",
              active: true,
              host: "github.com",
              login: "stale-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
              error: "The token in keyring is invalid.",
            },
          ],
        },
      }),
    ),
  );

  assert.deepStrictEqual(
    {
      status: auth.status,
      host: auth.host,
      detail: auth.detail,
    },
    {
      status: "unauthenticated",
      host: Option.some("github.com"),
      detail: Option.some("The token in keyring is invalid."),
    },
  );
});

const authStatusJson = (
  hosts: Record<string, ReadonlyArray<{ login: string; state: string; active: boolean }>>,
) =>
  JSON.stringify({
    hosts: Object.fromEntries(
      Object.entries(hosts).map(([host, accounts]) => [
        host,
        accounts.map((account) => ({ ...account, host })),
      ]),
    ),
  });

const probe = (stdout: string) => ({
  stdout,
  stderr: "",
  exitCode: ChildProcessSpawner.ExitCode(0),
});

describe("expandGitHubInstances", () => {
  it("emits only a github row when no enterprise host is logged in", () => {
    const instances = GitHubSourceControlProvider.expandGitHubInstances(
      probe(
        authStatusJson({ "github.com": [{ login: "octocat", state: "success", active: true }] }),
      ),
    );

    expect(instances.map((instance) => instance.id)).toEqual(["github"]);
    expect(instances[0]!.kind).toBe("github");
    expect(instances[0]!.auth.status).toBe("authenticated");
  });

  it("emits one enterprise row per non-github.com host", () => {
    const instances = GitHubSourceControlProvider.expandGitHubInstances(
      probe(
        authStatusJson({
          "github.com": [{ login: "octocat", state: "success", active: true }],
          "git.corp.com": [{ login: "dev", state: "success", active: false }],
          "acme.ghe.com": [{ login: "dev2", state: "success", active: false }],
        }),
      ),
    );

    expect(instances.map((instance) => instance.id)).toEqual([
      "github",
      "github-enterprise:acme.ghe.com",
      "github-enterprise:git.corp.com",
    ]);
    expect(instances[1]!.kind).toBe("github-enterprise");
    expect(instances[1]!.label).toBe("acme.ghe.com");
    expect(instances[1]!.host).toBe("acme.ghe.com");
    expect(Option.getOrNull(instances[1]!.auth.account)).toBe("dev2");
  });

  it("collapses two authenticated accounts on the same enterprise host into one row", () => {
    const instances = GitHubSourceControlProvider.expandGitHubInstances(
      probe(
        authStatusJson({
          "github.com": [{ login: "octocat", state: "success", active: true }],
          "git.corp.com": [
            { login: "dev", state: "success", active: true },
            { login: "dev2", state: "success", active: false },
          ],
        }),
      ),
    );

    expect(instances.map((instance) => instance.id)).toEqual([
      "github",
      "github-enterprise:git.corp.com",
    ]);
    expect(instances).toHaveLength(2);
  });

  it("still emits a github row when github.com is not logged in", () => {
    const instances = GitHubSourceControlProvider.expandGitHubInstances(
      probe(authStatusJson({ "git.corp.com": [{ login: "dev", state: "success", active: true }] })),
    );

    expect(instances[0]!.id).toBe("github");
    expect(instances[0]!.auth.status).toBe("unauthenticated");
    expect(instances).toHaveLength(2);
  });

  it("emits only a github row with unknown auth when output is unparseable", () => {
    const instances = GitHubSourceControlProvider.expandGitHubInstances(probe("not json"));

    expect(instances).toHaveLength(1);
    expect(instances[0]!.id).toBe("github");
    expect(instances[0]!.kind).toBe("github");
    expect(instances[0]!.host).toBe("github.com");
    expect(instances[0]!.auth.status).toBe("unknown");
  });
});

describe("refineUnknownGitHubRemote", () => {
  const context = {
    provider: { kind: "unknown" as const, name: "git.corp.com", baseUrl: "https://git.corp.com" },
    remoteName: "origin",
    remoteUrl: "https://git.corp.com/owner/repo.git",
  };

  it("claims a remote whose host is authenticated in gh", () => {
    const refined = GitHubSourceControlProvider.refineUnknownGitHubRemote({
      cwd: "/repo",
      context,
      auth: probe(
        authStatusJson({ "git.corp.com": [{ login: "dev", state: "success", active: true }] }),
      ),
    });

    expect(refined).toEqual({
      kind: "github-enterprise",
      name: "git.corp.com",
      baseUrl: "https://git.corp.com",
    });
  });

  it("claims a remote whose host carries a non-default port", () => {
    const refined = GitHubSourceControlProvider.refineUnknownGitHubRemote({
      cwd: "/repo",
      context: {
        provider: {
          kind: "unknown" as const,
          name: "git.corp.com:8443",
          baseUrl: "https://git.corp.com:8443",
        },
        remoteName: "origin",
        remoteUrl: "https://git.corp.com:8443/owner/repo.git",
      },
      auth: probe(
        authStatusJson({ "git.corp.com": [{ login: "dev", state: "success", active: true }] }),
      ),
    });

    expect(refined).toEqual({
      kind: "github-enterprise",
      name: "git.corp.com",
      baseUrl: "https://git.corp.com:8443",
    });
  });

  it("does not claim a host that failed authentication", () => {
    expect(
      GitHubSourceControlProvider.refineUnknownGitHubRemote({
        cwd: "/repo",
        context,
        auth: probe(
          authStatusJson({ "git.corp.com": [{ login: "dev", state: "error", active: true }] }),
        ),
      }),
    ).toBeNull();
  });

  it("does not claim a host absent from gh auth status", () => {
    expect(
      GitHubSourceControlProvider.refineUnknownGitHubRemote({
        cwd: "/repo",
        context,
        auth: probe(
          authStatusJson({ "github.com": [{ login: "octocat", state: "success", active: true }] }),
        ),
      }),
    ).toBeNull();
  });
});

function makeProviderOfKind(
  kind: "github" | "github-enterprise",
  github: Partial<GitHubCli.GitHubCli["Service"]>,
) {
  return GitHubSourceControlProvider.makeProvider(kind).pipe(
    Effect.provide(Layer.mock(GitHubCli.GitHubCli)(github)),
  );
}

describe("getRepositoryCloneUrls bare name resolution", () => {
  it.effect("resolves a bare enterprise name via search, preferring the exact-name match", () =>
    Effect.gen(function* () {
      const searchRepositories = vi.fn(() =>
        Effect.succeed([
          { fullName: "Sollit/core-documentation" },
          { fullName: "Sollit/core" },
          { fullName: "Sollit/frontend-core" },
          { fullName: "Sollit/portal-core-service" },
        ]),
      );
      const getRepositoryCloneUrls = vi.fn(() =>
        Effect.succeed({
          nameWithOwner: "Sollit/core",
          url: "https://sollit.ghe.com/Sollit/core",
          sshUrl: "git@sollit.ghe.com:Sollit/core.git",
        }),
      );

      const provider = yield* makeProviderOfKind("github-enterprise", {
        searchRepositories,
        getRepositoryCloneUrls,
      });

      const result = yield* provider.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "core",
        host: "sollit.ghe.com",
      });

      expect(searchRepositories).toHaveBeenCalledWith({
        cwd: "/repo",
        query: "core",
        host: "sollit.ghe.com",
      });
      expect(getRepositoryCloneUrls).toHaveBeenCalledWith({
        cwd: "/repo",
        repository: "Sollit/core",
        host: "sollit.ghe.com",
      });
      assert.deepStrictEqual(result, {
        nameWithOwner: "Sollit/core",
        url: "https://sollit.ghe.com/Sollit/core",
        sshUrl: "git@sollit.ghe.com:Sollit/core.git",
      });
    }),
  );

  it.effect("resolves a sole near match when no bare name matches exactly", () =>
    Effect.gen(function* () {
      const searchRepositories = vi.fn(() =>
        Effect.succeed([{ fullName: "Sollit/widget-service" }]),
      );
      const getRepositoryCloneUrls = vi.fn(() =>
        Effect.succeed({
          nameWithOwner: "Sollit/widget-service",
          url: "https://sollit.ghe.com/Sollit/widget-service",
          sshUrl: "git@sollit.ghe.com:Sollit/widget-service.git",
        }),
      );

      const provider = yield* makeProviderOfKind("github-enterprise", {
        searchRepositories,
        getRepositoryCloneUrls,
      });

      yield* provider.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "widget",
        host: "sollit.ghe.com",
      });

      expect(getRepositoryCloneUrls).toHaveBeenCalledWith({
        cwd: "/repo",
        repository: "Sollit/widget-service",
        host: "sollit.ghe.com",
      });
    }),
  );

  it.effect("fails rather than rank near matches when none of them is exact", () =>
    Effect.gen(function* () {
      const searchRepositories = vi.fn(() =>
        Effect.succeed([{ fullName: "Sollit/widget-service" }, { fullName: "Sollit/mywidget" }]),
      );
      const getRepositoryCloneUrls = vi.fn(() =>
        Effect.succeed({
          nameWithOwner: "Sollit/widget-service",
          url: "https://sollit.ghe.com/Sollit/widget-service",
          sshUrl: "git@sollit.ghe.com:Sollit/widget-service.git",
        }),
      );

      const provider = yield* makeProviderOfKind("github-enterprise", {
        searchRepositories,
        getRepositoryCloneUrls,
      });

      const error = yield* provider
        .getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "widget",
          host: "sollit.ghe.com",
        })
        .pipe(Effect.flip);

      expect(getRepositoryCloneUrls).not.toHaveBeenCalled();
      expect(error.detail).toContain("Sollit/widget-service");
      expect(error.detail).toContain("Sollit/mywidget");
    }),
  );

  it.effect("fails with a detail naming the query and host when search returns zero results", () =>
    Effect.gen(function* () {
      const searchRepositories = vi.fn(() => Effect.succeed([]));
      const getRepositoryCloneUrls = vi.fn(() =>
        Effect.succeed({
          nameWithOwner: "Sollit/typo-name",
          url: "https://sollit.ghe.com/Sollit/typo-name",
          sshUrl: "git@sollit.ghe.com:Sollit/typo-name.git",
        }),
      );

      const provider = yield* makeProviderOfKind("github-enterprise", {
        searchRepositories,
        getRepositoryCloneUrls,
      });

      const error = yield* provider
        .getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "typo-name",
          host: "sollit.ghe.com",
        })
        .pipe(Effect.flip);

      expect(getRepositoryCloneUrls).not.toHaveBeenCalled();
      expect(error.detail).toContain("typo-name");
      expect(error.detail).toContain("sollit.ghe.com");
    }),
  );

  it.effect("fails naming every owner when several exact matches share the bare name", () =>
    Effect.gen(function* () {
      const searchRepositories = vi.fn(() =>
        Effect.succeed([
          { fullName: "team-a/core" },
          { fullName: "team-b/core" },
          { fullName: "team-c/core-docs" },
        ]),
      );
      const getRepositoryCloneUrls = vi.fn(() =>
        Effect.succeed({
          nameWithOwner: "team-a/core",
          url: "https://sollit.ghe.com/team-a/core",
          sshUrl: "git@sollit.ghe.com:team-a/core.git",
        }),
      );

      const provider = yield* makeProviderOfKind("github-enterprise", {
        searchRepositories,
        getRepositoryCloneUrls,
      });

      const error = yield* provider
        .getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "core",
          host: "sollit.ghe.com",
        })
        .pipe(Effect.flip);

      expect(getRepositoryCloneUrls).not.toHaveBeenCalled();
      expect(error.detail).toContain("team-a/core");
      expect(error.detail).toContain("team-b/core");
      expect(error.detail).not.toContain("team-c/core-docs");
    }),
  );

  it.effect("refuses a bare enterprise name without a host rather than searching github.com", () =>
    Effect.gen(function* () {
      const searchRepositories = vi.fn(() => Effect.succeed([{ fullName: "Sollit/core" }]));
      const getRepositoryCloneUrls = vi.fn(() =>
        Effect.succeed({
          nameWithOwner: "Sollit/core",
          url: "https://sollit.ghe.com/Sollit/core",
          sshUrl: "git@sollit.ghe.com:Sollit/core.git",
        }),
      );

      const provider = yield* makeProviderOfKind("github-enterprise", {
        searchRepositories,
        getRepositoryCloneUrls,
      });

      const error = yield* provider
        .getRepositoryCloneUrls({ cwd: "/repo", repository: "core" })
        .pipe(Effect.flip);

      expect(searchRepositories).not.toHaveBeenCalled();
      expect(getRepositoryCloneUrls).not.toHaveBeenCalled();
      expect(error.detail).toContain("host");
    }),
  );

  // GitManager resolves the enterprise provider from the git remote and looks
  // up owner/repo with no host, letting `gh` read the host from the clone.
  it.effect("looks up an owner/repo reference in-repo without a host", () =>
    Effect.gen(function* () {
      const searchRepositories = vi.fn(() => Effect.succeed([]));
      const getRepositoryCloneUrls = vi.fn(() =>
        Effect.succeed({
          nameWithOwner: "Sollit/core",
          url: "https://sollit.ghe.com/Sollit/core",
          sshUrl: "git@sollit.ghe.com:Sollit/core.git",
        }),
      );

      const provider = yield* makeProviderOfKind("github-enterprise", {
        searchRepositories,
        getRepositoryCloneUrls,
      });

      const result = yield* provider.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "Sollit/core",
      });

      expect(searchRepositories).not.toHaveBeenCalled();
      expect(getRepositoryCloneUrls).toHaveBeenCalledWith({
        cwd: "/repo",
        repository: "Sollit/core",
      });
      assert.strictEqual(result.nameWithOwner, "Sollit/core");
    }),
  );

  it.effect("refuses to create an enterprise repository without a host", () =>
    Effect.gen(function* () {
      const createRepository = vi.fn(() =>
        Effect.succeed({
          nameWithOwner: "Sollit/core",
          url: "https://github.com/Sollit/core",
          sshUrl: "git@github.com:Sollit/core.git",
        }),
      );

      const provider = yield* makeProviderOfKind("github-enterprise", { createRepository });

      const error = yield* provider
        .createRepository({ cwd: "/repo", repository: "Sollit/core", visibility: "private" })
        .pipe(Effect.flip);

      expect(createRepository).not.toHaveBeenCalled();
      expect(error.detail).toContain("host");
    }),
  );

  it.effect("never calls search for an owner/repo reference on enterprise", () =>
    Effect.gen(function* () {
      const searchRepositories = vi.fn(() => Effect.succeed([]));
      const getRepositoryCloneUrls = vi.fn(() =>
        Effect.succeed({
          nameWithOwner: "Sollit/core",
          url: "https://sollit.ghe.com/Sollit/core",
          sshUrl: "git@sollit.ghe.com:Sollit/core.git",
        }),
      );

      const provider = yield* makeProviderOfKind("github-enterprise", {
        searchRepositories,
        getRepositoryCloneUrls,
      });

      yield* provider.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "Sollit/core",
        host: "sollit.ghe.com",
      });

      expect(searchRepositories).not.toHaveBeenCalled();
      expect(getRepositoryCloneUrls).toHaveBeenCalledWith({
        cwd: "/repo",
        repository: "Sollit/core",
        host: "sollit.ghe.com",
      });
    }),
  );

  it.effect("never calls search for a bare name on plain github.com", () =>
    Effect.gen(function* () {
      const searchRepositories = vi.fn(() => Effect.succeed([]));
      const getRepositoryCloneUrls = vi.fn(() =>
        Effect.succeed({
          nameWithOwner: "octocat/core",
          url: "https://github.com/octocat/core",
          sshUrl: "git@github.com:octocat/core.git",
        }),
      );

      const provider = yield* makeProviderOfKind("github", {
        searchRepositories,
        getRepositoryCloneUrls,
      });

      const result = yield* provider.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "core",
      });

      expect(searchRepositories).not.toHaveBeenCalled();
      expect(getRepositoryCloneUrls).toHaveBeenCalledWith({
        cwd: "/repo",
        repository: "core",
      });
      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/core",
        url: "https://github.com/octocat/core",
        sshUrl: "git@github.com:octocat/core.git",
      });
    }),
  );
});

describe("makeProvider", () => {
  it.effect("tags change requests and errors with the enterprise kind", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processResult(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 7,
                title: "Add widget",
                url: "https://git.corp.com/owner/repo/pull/7",
                baseRefName: "main",
                headRefName: "feature",
                state: "OPEN",
              },
            ]),
          ),
        ),
      );

      const provider = yield* GitHubSourceControlProvider.makeProvider("github-enterprise");
      const requests = yield* provider.listChangeRequests({
        cwd: "/repo",
        headSelector: "feature",
        state: "open",
      });

      expect(provider.kind).toBe("github-enterprise");
      expect(requests[0]!.provider).toBe("github-enterprise");
    }).pipe(Effect.provide(cliLayer)),
  );
});
