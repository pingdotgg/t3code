import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as OriginApi from "./OriginApi.ts";
import * as OriginCredentials from "./OriginCredentials.ts";
import * as OriginSourceControlProvider from "./OriginSourceControlProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const NoFiles = FileSystem.layerNoop({});

const authAnswer = (input: { stdout?: unknown; stderr?: unknown; exitCode?: number }) => ({
  stdout: input.stdout === undefined ? "" : encodeJson(input.stdout),
  stderr: input.stderr === undefined ? "" : encodeJson(input.stderr),
  exitCode: ChildProcessSpawner.ExitCode(input.exitCode ?? 0),
});

const nativeRepo = {
  id: "repo_1",
  name: "project",
  fullName: "team/project",
  defaultBranch: "main",
  cloneUrl: "https://origin.cursor.com/git/team/project.git",
};

const mirroredRepo = {
  ...nativeRepo,
  mirror: { source: "github", sourceId: "123", status: "inbound" },
};

describe("OriginSourceControlProvider", () => {
  it("reads a signed-in account from origin auth status json", () => {
    const signedIn = OriginSourceControlProvider.parseAuth(
      authAnswer({
        stdout: {
          authenticated: true,
          tokenValid: true,
          authMethod: "login",
          account: { email: "alice@example.com", publicUserId: "user_1" },
        },
      }),
    );
    assert.strictEqual(signedIn.status, "authenticated");
    assert.deepStrictEqual(signedIn.account, Option.some("alice@example.com"));
    assert.strictEqual(
      OriginSourceControlProvider.parseAuth(
        authAnswer({ stdout: { authenticated: false, tokenValid: false }, exitCode: 1 }),
      ).status,
      "unauthenticated",
    );
  });

  it.effect("rejects pull request ops on mirrored GitHub repositories", () => {
    const urls: Array<string> = [];
    const client = HttpClient.make((request) => {
      urls.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(encodeJson(mirroredRepo))),
      );
    });
    return Effect.gen(function* () {
      const provider = yield* OriginSourceControlProvider.make;
      const error = yield* provider
        .getChangeRequest({
          cwd: "/repo",
          reference: "https://cursor.com/codebase/team/project/pull/17",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "SourceControlProviderError");
      assert.include(error.detail, "mirrored GitHub");
      assert.include(error.detail, "GitHub");
      assert.deepStrictEqual(urls, ["https://api.cursor.com/v1/origin/repos/team/project"]);
    }).pipe(
      Effect.provide(
        Layer.merge(OriginApi.layer, NoFiles).pipe(
          Layer.provideMerge(OriginCredentials.layer),
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
          Layer.provide(Layer.succeed(HostProcess.Environment, { CURSOR_AUTH_TOKEN: "env-token" })),
          Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        ),
      ),
    );
  });

  it.effect("resolves remotes with and without the /git/ path prefix", () => {
    const urls: Array<string> = [];
    const client = HttpClient.make((request) => {
      urls.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(encodeJson(nativeRepo))),
      );
    });
    const context = {
      provider: {
        kind: SourceControlProviderKind.make("origin"),
        name: "Origin",
        baseUrl: "https://origin.cursor.com",
      },
      remoteName: "origin",
      remoteUrl: "https://origin.cursor.com/git/team/project.git",
    };
    return Effect.gen(function* () {
      const provider = yield* OriginSourceControlProvider.make;
      assert.strictEqual(yield* provider.getDefaultBranch({ cwd: "/repo", context }), "main");
      assert.deepStrictEqual(
        yield* provider.getRepositoryCloneUrls({
          cwd: "/repo",
          context,
          repository: "git@origin.cursor.com:team/project.git",
        }),
        {
          nameWithOwner: "team/project",
          url: "https://origin.cursor.com/git/team/project.git",
          sshUrl: "git@origin.cursor.com:team/project.git",
        },
      );
      assert.deepStrictEqual(urls, [
        "https://api.cursor.com/v1/origin/repos/team/project",
        "https://api.cursor.com/v1/origin/repos/team/project",
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(OriginApi.layer, NoFiles).pipe(
          Layer.provideMerge(OriginCredentials.layer),
          Layer.provideMerge(TestSourceControlHost.layer()),
          Layer.provide(Layer.succeed(HostProcess.Environment, { CURSOR_AUTH_TOKEN: "env-token" })),
          Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        ),
      ),
    );
  });
});
