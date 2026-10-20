import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitCafeApi from "./GitCafeApi.ts";
import * as GitCafeCredentials from "./GitCafeCredentials.ts";
import * as GitCafeSourceControlProvider from "./GitCafeSourceControlProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const authAnswer = (input: { stdout?: unknown; stderr?: unknown; exitCode?: number }) => ({
  stdout: input.stdout === undefined ? "" : encodeJson(input.stdout),
  stderr: input.stderr === undefined ? "" : encodeJson(input.stderr),
  exitCode: ChildProcessSpawner.ExitCode(input.exitCode ?? 0),
});
const failure = (code: string, status: number | null) => ({
  schemaVersion: 1,
  error: { code, status, message: `Failure ${code}` },
});

/** Most calls touch no file; one that does fails the test. */
const NoFiles = FileSystem.layerNoop({});

/** A provider on git.cafe whose checkout has no remote and which may not run `cafe`. */
const layerFor = (
  client: HttpClient.HttpClient,
  options: { readonly files?: Layer.Layer<FileSystem.FileSystem> } = {},
) =>
  Layer.merge(GitCafeApi.layer, options.files ?? NoFiles).pipe(
    Layer.provideMerge(GitCafeCredentials.layer),
    Layer.provideMerge(
      TestSourceControlHost.layer({
        git: {
          resolvePrimaryRemoteName: () =>
            Effect.fail(
              new GitCommandError({
                operation: "resolvePrimaryRemoteName",
                command: "git remote",
                cwd: "/repo",
                detail: "No git remote is configured.",
              }),
            ),
        },
      }),
    ),
    Layer.provide(Layer.succeed(HostProcess.Environment, { CAFE_TOKEN: "env-token" })),
    Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );

