import { afterEach, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import { VcsProcessSpawnError, VcsProcessTimeoutError } from "@t3tools/contracts";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitCafeCli from "./GitCafeCli.ts";
import { discovery } from "./GitCafeSourceControlProvider.ts";

const run = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();
const fetchRemoteBranch = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteBranch"]>();
const fetchRemoteTrackingBranch =
  vi.fn<GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"]>();
const ensureRemote = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["ensureRemote"]>();
const switchRef = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["switchRef"]>();
const listLocalBranchNames = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["listLocalBranchNames"]>();
const setBranchUpstream = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["setBranchUpstream"]>();
const layer = it.layer(
  GitCafeCli.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(VcsProcess.VcsProcess)({ run }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          fetchRemoteBranch,
          fetchRemoteTrackingBranch,
          ensureRemote,
          switchRef,
          listLocalBranchNames,
          setBranchUpstream,
        }),
      ),
    ),
  ),
);
const context = {
  provider: { kind: "gitcafe", name: "GitCafe", baseUrl: "https://git.cafe" },
  remoteName: "origin",
  remoteUrl: "ssh@git.cafe:team/project.git",
} as const;
const pull = {
  number: 7,
  title: "A change",
  state: "open",
  draft: false,
  sourceBranch: "feature",
  targetBranch: "main",
  isCrossFork: false,
  sourceRepo: null,
  closedAt: null,
  mergedAt: null,
  updatedAt: "2026-09-12T10:00:00Z",
};
function output(data: unknown, exitCode = 0, stderr = ""): VcsProcess.VcsProcessOutput {
  return {
    stdout: JSON.stringify(data),
    stderr,
    exitCode: ChildProcessSpawner.ExitCode(exitCode),
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}
function failure(code: string, status: number | null) {
  return JSON.stringify({ schemaVersion: 1, error: { code, status, message: `Failure ${code}` } });
}
afterEach(() => vi.resetAllMocks());

layer("GitCafeCli", (it) => {
  for (const host of ["git.cafe", "staging.git.cafe"]) {
    const hostContext = {
      ...context,
      provider: { ...context.provider, baseUrl: `https://${host}` },
      remoteUrl: `ssh@${host}:team/project.git`,
    };
    it.effect(`keeps ${host} repository lookup, PR reads, and fork checkout on their origin`, () =>
      Effect.gen(function* () {
        const cafe = yield* GitCafeCli.GitCafeCli;
        run.mockReturnValueOnce(Effect.succeed(output({ name: "project", defaultBranch: "main" })));
        expect(
          yield* cafe.getRepositoryCloneUrls({
            cwd: "/repo",
            repository: `https://${host}/team/project.git`,
          }),
        ).toEqual({
          nameWithOwner: "team/project",
          url: `https://${host}/team/project`,
          sshUrl: `ssh@${host}:team/project.git`,
        });
        run.mockReturnValueOnce(Effect.succeed(output(pull)));
        expect(
          (yield* cafe.getChangeRequest({ cwd: "/repo", context: hostContext, reference: "7" }))
            .url,
        ).toBe(`https://${host}/team/project/pulls/7`);
        run.mockReturnValueOnce(
          Effect.succeed(
            output({
              ...pull,
              isCrossFork: true,
              sourceRepo: { owner: "alice", name: "fork" },
            }),
          ),
        );
        ensureRemote.mockReturnValueOnce(Effect.succeed("gitcafe"));
        listLocalBranchNames.mockReturnValueOnce(Effect.succeed([]));
        fetchRemoteBranch.mockReturnValueOnce(Effect.void);
        setBranchUpstream.mockReturnValueOnce(Effect.void);
        switchRef.mockReturnValueOnce(Effect.succeed({ refName: "pr-7/feature" }));
        yield* cafe.checkoutChangeRequest({
          cwd: "/repo",
          context: hostContext,
          reference: `https://${host}/team/project/pulls/7`,
        });
        expect(ensureRemote).toHaveBeenCalledWith({
          cwd: "/repo",
          preferredName: "gitcafe",
          url: `ssh@${host}:alice/fork.git`,
        });
        expect(run.mock.calls.every(([input]) => input.args?.[1] === `https://${host}/api`)).toBe(
          true,
        );
      }),
    );
    it.effect(`publishes repositories on ${host} with matching Git URLs`, () =>
      Effect.gen(function* () {
        run.mockReturnValueOnce(
          Effect.succeed(
            output({
              schemaVersion: 1,
              data: {
                resource: {
                  owner: "team",
                  name: "new",
                  repoId: "repo_new",
                  state: "complete",
                },
              },
            }),
          ),
        );
        const cafe = yield* GitCafeCli.GitCafeCli;
        const urls = yield* cafe.createRepository({
          cwd: "/repo",
          repository: `https://${host}/team/new`,
          visibility: "private",
        });
        expect(urls.url).toBe(`https://${host}/team/new`);
        expect(run.mock.calls[0]?.[0].args?.slice(0, 2)).toEqual(["--host", `https://${host}/api`]);
      }),
    );
  }
  it.effect("rejects unsupported API origins before invoking the CLI", () =>
    Effect.gen(function* () {
      const cafe = yield* GitCafeCli.GitCafeCli;
      const failure = yield* cafe
        .api({ cwd: "/repo", host: "sub.git.cafe", endpoint: "/auth/identity" })
        .pipe(Effect.flip);
      expect(failure.detail).toContain("Unsupported GitCafe host");
      expect(run).not.toHaveBeenCalled();
    }),
  );

  it.effect("preserves a process timeout with actionable detail", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessTimeoutError({
        operation: "GitCafeCli.execute",
        command: "cafe",
        cwd: "/repo",
        timeoutMs: 30_000,
      });
      run.mockReturnValueOnce(Effect.fail(cause));
      const cafe = yield* GitCafeCli.GitCafeCli;
      const failure = yield* cafe
        .api({ cwd: "/repo", endpoint: "/auth/identity" })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({
        code: "TIMEOUT",
        status: null,
        cause,
        detail: "GitCafe CLI timed out after 30 seconds. Check the connection and try refreshing.",
      });
      expect(run).toHaveBeenCalledTimes(1);
    }),
  );
  it.effect("distinguishes an unavailable CLI from a missing working directory", () =>
    Effect.gen(function* () {
      const cafe = yield* GitCafeCli.GitCafeCli;
      for (const [module, method, code] of [
        ["ChildProcess", "spawn", "CLI_UNAVAILABLE"],
        ["FileSystem", "access", "COMMAND_FAILED"],
      ] as const) {
        run.mockReturnValueOnce(
          Effect.fail(
            new VcsProcessSpawnError({
              operation: "GitCafeCli.execute",
              command: "cafe",
              cwd: "/repo",
              cause: PlatformError.systemError({
                _tag: "NotFound",
                module,
                method,
                pathOrDescriptor: "/repo",
              }),
            }),
          ),
        );
        expect(
          (yield* cafe.api({ cwd: "/repo", endpoint: "/auth/identity" }).pipe(Effect.flip)).code,
        ).toBe(code);
      }
    }),
  );
  it.effect("sends API headers and body without enabling envelope output", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(Effect.succeed(output({ ok: true })));
      const cafe = yield* GitCafeCli.GitCafeCli;
      yield* cafe.api({
        cwd: "/repo",
        endpoint: "/repos/team/project/stacks/1/restack",
        method: "POST",
        body: { expectedHead: "abc" },
        headers: { "Idempotency-Key": "operation-1" },
      });
      expect(run.mock.calls[0]?.[0]).toMatchObject({
        stdin: '{"expectedHead":"abc"}',
        args: [
          ...GitCafeCli.CLI_ARGS,
          "api",
          "/repos/team/project/stacks/1/restack",
          "--method",
          "POST",
          "--input",
          "-",
          "--header",
          "Idempotency-Key:operation-1",
        ],
      });
    }),
  );
  it.effect("targets repository reads explicitly and normalizes clone URLs", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(Effect.succeed(output({ name: "project", defaultBranch: "trunk" })));
      const cafe = yield* GitCafeCli.GitCafeCli;
      expect(
        yield* cafe.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "https://git.cafe/team/project.git",
        }),
      ).toEqual({
        nameWithOwner: "team/project",
        url: "https://git.cafe/team/project",
        sshUrl: "ssh@git.cafe:team/project.git",
      });
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          args: [...GitCafeCli.CLI_ARGS, "api", "/repos/team/project", "--method", "GET"],
          allowNonZeroExit: true,
          env: { CAFE_OUTPUT: "json" },
        }),
      );
    }),
  );
  it.effect("passes explicit owner and visibility when creating repositories", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(
        Effect.succeed(
          output({
            schemaVersion: 1,
            data: {
              resource: { owner: "org", name: "new", repoId: "repo_new", state: "complete" },
            },
          }),
        ),
      );
      const cafe = yield* GitCafeCli.GitCafeCli;
      yield* cafe.createRepository({ cwd: "/repo", repository: "org/new", visibility: "private" });
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          args: [
            ...GitCafeCli.CLI_ARGS,
            "repo",
            "create",
            "new",
            "--org",
            "org",
            "--visibility",
            "private",
            "--json",
          ],
        }),
      );
    }),
  );
  it.effect("rejects ownerless repository creation before running Cafe", () =>
    Effect.gen(function* () {
      const cafe = yield* GitCafeCli.GitCafeCli;
      const result = yield* cafe
        .createRepository({ cwd: "/repo", repository: "new", visibility: "public" })
        .pipe(Effect.flip);
      expect(result.detail).toContain("owner/name");
      expect(run).not.toHaveBeenCalled();
    }),
  );
  it.effect("normalizes draft and fork data using the repository in a PR URL", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(
        Effect.succeed(
          output({
            ...pull,
            draft: true,
            isCrossFork: true,
            sourceRepo: { owner: "alice", name: "fork" },
          }),
        ),
      );
      const cafe = yield* GitCafeCli.GitCafeCli;
      const result = yield* cafe.getChangeRequest({
        cwd: "/repo",
        context,
        reference: "https://git.cafe/other/repo/pulls/7",
      });
      expect(result).toMatchObject({
        state: "open",
        isDraft: true,
        url: "https://git.cafe/other/repo/pulls/7",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "alice/fork",
        headRepositoryOwnerLogin: "alice",
      });
      expect(Option.isSome(result.updatedAt)).toBe(true);
      expect(run.mock.calls[0]?.[0].args).toContain("/repos/other/repo/pulls/7");
    }),
  );
  it.effect("lists open/draft PRs and resolves fork identity only for matching branches", () =>
    Effect.gen(function* () {
      const fork = {
        ...pull,
        number: 8,
        draft: true,
        isCrossFork: true,
        sourceRepo: { owner: "alice", name: "fork" },
      };
      run.mockReturnValueOnce(
        Effect.succeed(
          output({
            nextAfter: null,
            items: [pull, fork, { ...pull, number: 9, sourceBranch: "unrelated" }],
          }),
        ),
      );
      run.mockReturnValueOnce(Effect.succeed(output(pull)));
      run.mockReturnValueOnce(Effect.succeed(output(fork)));
      const cafe = yield* GitCafeCli.GitCafeCli;
      const items = yield* cafe.listChangeRequests({
        cwd: "/repo",
        context,
        headSelector: "alice:feature",
        source: { refName: "feature", repository: "alice/fork" },
        state: "open",
      });
      expect(items.map((item) => item.number)).toEqual([8]);
      expect(items[0]?.isDraft).toBe(true);
      expect(run.mock.calls[0]?.[0].args.join(" ")).toContain("sourceBranches=%5B%22feature%22%5D");
      expect(run.mock.calls[0]?.[0].args.join(" ")).toContain("state=open");
      expect(run).toHaveBeenCalledTimes(3);
    }),
  );
  it.effect("finds a fork match on a subsequent keyset page", () =>
    Effect.gen(function* () {
      const fork = {
        ...pull,
        number: 8,
        isCrossFork: true,
        sourceRepo: { owner: "alice", name: "fork" },
      };
      run.mockReturnValueOnce(Effect.succeed(output({ nextAfter: "pr_next", items: [pull] })));
      run.mockReturnValueOnce(Effect.succeed(output(pull)));
      run.mockReturnValueOnce(Effect.succeed(output({ nextAfter: null, items: [fork] })));
      run.mockReturnValueOnce(Effect.succeed(output(fork)));
      const cafe = yield* GitCafeCli.GitCafeCli;
      const items = yield* cafe.listChangeRequests({
        cwd: "/repo",
        context,
        source: { refName: "feature", repository: "alice/fork" },
        headSelector: "feature",
        state: "all",
        limit: 1,
      });
      expect(items.map((item) => item.number)).toEqual([8]);
      expect(run.mock.calls[2]?.[0].args.join(" ")).toContain("after=pr_next");
    }),
  );
  it.effect("reports pending repository admission without claiming clone/push readiness", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(
        Effect.succeed(
          output({
            schemaVersion: 1,
            data: { resource: { owner: "org", name: "new", repoId: "repo_new", state: "pending" } },
          }),
        ),
      );
      const cafe = yield* GitCafeCli.GitCafeCli;
      const error = yield* cafe
        .createRepository({ cwd: "/repo", repository: "org/new", visibility: "private" })
        .pipe(Effect.flip);
      expect(error.code).toBe("RECOVERY_REQUIRED");
      expect(error.detail).toContain("/orgs/org/admissions/repo_new");
      expect(run).toHaveBeenCalledTimes(1);
    }),
  );
  it.effect("creates a fork PR against an explicit destination and body file", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(
        Effect.succeed(output({ schemaVersion: 1, data: { resource: pull } })),
      );
      const cafe = yield* GitCafeCli.GitCafeCli;
      yield* cafe.createChangeRequest({
        cwd: "/repo",
        context,
        source: { owner: "alice", repository: "alice/fork", refName: "feature" },
        target: { repository: "team/project", refName: "trunk" },
        headSelector: "alice:feature",
        baseRefName: "main",
        title: "Multiline body",
        bodyFile: "/tmp/body.md",
      });
      expect(run.mock.calls[0]?.[0].args).toEqual([
        ...GitCafeCli.CLI_ARGS,
        "pr",
        "create",
        "--json",
        "--repo",
        "team/project",
        "--head",
        "alice/fork:feature",
        "--base",
        "trunk",
        "--title",
        "Multiline body",
        "--body-file",
        "/tmp/body.md",
      ]);
    }),
  );
  it.effect("preserves structured authentication, forbidden, and rate-limit errors", () =>
    Effect.gen(function* () {
      const cafe = yield* GitCafeCli.GitCafeCli;
      for (const [code, status] of [
        ["AUTHENTICATION_REQUIRED", 401],
        ["FORBIDDEN", 403],
        ["RATE_LIMITED", 429],
      ] as const) {
        run.mockReturnValueOnce(Effect.succeed(output(null, 1, failure(code, status))));
        expect(
          yield* cafe.api({ cwd: "/repo", endpoint: "/auth/identity" }).pipe(Effect.flip),
        ).toMatchObject({ code, status, detail: `Failure ${code}` });
      }
    }),
  );
  it.effect("preserves the Cafe failure envelope following a raw API problem document", () =>
    Effect.gen(function* () {
      const stderr =
        '{"type":"about:blank","title":"Git source request failed","status":404,"code":"not-found"}\n' +
        failure("NOT_FOUND", 404) +
        "\n";
      run.mockReturnValueOnce(Effect.succeed({ ...output(null, 5, stderr), stdout: "" }));
      const cafe = yield* GitCafeCli.GitCafeCli;
      const result = yield* cafe
        .api({ cwd: "/repo", endpoint: "/repos/versecafe/ashlar/pulls/12/changes" })
        .pipe(Effect.flip);
      expect(result).toMatchObject({ code: "NOT_FOUND", status: 404, detail: "Failure NOT_FOUND" });
    }),
  );
  it.effect("rejects invalid PR JSON instead of inventing branch or state defaults", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(Effect.succeed(output({ ...pull, number: 0 })));
      const cafe = yield* GitCafeCli.GitCafeCli;
      expect(
        (yield* cafe.getChangeRequest({ cwd: "/repo", context, reference: "7" }).pipe(Effect.flip))
          .detail,
      ).toContain("invalid JSON");
    }),
  );
  it.effect("reads the actual default branch", () =>
    Effect.gen(function* () {
      run.mockReturnValueOnce(Effect.succeed(output({ name: "project", defaultBranch: "trunk" })));
      const cafe = yield* GitCafeCli.GitCafeCli;
      expect(yield* cafe.getDefaultBranch({ cwd: "/repo", context })).toBe("trunk");
    }),
  );
  for (const force of [true, false]) {
    it.effect(`checkout ${force ? "replaces" : "preserves"} an existing local branch`, () =>
      Effect.gen(function* () {
        run.mockReturnValueOnce(Effect.succeed(output(pull)));
        if (force) run.mockReturnValueOnce(Effect.succeed(output(null)));
        listLocalBranchNames.mockReturnValueOnce(Effect.succeed(["feature"]));
        fetchRemoteBranch.mockReturnValue(Effect.void);
        fetchRemoteTrackingBranch.mockReturnValue(Effect.void);
        setBranchUpstream.mockReturnValue(Effect.void);
        switchRef.mockReturnValue(Effect.succeed({ refName: "feature" }));
        const cafe = yield* GitCafeCli.GitCafeCli;
        yield* cafe.checkoutChangeRequest({ cwd: "/repo", context, reference: "7", force });
        expect(ensureRemote).not.toHaveBeenCalled();
        expect(fetchRemoteTrackingBranch).toHaveBeenCalledWith(
          expect.objectContaining({ remoteName: "origin", remoteBranch: "feature" }),
        );
        expect(fetchRemoteBranch).not.toHaveBeenCalled();
        if (force)
          expect(run.mock.calls[1]?.[0]).toMatchObject({
            command: "git",
            args: ["checkout", "-B", "feature", "refs/remotes/origin/feature", "--"],
          });
        expect(switchRef).toHaveBeenCalledWith({ cwd: "/repo", refName: "feature" });
      }),
    );
  }
});

it("discovery identifies a valid account and keeps transient failures separate from sign-out", () => {
  expect(
    discovery.parseAuth(
      output({ schemaVersion: 1, data: { host: "git.cafe", username: "alice" } }),
    ),
  ).toMatchObject({ status: "authenticated", account: Option.some("alice") });
  expect(discovery.parseAuth(output(null, 1, failure("AUTHENTICATION_REQUIRED", 401))).status).toBe(
    "unauthenticated",
  );
  expect(discovery.parseAuth(output(null, 1, failure("FORBIDDEN", 403))).status).toBe("unknown");
  expect(discovery.parseAuth(output(null, 1, failure("NETWORK_ERROR", null))).status).toBe(
    "unknown",
  );
});
