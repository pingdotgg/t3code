import { GitCommandError, SourceControlProviderKind } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcessSpawner } from "effect/process";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as EntireSourceControlProvider from "./EntireSourceControlProvider.ts";
import * as Fixtures from "./entireFixtures.ts";
import { realGit } from "./entireGitFixture.ts";
import { fakeEntire, PROJECT_ID, PROJECT_TRAILS, REMOTE_URL, REPO_ID } from "./entireTestServer.ts";

const NoFiles = FileSystem.layerNoop({});
const withFiles = (
  server: ReturnType<typeof fakeEntire>,
  files: Layer.Layer<FileSystem.FileSystem> = NoFiles,
) => Layer.merge(server.layer, files);

const auth = (stdout: unknown, exitCode = 0) =>
  EntireSourceControlProvider.parseAuth({
    stdout: JSON.stringify(stdout),
    stderr: "",
    exitCode: ChildProcessSpawner.ExitCode(exitCode),
  });

describe("EntireSourceControlProvider", () => {
  it("reads a signed-in account and keeps an unreachable server apart from sign-out", () => {
    const signedIn = auth({ logged_in: true, user: "github:alice", server: "us.entire.io" });
    assert.strictEqual(signedIn.status, "authenticated");
    assert.deepStrictEqual(signedIn.account, Option.some("github:alice"));
    assert.strictEqual(auth({ logged_in: false }, 1).status, "unauthenticated");
    assert.strictEqual(
      auth({ logged_in: false, error: "dial tcp: connection refused" }, 1).status,
      "unknown",
    );
    assert.strictEqual(
      EntireSourceControlProvider.parseAuth({
        stdout: "not json",
        stderr: "",
        exitCode: ChildProcessSpawner.ExitCode(1),
      }).status,
      "unknown",
    );
  });

  it.effect("discovers the CLI's sign-in without telemetry and claims no unknown host", () =>
    Effect.gen(function* () {
      const spec = yield* EntireSourceControlProvider.makeDiscovery;
      const result = yield* spec.probe("/repo");
      assert.strictEqual(result.auth.status, "authenticated");
      assert.deepStrictEqual(result.auth.account, Option.some("github:entire-user"));
    }).pipe(
      Effect.provide(
        TestSourceControlHost.layer({
          process: {
            run: (input) => {
              assert.strictEqual(input.command, "entire");
              assert.strictEqual(input.env?.ENTIRE_TELEMETRY_OPTOUT, "1");
              return Effect.succeed(
                TestSourceControlHost.processOutput(
                  input.args.join(" ") === "version"
                    ? "entire version 0.12.0\n"
                    : JSON.stringify({ logged_in: true, user: "github:entire-user" }),
                ),
              );
            },
          },
        }),
      ),
    ),
  );

  it.effect("names a trail's repository by its clone URL and only Entire remotes", () => {
    const server = fakeEntire({ "GET /trails/7": Fixtures.detail });
    return Effect.gen(function* () {
      const provider = yield* EntireSourceControlProvider.make;
      assert.strictEqual(provider.repositoryNameFromRemoteUrl?.(REMOTE_URL), "gh/acme/web");
      assert.isNull(provider.repositoryNameFromRemoteUrl?.("git@github.com:acme/web.git") ?? null);
      const trail = yield* provider.getChangeRequest({
        cwd: "/repo",
        reference: "https://entire.io/gh/acme/web/trails/7",
      });
      assert.deepInclude(trail, {
        provider: SourceControlProviderKind.make("entire"),
        number: 7,
        headRefName: "feature",
        baseRefName: "main",
        headSha: Fixtures.HEAD_SHA,
        state: "open",
      });
      assert.isTrue(Option.isSome(trail.updatedAt));
    }).pipe(Effect.provide(withFiles(server)));
  });

  it.effect("reads a named trail by path, and says why it found no remote, when git fails", () => {
    const gitFailure = new GitCommandError({
      operation: "resolvePrimaryRemoteName",
      command: "git remote",
      cwd: "/repo",
      detail: "not a git repository",
    });
    const server = fakeEntire(
      { "GET /trails/7": Fixtures.detail },
      { git: { resolvePrimaryRemoteName: () => Effect.fail(gitFailure) } },
    );
    return Effect.gen(function* () {
      const provider = yield* EntireSourceControlProvider.make;
      // A trail URL names its repository, so the unreadable checkout costs only the remote.
      const trail = yield* provider.getChangeRequest({
        cwd: "/repo",
        reference: "https://entire.io/gh/acme/web/trails/7",
      });
      assert.strictEqual(trail.number, 7);
      assert.deepStrictEqual(server.references, ["/gh/acme/web"]);
      // Without a named repository there is nothing to read, and the git failure is kept.
      const error = yield* provider
        .listChangeRequests({ cwd: "/repo", headSelector: "feature", state: "open" })
        .pipe(Effect.flip);
      assert.strictEqual(error.detail, "No Entire repository remote was found.");
      assert.strictEqual(error.cause, gitFailure);
      assert.deepStrictEqual(
        server.sent.map((sent) => sent.path),
        ["/trails/7"],
      );
    }).pipe(Effect.provide(withFiles(server)));
  });

  it.effect("finds a branch's trails by reading the trail list", () => {
    const server = fakeEntire({
      "GET /trails": {
        items: [Fixtures.trail, { ...Fixtures.trail, number: 8, branch: "other" }],
        next_cursor: null,
      },
    });
    return Effect.gen(function* () {
      const provider = yield* EntireSourceControlProvider.make;
      const trails = yield* provider.listChangeRequests({
        cwd: "/repo",
        headSelector: "feature",
        state: "open",
      });
      assert.deepStrictEqual(
        trails.map((trail) => trail.number),
        [7],
      );
      // Entire narrows the list to trails whose title or branch contains the branch's name.
      assert.strictEqual(server.sent[0]?.query.get("q"), "feature");
    }).pipe(Effect.provide(withFiles(server)));
  });

  it.effect("says it could not finish a branch's search rather than finding no trail", () => {
    let page = 0;
    const server = fakeEntire({
      "GET /trails": () => ({
        items: [{ ...Fixtures.trail, number: 8, branch: "feature-other" }],
        next_cursor: `page-${++page}`,
      }),
    });
    return Effect.gen(function* () {
      const provider = yield* EntireSourceControlProvider.make;
      const failure = yield* provider
        .listChangeRequests({ cwd: "/repo", headSelector: "feature", state: "open" })
        .pipe(Effect.flip);
      assert.include(failure.detail, "feature");
    }).pipe(Effect.provide(withFiles(server)));
  });

  it.effect("creates a project trail and links the pushed branch as its change", () => {
    const server = fakeEntire(
      {
        [`POST ${PROJECT_TRAILS}`]: { id: "01J0TRAIL", projectId: PROJECT_ID, number: 1070 },
        [`POST ${PROJECT_TRAILS}/01J0TRAIL/changes`]: {
          id: "01J0CHANGE",
          trailId: "01J0TRAIL",
          repositoryId: REPO_ID,
        },
      },
      { etag: 'W/"v1"' },
    );
    return Effect.gen(function* () {
      const provider = yield* EntireSourceControlProvider.make;
      yield* provider.createChangeRequest({
        cwd: "/repo",
        baseRefName: "main",
        headSelector: "feature",
        title: "Add the thing",
        bodyFile: "/tmp/body.md",
      });
      assert.deepStrictEqual(server.writes(), [
        `POST ${PROJECT_TRAILS}`,
        `POST ${PROJECT_TRAILS}/01J0TRAIL/changes`,
      ]);
      const [create, link] = server.sent;
      assert.strictEqual(create?.query.get("project_id"), PROJECT_ID);
      assert.deepStrictEqual(create?.body, {
        title: "Add the thing",
        body: "Body",
        repoIds: [REPO_ID],
      });
      assert.deepStrictEqual(link?.body, {
        repositoryId: REPO_ID,
        title: "Add the thing",
        body: "Body",
        branchName: "feature",
        branchAction: "link",
        base: "main",
      });
      // The link is conditional on the trail just created, and safe to retry.
      assert.strictEqual(link?.headers["if-match"], 'W/"v1"');
      assert.strictEqual(link?.headers["idempotency-key"], `t3code-01J0TRAIL-${REPO_ID}`);
    }).pipe(
      Effect.provide(
        withFiles(
          server,
          FileSystem.layerNoop({
            readFileString: (path) =>
              path === "/tmp/body.md" ? Effect.succeed("Body") : Effect.die(path),
          }),
        ),
      ),
    );
  });

  // The CLI names no owning project for a repository mirrored from GitHub; Entire's repository does.
  it.effect("asks the repository for its project when the CLI names none", () => {
    const server = fakeEntire(
      {
        "GET ": { id: REPO_ID, owning_project_id: PROJECT_ID },
        [`POST ${PROJECT_TRAILS}`]: { id: "01J0TRAIL", projectId: PROJECT_ID, number: 1070 },
        [`POST ${PROJECT_TRAILS}/01J0TRAIL/changes`]: {
          id: "01J0CHANGE",
          trailId: "01J0TRAIL",
          repositoryId: REPO_ID,
        },
      },
      { etag: 'W/"v1"', coordinates: { repoId: REPO_ID, projectId: null } },
    );
    return Effect.gen(function* () {
      const provider = yield* EntireSourceControlProvider.make;
      yield* provider.createChangeRequest({
        cwd: "/repo",
        baseRefName: "main",
        headSelector: "feature",
        title: "Add the thing",
        bodyFile: "/tmp/body.md",
      });
      const create = server.sent.find((request) => request.method === "POST");
      assert.strictEqual(create?.query.get("project_id"), PROJECT_ID);
    }).pipe(
      Effect.provide(
        withFiles(server, FileSystem.layerNoop({ readFileString: () => Effect.succeed("") })),
      ),
    );
  });

  it.effect("says how to finish when the trail was created but the branch did not link", () => {
    const server = fakeEntire(
      {
        [`POST ${PROJECT_TRAILS}`]: { id: "01J0TRAIL", projectId: PROJECT_ID, number: 1070 },
      },
      { etag: 'W/"v1"' },
    );
    return Effect.gen(function* () {
      const provider = yield* EntireSourceControlProvider.make;
      const failure = yield* provider
        .createChangeRequest({
          cwd: "/repo",
          baseRefName: "main",
          headSelector: "feature",
          title: "Add the thing",
          bodyFile: "/tmp/body.md",
        })
        .pipe(Effect.flip);
      assert.include(failure.detail, "entire trail link 1070 --branch feature");
      assert.deepStrictEqual(server.writes(), [
        `POST ${PROJECT_TRAILS}`,
        `POST ${PROJECT_TRAILS}/01J0TRAIL/changes`,
      ]);
    }).pipe(
      Effect.provide(
        withFiles(server, FileSystem.layerNoop({ readFileString: () => Effect.succeed("") })),
      ),
    );
  });

  it.effect("clones over the checkout's own remote and creates no repositories", () => {
    const server = fakeEntire({});
    return Effect.gen(function* () {
      const provider = yield* EntireSourceControlProvider.make;
      assert.deepStrictEqual(
        yield* provider.getRepositoryCloneUrls({ cwd: "/repo", repository: "gh/acme/web" }),
        { nameWithOwner: "gh/acme/web", url: REMOTE_URL, sshUrl: REMOTE_URL },
      );
      const created = yield* provider
        .createRepository({ cwd: "/repo", repository: "et/acme/new", visibility: "private" })
        .pipe(Effect.flip);
      assert.strictEqual(created._tag, "SourceControlProviderError");
      assert.deepStrictEqual(server.sent, []);
    }).pipe(Effect.provide(withFiles(server)));
  });

  it.effect.each([
    ["aws-us-east-2.entire.io", "entire://aws-us-east-2.entire.io/gh/acme/web"],
    ["a@evil.example", null],
    ["evil.example/gh/acme/web?", null],
  ] as const)(
    "clones from the cluster the CLI names only if it is a host: %s",
    ([cluster, url]) => {
      const server = fakeEntire({}, { remoteUrl: null, coordinates: { cluster } });
      return Effect.gen(function* () {
        const provider = yield* EntireSourceControlProvider.make;
        const urls = yield* provider
          .getRepositoryCloneUrls({ cwd: "/repo", repository: "gh/acme/web" })
          .pipe(Effect.result);
        if (url === null) assert.isTrue(Result.isFailure(urls));
        else
          assert.deepStrictEqual(
            urls,
            Result.succeed({ nameWithOwner: "gh/acme/web", url, sshUrl: url }),
          );
      }).pipe(Effect.provide(withFiles(server)));
    },
  );

  describe("checking a trail's branch out", () => {
    const checkout = (branch: string) => {
      const fetched: Array<string> = [];
      const switched: Array<string> = [];
      const server = fakeEntire(
        { "GET /trails/7": { ...Fixtures.detail, branch } },
        {
          git: {
            // check-ref-format needs no repository, so it runs for real beside the fake checkout.
            execute: (input) => realGit.execute!({ ...input, cwd: "." }),
            listLocalBranchNames: () => Effect.succeed([]),
            fetchRemoteBranch: (input) =>
              Effect.sync(() => {
                fetched.push(`${input.remoteName}/${input.remoteBranch}->${input.localBranch}`);
              }),
            setBranchUpstream: () => Effect.void,
            switchRef: (input) =>
              Effect.sync(() => {
                switched.push(input.refName);
                return { refName: input.refName };
              }),
          },
        },
      );
      return { server, fetched, switched };
    };

    it.effect("checks it out from the checkout's Entire remote", () => {
      const { server, fetched, switched } = checkout("feature");
      return Effect.gen(function* () {
        const provider = yield* EntireSourceControlProvider.make;
        yield* provider.checkoutChangeRequest({ cwd: "/repo", reference: "7" });
        assert.deepStrictEqual(fetched, ["origin/feature->feature"]);
        assert.deepStrictEqual(switched, ["feature"]);
      }).pipe(Effect.provide(withFiles(server)));
    });

    it.effect("refuses a branch name git would read as a refspec or pattern", () => {
      const { server, fetched } = checkout("a:b*");
      return Effect.gen(function* () {
        const provider = yield* EntireSourceControlProvider.make;
        const failure = yield* provider
          .checkoutChangeRequest({ cwd: "/repo", reference: "7" })
          .pipe(Effect.flip);
        assert.strictEqual(failure.detail, "Entire named a branch git cannot check out.");
        assert.deepStrictEqual(fetched, []);
      }).pipe(Effect.provide(withFiles(server)));
    });
  });
});
