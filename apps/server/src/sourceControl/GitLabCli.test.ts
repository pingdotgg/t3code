import { assert, it, afterEach, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { VcsProcessExitError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitLabCli from "./GitLabCli.ts";
import type {
  SourceControlProvider,
  SourceControlProviderContext,
} from "./SourceControlProvider.ts";

const mockedRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();
const layer = it.layer(
  GitLabCli.layer.pipe(
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: mockedRun,
      }),
    ),
  ),
);

function processOutput(stdout: string): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function fakeGlab(input: {
  readonly profiles: Readonly<
    Record<
      string,
      { readonly apiHost?: string; readonly authenticated?: boolean; readonly user?: string }
    >
  >;
  readonly defaultHost?: string;
  readonly repositoryHost?: string;
  readonly repositoryVisibility?: "public" | "private";
}) {
  const requests: Array<{ readonly profile: string; readonly apiHost: string }> = [];
  const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
  mockedRun.mockImplementation((call) => {
    if (call.args[0] === "config") {
      expect(["api_host", "user"]).toContain(call.args[2]);
      expect(call.args.slice(3, 4)).toEqual(["--host"]);
      const profile = call.args[4] ?? "";
      const stored = input.profiles[profile];
      const osUser = call.env?.USER ?? "local-os-user";
      return Effect.succeed(
        processOutput(
          call.args[2] === "api_host"
            ? (stored?.apiHost ?? "")
            : osUser || (stored ? (stored.user ?? "alex") : ""),
        ),
      );
    }
    expect(call.command).toBe("glab");
    const flag = call.args.indexOf("--hostname");
    const explicitHost = flag === -1 ? undefined : call.args[flag + 1];
    if (explicitHost?.includes(":")) {
      return Effect.fail(
        new VcsProcessExitError({
          operation: call.operation,
          command: call.command,
          cwd: call.cwd,
          exitCode: 1,
          detail: "error parsing --hostname: invalid hostname.",
        }),
      );
    }
    expect(call.args).toEqual([
      "api",
      "projects/alex%2Frepo",
      ...(explicitHost ? ["--hostname", explicitHost] : []),
    ]);
    const defaultHost = call.env?.GITLAB_HOST ?? input.defaultHost ?? "gitlab.com";
    const profile =
      explicitHost ??
      (input.repositoryHost &&
      input.repositoryHost in input.profiles &&
      (defaultHost === "gitlab.com" || input.repositoryHost === defaultHost)
        ? input.repositoryHost
        : defaultHost);
    const apiHost = input.profiles[profile]?.apiHost ?? profile;
    requests.push({ profile, apiHost });
    if (
      (!(profile in input.profiles) || input.profiles[profile]?.authenticated === false) &&
      input.repositoryVisibility !== "public"
    ) {
      return Effect.fail(
        new VcsProcessExitError({
          operation: call.operation,
          command: call.command,
          cwd: call.cwd,
          exitCode: 1,
          detail: "Not found on GitLab.",
          failureKind: "not-found",
        }),
      );
    }
    return Effect.succeed(
      processOutput(
        encodeJson({
          path_with_namespace: "alex/repo",
          web_url: `https://${apiHost}/alex/repo`,
          http_url_to_repo: `https://${apiHost}/alex/repo.git`,
          ssh_url_to_repo: `git@${profile}:alex/repo.git`,
        }),
      ),
    );
  });
  return requests;
}

function repositoryContext(host: string, sshPort?: number): SourceControlProviderContext {
  return {
    provider: {
      kind: "gitlab",
      name: "GitLab",
      baseUrl: `https://${host}${sshPort === undefined ? "" : `:${sshPort}`}`,
    },
    remoteName: "origin",
    remoteUrl:
      sshPort === undefined
        ? `git@${host}:team/repo.git`
        : `ssh://git@${host}:${sshPort}/team/repo.git`,
  };
}

afterEach(() => {
  mockedRun.mockReset();
});

