import { afterEach, beforeEach, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessSpawnError } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitCafeCli from "./GitCafeCli.ts";
import * as GitCafeCredentials from "./GitCafeCredentials.ts";
import { discovery, makeDiscovery } from "./GitCafeSourceControlProvider.ts";

const run = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();
const fetchRemoteBranch = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteBranch"]>();
const fetchRemoteTrackingBranch =
  vi.fn<GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"]>();
const ensureRemote = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["ensureRemote"]>();
const switchRef = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["switchRef"]>();
const listLocalBranchNames = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["listLocalBranchNames"]>();
const setBranchUpstream = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["setBranchUpstream"]>();
/** What the host answers each REST call with: a JSON body, or a status and raw text. */
const http = vi.fn<(request: HttpClientRequest.HttpClientRequest) => Response>();
const getCredential = vi.fn<GitCafeCredentials.GitCafeCredentials["Service"]["get"]>();
const invalidateCredential =
  vi.fn<GitCafeCredentials.GitCafeCredentials["Service"]["invalidate"]>();
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const requestBody = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined;
const layer = it.layer(
  GitCafeCli.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => HttpClientResponse.fromWeb(request, http(request))),
          ),
        ),
        Layer.mock(GitCafeCredentials.GitCafeCredentials)({
          get: (host) => getCredential(host),
          invalidate: (host) => invalidateCredential(host),
        }),
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
const HOSTS = ["git.cafe", "staging.git.cafe"] as const;
afterEach(() => vi.resetAllMocks());
beforeEach(() => {
  getCredential.mockImplementation((host) =>
    Effect.succeed({ host, token: Redacted.make("cafe-token"), source: "cafe" }),
  );
  invalidateCredential.mockReturnValue(Effect.void);
});