describe("GitCafeSourceControlProvider", () => {
  it("reads a signed-in account and keeps transient failures apart from sign-out", () => {
    const { parseAuth } = GitCafeSourceControlProvider;
    const signedIn = parseAuth(
      authAnswer({ stdout: { schemaVersion: 1, data: { host: "git.cafe", username: "alice" } } }),
    );
    assert.strictEqual(signedIn.status, "authenticated");
    assert.deepStrictEqual(signedIn.account, Option.some("alice"));
    assert.strictEqual(
      parseAuth(authAnswer({ stderr: failure("AUTHENTICATION_REQUIRED", 401), exitCode: 1 }))
        .status,
      "unauthenticated",
    );
    for (const [code, status] of [
      ["FORBIDDEN", 403],
      ["NETWORK_ERROR", null],
    ] as const) {
      assert.strictEqual(
        parseAuth(authAnswer({ stderr: failure(code, status), exitCode: 1 })).status,
        "unknown",
      );
    }
  });

  it.effect.each([
    ["https://staging.git.cafe/team/project.git", "staging.git.cafe"],
    ["ssh@git.cafe:team/project.git", "git.cafe"],
  ] as const)("resolves the repository from the remote %s", ([remoteUrl, host]) => {
    const urls: Array<string> = [];
    const client = HttpClient.make((request) => {
      urls.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(encodeJson({ name: "project", defaultBranch: "trunk" })),
        ),
      );
    });
    const context = {
      provider: {
        kind: SourceControlProviderKind.make("gitcafe"),
        name: "GitCafe",
        baseUrl: `https://${host}`,
      },
      remoteName: "origin",
      remoteUrl,
    };
    return Effect.gen(function* () {
      const provider = yield* GitCafeSourceControlProvider.make;
      assert.strictEqual(provider.kind, "gitcafe");
      assert.strictEqual(yield* provider.getDefaultBranch({ cwd: "/repo", context }), "trunk");
      assert.deepStrictEqual(
        yield* provider.getRepositoryCloneUrls({ cwd: "/repo", context, repository: remoteUrl }),
        {
          nameWithOwner: "team/project",
          url: `https://${host}/team/project`,
          sshUrl: `ssh@${host}:team/project.git`,
        },
      );
      assert.deepStrictEqual(urls, [
        `https://${host}/api/repos/team/project`,
        `https://${host}/api/repos/team/project`,
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(GitCafeApi.layer, NoFiles).pipe(
          Layer.provideMerge(GitCafeCredentials.layer),
          Layer.provideMerge(TestSourceControlHost.layer()),
          Layer.provide(
            Layer.succeed(HostProcess.Environment, { CAFE_TOKEN: "env-token", CAFE_HOST: host }),
          ),
          Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        ),
      ),
    );
  });

  it.effect(
    "reads a bare owner/name on git.cafe without a remote, and no other host's pulls",
    () => {
      const urls: Array<string> = [];
      const client = HttpClient.make((request) => {
        urls.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(encodeJson({ name: "project", defaultBranch: "trunk" })),
          ),
        );
      });
      return Effect.gen(function* () {
        const provider = yield* GitCafeSourceControlProvider.make;
        assert.deepStrictEqual(
          yield* provider.getRepositoryCloneUrls({ cwd: "/repo", repository: "team/project" }),
          {
            nameWithOwner: "team/project",
            url: "https://git.cafe/team/project",
            sshUrl: "ssh@git.cafe:team/project.git",
          },
        );
        const foreign = yield* provider
          .getChangeRequest({
            cwd: "/repo",
            reference: "https://example.com/team/project/pulls/42",
          })
          .pipe(Effect.flip);
        assert.strictEqual(foreign._tag, "SourceControlProviderError");
        assert.deepStrictEqual(urls, ["https://git.cafe/api/repos/team/project"]);
      }).pipe(
        Effect.provide(
          Layer.merge(GitCafeApi.layer, NoFiles).pipe(
            Layer.provideMerge(GitCafeCredentials.layer),
            Layer.provideMerge(
              TestSourceControlHost.layer({
                git: {
                  resolvePrimaryRemoteName: () =>
                    Effect.fail(
                      new GitCommandError({
                        operation: "resolvePrimaryRemoteName",
                        command: "git remote",
                        cwd: "/repo",
                        detail: "No git remote is configured.",
                      }),
                    ),
                },
              }),
            ),
            Layer.provide(Layer.succeed(HostProcess.Environment, { CAFE_TOKEN: "env-token" })),
            Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
            Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          ),
        ),
      );
    },
  );

  it.effect.each([
    ["no context", undefined, "https://git.cafe/fork/project.git"],
    ["an HTTPS remote", "https://git.cafe/team/project.git", "https://git.cafe/fork/project.git"],
    ["an SSH remote", "ssh@git.cafe:team/project.git", "ssh@git.cafe:fork/project.git"],
    ["an ssh:// remote", "ssh://ssh@git.cafe/team/project.git", "ssh@git.cafe:fork/project.git"],
    [
      "an HTTPS remote with a user",
      "https://alice@git.cafe/team/project.git",
      "https://git.cafe/fork/project.git",
    ],
  ] as const)("checks a fork out over the transport of %s", ([, remoteUrl, expected]) => {
    const remotes: Array<string> = [];
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            encodeJson({
              number: 7,
              title: "Change",
              state: "open",
              draft: false,
              sourceBranch: "feature",
              targetBranch: "main",
              headOid: null,
              updatedAt: null,
              sourceRepo: { owner: "fork", name: "project" },
              closedAt: null,
              mergedAt: null,
            }),
          ),
        ),
      ),
    );
    const context =
      remoteUrl === undefined
        ? undefined
        : {
            provider: {
              kind: SourceControlProviderKind.make("gitcafe"),
              name: "GitCafe",
              baseUrl: "https://git.cafe",
            },
            remoteName: "origin",
            remoteUrl,
          };
    return Effect.gen(function* () {
      const provider = yield* GitCafeSourceControlProvider.make;
      yield* provider.checkoutChangeRequest({
        cwd: "/repo",
        reference: "https://git.cafe/team/project/pulls/7",
        ...(context === undefined ? {} : { context }),
      });
      assert.deepStrictEqual(remotes, [expected]);
    }).pipe(
      Effect.provide(
        Layer.merge(GitCafeApi.layer, NoFiles).pipe(
          Layer.provideMerge(GitCafeCredentials.layer),
          Layer.provideMerge(
            TestSourceControlHost.layer({
              git: {
                ensureRemote: (input) => {
                  remotes.push(input.url);
                  return Effect.succeed("gitcafe");
                },
                listLocalBranchNames: () => Effect.succeed([]),
                fetchRemoteBranch: () => Effect.void,
                setBranchUpstream: () => Effect.void,
                switchRef: () => Effect.succeed({ refName: null }),
              },
            }),
          ),
          Layer.provide(Layer.succeed(HostProcess.Environment, { CAFE_TOKEN: "env-token" })),
          Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        ),
      ),
    );
  });

  it.effect("creates a repository over REST and waits for its admission", () => {
    const sent: Array<{ method: string; url: string; body: unknown }> = [];
    const client = HttpClient.make((request) => {
      const body =
        request.body._tag === "Uint8Array"
          ? decodeJson(new TextDecoder().decode(request.body.body))
          : undefined;
      sent.push({ method: request.method, url: request.url, body });
      const state = request.method === "POST" ? "running" : "complete";
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(encodeJson({ repoId: "repo_1", state, owner: "team", name: "project" })),
        ),
      );
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafeSourceControlProvider.make;
      const created = yield* provider
        .createRepository({ cwd: "/repo", repository: "team/project", visibility: "private" })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(yield* Fiber.join(created), {
        nameWithOwner: "team/project",
        url: "https://git.cafe/team/project",
        sshUrl: "ssh@git.cafe:team/project.git",
      });
      assert.deepStrictEqual(
        sent.map((request) => `${request.method} ${request.url}`),
        [
          "POST https://git.cafe/api/orgs/team/repos",
          "GET https://git.cafe/api/orgs/team/admissions/repo_1",
        ],
      );
      const { requestKey, ...body } = sent[0]?.body as { requestKey: string };
      assert.match(requestKey, /^[0-9a-f-]{36}$/u);
      assert.deepStrictEqual(body, {
        name: "project",
        visibility: "private",
        defaultBranch: "main",
      });
    }).pipe(Effect.provide(layerFor(client)));
  });

  it.effect("opens a pull request from a fork over REST with the body file's text", () => {
    const sent: Array<{ method: string; url: string; body: unknown }> = [];
    const client = HttpClient.make((request) => {
      const body =
        request.body._tag === "Uint8Array"
          ? decodeJson(new TextDecoder().decode(request.body.body))
          : undefined;
      sent.push({ method: request.method, url: request.url, body });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            encodeJson(
              request.method === "POST"
                ? { number: 3 }
                : { id: "repo_fork", name: "project", defaultBranch: "main" },
            ),
          ),
        ),
      );
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafeSourceControlProvider.make;
      yield* provider.createChangeRequest({
        cwd: "/repo",
        target: { repository: "team/project", refName: "main" },
        baseRefName: "main",
        headSelector: "fork:feature",
        title: "Add a thing",
        bodyFile: "/tmp/body.md",
      });
      assert.deepStrictEqual(
        sent.map((request) => `${request.method} ${request.url}`),
        [
          "GET https://git.cafe/api/repos/fork/project",
          "POST https://git.cafe/api/repos/team/project/pulls",
        ],
      );
      assert.deepStrictEqual(sent[1]?.body, {
        repo: "repo_fork",
        source: "feature",
        target: "main",
        title: "Add a thing",
        description: "Body",
      });
    }).pipe(
      Effect.provide(
        layerFor(client, {
          files: FileSystem.layerNoop({
            readFileString: (path) =>
              path === "/tmp/body.md" ? Effect.succeed("Body") : Effect.die(path),
          }),
        }),
      ),
    );
  });
});