layer("GitLabCli.layer", (it) => {
  it.effect("parses merge request view output", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              iid: 42,
              title: "Add MR thread creation",
              web_url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
              target_branch: "main",
              source_branch: "feature/mr-threads",
              state: "closed",
              closed_at: "2026-08-23T10:00:00Z",
              source_project_id: 101,
              target_project_id: 100,
              source_project: {
                path_with_namespace: "octocat/t3code",
              },
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "42",
        });
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add MR thread creation",
        url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
        baseRefName: "main",
        headRefName: "feature/mr-threads",
        state: "closed",
        closedAt: "2026-08-23T10:00:00Z",
        mergedAt: null,
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/t3code",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "view", "42", "--output", "json"],
        }),
      );
    }),
  );

  it.effect("skips invalid entries when parsing MR lists", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                iid: 0,
                title: "invalid",
                web_url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/0",
                target_branch: "main",
                source_branch: "feature/invalid",
              },
              {
                iid: 43,
                title: "  Valid MR  ",
                web_url: " https://gitlab.com/pingdotgg/t3code/-/merge_requests/43 ",
                target_branch: " main ",
                source_branch: " feature/mr-list ",
                state: "merged",
                merged_at: "2026-08-23T11:00:00Z",
              },
            ]),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.listMergeRequests({
          cwd: "/repo",
          headSelector: "feature/mr-list",
          state: "all",
        });
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid MR",
          url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/43",
          baseRefName: "main",
          headRefName: "feature/mr-list",
          state: "merged",
          closedAt: null,
          mergedAt: "2026-08-23T11:00:00Z",
        },
      ]);
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "mr",
            "list",
            "--source-branch",
            "feature/mr-list",
            "--all",
            "--per-page",
            "20",
            "--output",
            "json",
          ],
        }),
      );
    }),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              path_with_namespace: "octocat/t3code",
              web_url: "https://gitlab.com/octocat/t3code",
              http_url_to_repo: "https://gitlab.com/octocat/t3code.git",
              ssh_url_to_repo: "git@gitlab.com:octocat/t3code.git",
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "octocat/t3code",
        });
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/t3code",
        url: "https://gitlab.com/octocat/t3code",
        sshUrl: "git@gitlab.com:octocat/t3code.git",
      });
    }),
  );

  it.effect("keeps an unspecified fork lookup on glab's existing host path", () =>
    Effect.gen(function* () {
      fakeGlab({ profiles: { "gitlab.com": {} } });
      const glab = yield* GitLabCli.GitLabCli;
      const result = yield* glab.getRepositoryCloneUrls({ cwd: "/repo", repository: "alex/repo" });
      expect(result.url).toBe("https://gitlab.com/alex/repo");
      expect(mockedRun.mock.calls[0]?.[0].env).toBeUndefined();
    }),
  );

  it.effect.each([
    { profile: "gitlab-b.example", splitHost: false },
    { profile: "ssh.gitlab-b.example", splitHost: true },
  ])("qualifies a ported fork with the $profile hostname profile", ({ profile, splitHost }) =>
    Effect.gen(function* () {
      const host = "gitlab-b.example:8443";
      const requests = fakeGlab({
        profiles: { "gitlab.com": {}, [profile]: { apiHost: host } },
        repositoryHost: "gitlab.com",
      });
      const glab = yield* GitLabCli.GitLabCli;
      const result = yield* glab.getRepositoryCloneUrls({
        cwd: "/repo",
        host,
        repository: "alex/repo",
        ...(splitHost ? { context: repositoryContext(profile, 2222) } : {}),
      });
      expect(result.url).toBe(`https://${host}/alex/repo`);
      expect(result.sshUrl).toBe(`git@${profile}:alex/repo.git`);
      expect(requests).toEqual([{ profile, apiHost: host }]);
      expect(mockedRun.mock.calls.at(-1)?.[0].env).toEqual({ GITLAB_HOST: profile });
    }),
  );

  it.effect.each([
    { host: "gitlab-b.example", apiHost: "gitlab-wrong.example:9443" },
    { host: "gitlab-b.example:8443", apiHost: "gitlab-b.example:9443" },
  ])("refuses a fork result from the wrong host or port for $host", ({ host, apiHost }) =>
    Effect.gen(function* () {
      fakeGlab({ profiles: { "gitlab-b.example": { apiHost } } });
      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .getRepositoryCloneUrls({
          cwd: "/repo",
          host,
          repository: "alex/repo",
        })
        .pipe(Effect.flip);
      expect(error.detail).toBe(
        "GitLab returned a repository on a different host. Check the glab host profile and retry.",
      );
    }),
  );

  it.effect.each(["gitlab.com", "gitlab-b.example"])(
    "selects the %s fork profile when no known Git remote matches",
    (host) =>
      Effect.gen(function* () {
        const requests = fakeGlab({
          profiles: { "gitlab.com": {}, "gitlab-b.example": {}, "gitlab-default.example": {} },
          defaultHost: "gitlab-default.example",
        });
        const lookup: Parameters<SourceControlProvider["Service"]["getRepositoryCloneUrls"]>[0] = {
          cwd: "/repo",
          host,
          repository: "alex/repo",
        };
        const glab = yield* GitLabCli.GitLabCli;
        const result = yield* glab.getRepositoryCloneUrls(lookup);

        expect(result.url).toBe(`https://${host}/alex/repo`);
        expect(requests).toEqual([{ profile: host, apiHost: host }]);
        expect(mockedRun.mock.calls.map(([call]) => call.env)).toEqual([{ GITLAB_HOST: host }]);
      }),
  );

  it.effect("selects gitlab.com despite a known self-managed origin", () =>
    Effect.gen(function* () {
      const profile = "gitlab.corp.example";
      const requests = fakeGlab({
        profiles: { [profile]: {}, "gitlab.com": {} },
        repositoryHost: profile,
      });
      const glab = yield* GitLabCli.GitLabCli;
      const result = yield* glab.getRepositoryCloneUrls({
        cwd: "/repo",
        host: "gitlab.com",
        context: repositoryContext(profile),
        repository: "alex/repo",
      });

      expect(result.url).toBe("https://gitlab.com/alex/repo");
      expect(requests).toEqual([{ profile: "gitlab.com", apiHost: "gitlab.com" }]);
      expect(mockedRun.mock.calls.map(([call]) => call.env)).toEqual([
        undefined,
        { GITLAB_HOST: "gitlab.com" },
      ]);
    }),
  );

  it.effect.each([
    { profile: "ssh.gitlab.corp.example", webLoginPresent: false, sshPort: undefined },
    { profile: "ssh.gitlab.corp.example", webLoginPresent: true, sshPort: undefined },
    { profile: "ssh.gitlab.corp.example", webLoginPresent: false, sshPort: 2222 },
    { profile: "ssh.gitlab.corp.example", webLoginPresent: true, sshPort: 2222 },
    { profile: "gitlab.corp.example", webLoginPresent: false, sshPort: 2222 },
  ])(
    "preserves the Git hostname's authenticated API-host profile (Git host: $profile, web login: $webLoginPresent, SSH port: $sshPort)",
    ({ profile, webLoginPresent, sshPort }) =>
      Effect.gen(function* () {
        const host = "gitlab.corp.example";
        const requests = fakeGlab({
          profiles: {
            "gitlab.com": {},
            [profile]: { apiHost: host },
            ...(webLoginPresent ? { [host]: {} } : {}),
          },
          repositoryHost: profile,
        });
        const lookup: Parameters<SourceControlProvider["Service"]["getRepositoryCloneUrls"]>[0] = {
          cwd: "/repo",
          host,
          context: repositoryContext(profile, sshPort),
          repository: "alex/repo",
        };
        const glab = yield* GitLabCli.GitLabCli;
        const result = yield* glab.getRepositoryCloneUrls(lookup);

        expect(result.url).toBe(`https://${host}/alex/repo`);
        expect(result.sshUrl).toBe(`git@${profile}:alex/repo.git`);
        expect(requests).toEqual([{ profile, apiHost: host }]);
        expect(mockedRun.mock.calls.map(([call]) => ({ args: call.args, env: call.env }))).toEqual([
          ...(profile === host
            ? []
            : [{ args: ["config", "get", "api_host", "--host", profile], env: undefined }]),
          { args: ["api", "projects/alex%2Frepo"], env: { GITLAB_HOST: profile } },
        ]);
      }),
  );

  it.effect("does not reuse another repository host's credentials for an unrelated API host", () =>
    Effect.gen(function* () {
      const profile = "ssh.gitlab.corp.example";
      const host = "gitlab-b.example";
      const requests = fakeGlab({
        profiles: {
          [profile]: { apiHost: "gitlab.corp.example" },
          [host]: {},
        },
        repositoryHost: profile,
      });
      const lookup: Parameters<SourceControlProvider["Service"]["getRepositoryCloneUrls"]>[0] = {
        cwd: "/repo",
        host,
        context: repositoryContext(profile),
        repository: "alex/repo",
      };
      const glab = yield* GitLabCli.GitLabCli;
      const result = yield* glab.getRepositoryCloneUrls(lookup);

      expect(result.url).toBe(`https://${host}/alex/repo`);
      expect(requests).toEqual([{ profile: host, apiHost: host }]);
    }),
  );

  it.effect.each([false, true])(
    "reports an anonymous private-fork 404 without falling back (host configured: %s)",
    (hostConfigured) =>
      Effect.gen(function* () {
        const host = "gitlab-missing.example";
        const requests = fakeGlab({
          profiles: {
            "gitlab.com": {},
            ...(hostConfigured ? { [host]: { authenticated: false } } : {}),
          },
        });
        const lookup: Parameters<SourceControlProvider["Service"]["getRepositoryCloneUrls"]>[0] = {
          cwd: "/repo",
          host,
          repository: "alex/repo",
        };
        const glab = yield* GitLabCli.GitLabCli;
        const error = yield* glab.getRepositoryCloneUrls(lookup).pipe(Effect.flip);

        expect(error.detail).toContain("Repository not found or inaccessible on GitLab.");
        if (hostConfigured) {
          expect(error.detail).not.toContain("glab auth login");
        } else {
          expect(error.detail).toContain("glab auth login --hostname gitlab-missing.example");
        }
        expect(error.cause).toMatchObject({
          _tag: "VcsProcessExitError",
          exitCode: 1,
          failureKind: "not-found",
          detail: "Not found on GitLab.",
        });
        expect(requests).toEqual([{ profile: host, apiHost: host }]);
        expect(mockedRun.mock.calls).toHaveLength(hostConfigured ? 2 : 3);
        expect(mockedRun.mock.calls[0]?.[0].env).toEqual({ GITLAB_HOST: host });
        expect(mockedRun.mock.calls[1]?.[0].args).toEqual([
          "config",
          "get",
          "user",
          "--host",
          host,
        ]);
        expect(mockedRun.mock.calls[1]?.[0].env).toEqual({ USER: "" });
        if (!hostConfigured) {
          expect(mockedRun.mock.calls[2]?.[0].args).toEqual([
            "config",
            "get",
            "api_host",
            "--host",
            host,
          ]);
        }
      }),
  );

  it.effect("allows an anonymous public-fork lookup on a host with no profile", () =>
    Effect.gen(function* () {
      const host = "gitlab-public.example";
      const requests = fakeGlab({
        profiles: { "gitlab.com": {} },
        repositoryVisibility: "public",
      });
      const glab = yield* GitLabCli.GitLabCli;
      const result = yield* glab.getRepositoryCloneUrls({
        cwd: "/repo",
        host,
        repository: "alex/repo",
      });

      expect(result.url).toBe(`https://${host}/alex/repo`);
      expect(requests).toEqual([{ profile: host, apiHost: host }]);
      expect(mockedRun.mock.calls).toHaveLength(1);
      expect(mockedRun.mock.calls[0]?.[0].env).toEqual({ GITLAB_HOST: host });
    }),
  );

  it.effect("names the split SSH profile in a private-fork login hint", () =>
    Effect.gen(function* () {
      const profile = "ssh.gitlab.corp.example";
      const host = "gitlab.corp.example:8443";
      const requests = fakeGlab({
        profiles: { [profile]: { apiHost: host, authenticated: false, user: "" } },
        repositoryHost: profile,
      });
      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .getRepositoryCloneUrls({
          cwd: "/repo",
          host,
          repository: "alex/repo",
          context: repositoryContext(profile, 2222),
        })
        .pipe(Effect.flip);
      expect(error.detail).toContain(`glab auth login --hostname ${profile}`);
      expect(error.detail).toContain(`--api-host ${host}`);
      expect(requests).toEqual([{ profile, apiHost: host }]);
      expect(mockedRun.mock.calls.at(-1)?.[0].args).toEqual([
        "config",
        "get",
        "user",
        "--host",
        profile,
      ]);
    }),
  );

  it.effect("creates merge requests through the GitLab API without placing the body in argv", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "owner:feature/provider",
        title: "Provider MR",
        bodyFile: "/tmp/t3-mr-body.md",
      });

      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "api",
            "--method",
            "POST",
            "projects/:fullpath/merge_requests",
            "--raw-field",
            "source_branch=feature/provider",
            "--raw-field",
            "target_branch=main",
            "--raw-field",
            "title=Provider MR",
            "--field",
            "description=@/tmp/t3-mr-body.md",
          ],
        }),
      );
    }),
  );

  it.effect("creates repositories under an explicit namespace", () =>
    Effect.gen(function* () {
      mockedRun

        .mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({ id: 1234 }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({
                path_with_namespace: "octocat/t3code",
                web_url: "https://gitlab.com/octocat/t3code",
                http_url_to_repo: "https://gitlab.com/octocat/t3code.git",
                ssh_url_to_repo: "git@gitlab.com:octocat/t3code.git",
              }),
            ),
          ),
        );

      const glab = yield* GitLabCli.GitLabCli;
      const result = yield* glab.createRepository({
        cwd: "/repo",
        repository: "octocat/t3code",
        visibility: "public",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/t3code",
        url: "https://gitlab.com/octocat/t3code",
        sshUrl: "git@gitlab.com:octocat/t3code.git",
      });
      expect(mockedRun).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["api", "namespaces/octocat"],
        }),
      );
      expect(mockedRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "api",
            "--method",
            "POST",
            "projects",
            "--raw-field",
            "path=t3code",
            "--raw-field",
            "name=t3code",
            "--raw-field",
            "visibility=public",
            "--raw-field",
            "namespace_id=1234",
          ],
        }),
      );
    }),
  );

  it.effect("does not pass unsupported force flags when checking out merge requests", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.checkoutMergeRequest({
        cwd: "/repo",
        reference: "42",
        force: true,
      });

      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "checkout", "42"],
        }),
      );
    }),
  );

  it.effect("surfaces a friendly error when the merge request is not found", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "GET 404 merge request not found",
        failureKind: "not-found",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("Merge request !4888 was not found"), true);
      assert.strictEqual(error._tag, "GitLabMergeRequestNotFoundError");
      assert.strictEqual(error.command, "glab");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes(cause.detail), false);
    }),
  );

  it.effect("keeps repository not-found failures operation-neutral", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "GET 404 project not found",
        failureKind: "not-found",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "missing/project",
        });
      }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabRepositoryLookupError");
      assert.strictEqual(error.detail, "Repository not found or inaccessible on GitLab.");
      assert.strictEqual(error.cause, cause);
    }),
  );

  it.effect("preserves rate-limit failures as a distinct error", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "API rate limit exceeded.",
        failureKind: "rate-limited",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .execute({ cwd: "/repo", args: ["api", "projects"] })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabCliRateLimitError");
      assert.strictEqual(error.cause, cause);
    }),
  );
});