layer("GitCafeCli", (it) => {
  it.effect.each(HOSTS)(
    "keeps %s repository lookup, PR reads, and fork checkout on their origin",
    (host) => {
      const hostContext = {
        ...context,
        provider: { ...context.provider, baseUrl: `https://${host}` },
        remoteUrl: `ssh@${host}:team/project.git`,
      };
      return Effect.gen(function* () {
        const cafe = yield* GitCafeCli.GitCafeCli;
        http.mockReturnValueOnce(reply({ name: "project", defaultBranch: "main" }));
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
        http.mockReturnValueOnce(reply(pull));
        expect(
          (yield* cafe.getChangeRequest({ cwd: "/repo", context: hostContext, reference: "7" }))
            .url,
        ).toBe(`https://${host}/team/project/pulls/7`);
        http.mockReturnValueOnce(
          reply({ ...pull, isCrossFork: true, sourceRepo: { owner: "alice", name: "fork" } }),
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
        expect(http.mock.calls.map(([request]) => new URL(request.url).origin)).toEqual([
          `https://${host}`,
          `https://${host}`,
          `https://${host}`,
        ]);
        expect(getCredential.mock.calls.every(([credentialHost]) => credentialHost === host)).toBe(
          true,
        );
      });
    },
  );
  it.effect.each(HOSTS)("publishes repositories on %s with matching Git URLs", (host) =>
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
  it.effect("rejects unsupported API origins before asking for a credential", () =>
    Effect.gen(function* () {
      const cafe = yield* GitCafeCli.GitCafeCli;
      const failure = yield* cafe
        .api({ cwd: "/repo", host: "sub.git.cafe", endpoint: "/auth/principal" })
        .pipe(Effect.flip);
      expect(failure.detail).toContain("Unsupported GitCafe host");
      expect(getCredential).not.toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
    }),
  );

  it.effect("tells a missing CLI apart from a missing login", () =>
    Effect.gen(function* () {
      const cafe = yield* GitCafeCli.GitCafeCli;
      for (const [cause, code] of [
        [new GitCafeCredentials.GitCafeCliMissingError({ host: "git.cafe" }), "CLI_UNAVAILABLE"],
        [
          new GitCafeCredentials.GitCafeNotSignedInError({ host: "git.cafe" }),
          "AUTHENTICATION_REQUIRED",
        ],
      ] as const) {
        getCredential.mockReturnValueOnce(Effect.fail(cause));
        expect(
          yield* cafe.api({ cwd: "/repo", endpoint: "/auth/principal" }).pipe(Effect.flip),
        ).toMatchObject({ code, status: null, detail: cause.message });
      }
      expect(http).not.toHaveBeenCalled();
    }),
  );
  it.effect("sends the bearer token, headers and JSON body to the host's API", () =>
    Effect.gen(function* () {
      http.mockReturnValueOnce(reply({ ok: true }));
      const cafe = yield* GitCafeCli.GitCafeCli;
      expect(
        yield* cafe.api({
          cwd: "/repo",
          endpoint: "/repos/team/project/stacks/1/restack",
          method: "POST",
          body: { expectedHead: "abc" },
          headers: { "Idempotency-Key": "operation-1" },
        }),
      ).toBe('{"ok":true}');
      const [request] = http.mock.calls[0]!;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("https://git.cafe/api/repos/team/project/stacks/1/restack");
      expect(request.headers).toMatchObject({
        authorization: "Bearer cafe-token",
        "idempotency-key": "operation-1",
      });
      expect(requestBody(request)).toBe('{"expectedHead":"abc"}');
    }),
  );
  it.effect("targets repository reads explicitly and normalizes clone URLs", () =>
    Effect.gen(function* () {
      http.mockReturnValueOnce(reply({ name: "project", defaultBranch: "trunk" }));
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
      expect(http.mock.calls[0]?.[0].url).toBe("https://git.cafe/api/repos/team/project");
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
      http.mockReturnValueOnce(
        reply({
          ...pull,
          draft: true,
          isCrossFork: true,
          sourceRepo: { owner: "alice", name: "fork" },
        }),
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
      expect(http.mock.calls[0]?.[0].url).toBe("https://git.cafe/api/repos/other/repo/pulls/7");
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
      http.mockReturnValueOnce(
        reply({
          next: null,
          items: [pull, fork, { ...pull, number: 9, sourceBranch: "unrelated" }],
        }),
      );
      http.mockReturnValueOnce(reply(pull));
      http.mockReturnValueOnce(reply(fork));
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
      expect(http.mock.calls[0]?.[0].url).toContain("sourceBranches=%5B%22feature%22%5D");
      expect(http.mock.calls[0]?.[0].url).toContain("state=open");
      expect(http).toHaveBeenCalledTimes(3);
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
      http.mockReturnValueOnce(reply({ next: "pr_next", items: [pull] }));
      http.mockReturnValueOnce(reply(pull));
      http.mockReturnValueOnce(reply({ next: null, items: [fork] }));
      http.mockReturnValueOnce(reply(fork));
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
      expect(http.mock.calls[2]?.[0].url).toContain("after=pr_next");
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
  it.effect.each([
    { name: "a refreshed cafe login is retried once", source: "cafe", rotates: true, calls: 2 },
    { name: "an unchanged cafe login is not retried", source: "cafe", rotates: false, calls: 1 },
    { name: "an environment token is not retried", source: "env", rotates: true, calls: 1 },
  ] as const)("after a 401, $name", (scenario) =>
    Effect.gen(function* () {
      let lookups = 0;
      getCredential.mockImplementation((host) =>
        Effect.succeed({
          host,
          token: Redacted.make(scenario.rotates && lookups++ > 0 ? "new-token" : "old-token"),
          source: scenario.source,
        }),
      );
      http.mockImplementation((request) =>
        request.headers.authorization === "Bearer new-token"
          ? reply({ handle: "alice" })
          : reply({ type: "https://cafe.sh/errors/authentication-required" }, 401),
      );
      const cafe = yield* GitCafeCli.GitCafeCli;
      const result = yield* cafe
        .api({ cwd: "/repo", endpoint: "/auth/principal" })
        .pipe(Effect.result);
      expect(http).toHaveBeenCalledTimes(scenario.calls);
      expect(result._tag).toBe(scenario.calls === 2 ? "Success" : "Failure");
      expect(invalidateCredential).toHaveBeenCalledWith("git.cafe");
    }),
  );
  it.effect("maps problem documents to codes and drops a refused token", () =>
    Effect.gen(function* () {
      const cafe = yield* GitCafeCli.GitCafeCli;
      for (const [type, status, code] of [
        ["https://cafe.sh/errors/authentication-required", 401, "AUTHENTICATION_REQUIRED"],
        ["https://cafe.sh/errors/forbidden", 403, "FORBIDDEN"],
        ["https://cafe.sh/errors/rate-limited", 429, "RATE_LIMITED"],
        ["https://cafe.sh/errors/not-found", 404, "NOT_FOUND"],
        [undefined, 401, "AUTHENTICATION_REQUIRED"],
      ] as const) {
        http.mockReturnValueOnce(
          reply(
            { ...(type === undefined ? {} : { type }), title: "Refused", detail: `No ${status}` },
            status,
          ),
        );
        expect(
          yield* cafe.api({ cwd: "/repo", endpoint: "/auth/principal" }).pipe(Effect.flip),
        ).toMatchObject({ code, status, detail: `No ${status}` });
      }
      // Only the two refusals of the token itself make the next read ask its source again.
      expect(invalidateCredential).toHaveBeenCalledTimes(2);
    }),
  );
  it.effect("rejects invalid PR JSON instead of inventing branch or state defaults", () =>
    Effect.gen(function* () {
      http.mockReturnValueOnce(reply({ ...pull, number: 0 }));
      const cafe = yield* GitCafeCli.GitCafeCli;
      expect(
        (yield* cafe.getChangeRequest({ cwd: "/repo", context, reference: "7" }).pipe(Effect.flip))
          .detail,
      ).toContain("invalid JSON");
    }),
  );
  it.effect("reads the actual default branch", () =>
    Effect.gen(function* () {
      http.mockReturnValueOnce(reply({ name: "project", defaultBranch: "trunk" }));
      const cafe = yield* GitCafeCli.GitCafeCli;
      expect(yield* cafe.getDefaultBranch({ cwd: "/repo", context })).toBe("trunk");
    }),
  );
  it.effect.each([true, false])(
    "checkout with force=%s keeps the existing local branch in step",
    (force) =>
      Effect.gen(function* () {
        http.mockReturnValueOnce(reply(pull));
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
          expect(run.mock.calls[0]?.[0]).toMatchObject({
            command: "git",
            args: ["checkout", "-B", "feature", "refs/remotes/origin/feature", "--"],
          });
        expect(switchRef).toHaveBeenCalledWith({ cwd: "/repo", refName: "feature" });
      }),
  );
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

it.effect.each([
  { name: "a working token", principal: { handle: "alice" }, status: "authenticated" },
  { name: "a refused token", principal: null, status: "unauthenticated" },
] as const)("discovery reports CAFE_TOKEN without cafe installed: $name", (scenario) =>
  Effect.gen(function* () {
    const spec = yield* makeDiscovery;
    if (spec.type !== "managed-cli") throw new Error("expected a managed discovery");
    const item = yield* spec.probe("/repo");
    expect(item.status).toBe("available");
    expect(item.auth).toMatchObject({ status: scenario.status, host: Option.some("git.cafe") });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitCafeCli.GitCafeCli)({
          api: () =>
            scenario.principal === null
              ? Effect.fail(
                  new GitCafeCli.GitCafeCliError({
                    command: "cafe",
                    cwd: "/repo",
                    code: "AUTHENTICATION_REQUIRED",
                    status: 401,
                    detail: "Refused",
                  }),
                )
              : Effect.succeed(JSON.stringify(scenario.principal)),
        }),
        // No `cafe` on PATH at all.
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.fail(
              new VcsProcessSpawnError({
                operation: "probe",
                command: input.command,
                cwd: "/repo",
                cause: PlatformError.systemError({
                  _tag: "NotFound",
                  module: "ChildProcess",
                  method: "spawn",
                }),
              }),
            ),
        }),
      ),
    ),
    Effect.provideService(HostProcessEnvironment, { CAFE_TOKEN: "env-token" }),
  ),
);
