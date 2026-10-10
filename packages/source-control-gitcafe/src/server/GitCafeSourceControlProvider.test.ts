/**
 * Pins `./GitCafeSourceControlProvider.ts`, which pass 2 creates:
 *
 * - `discovery: SourceControlCliDiscoverySpec` — kind `"gitcafe"`, executable `"cafe"`,
 *   `authArgs` ending in `["auth", "status", "--json"]` against `https://git.cafe/api`, and a
 *   `parseAuth` that reads cafe's `{ schemaVersion: 1, data: { host, username } }` answer and its
 *   `{ schemaVersion: 1, error: { code, status, message } }` failure envelope.
 * - `make: Effect<SourceControlProvider["Service"], never, GitCafeApi | SourceControlHost>` with
 *   kind `"gitcafe"`, resolving the repository and host from the checkout's remote.
 *
 * Uses `./GitCafeApi.ts` and `./GitCafeCredentials.ts` as pinned in the sibling tests.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitCafeApi from "./GitCafeApi.ts";
import * as GitCafeCredentials from "./GitCafeCredentials.ts";
import * as GitCafeSourceControlProvider from "./GitCafeSourceControlProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const authAnswer = (input: { stdout?: unknown; stderr?: unknown; exitCode?: number }) => ({
  stdout: input.stdout === undefined ? "" : encodeJson(input.stdout),
  stderr: input.stderr === undefined ? "" : encodeJson(input.stderr),
  exitCode: ChildProcessSpawner.ExitCode(input.exitCode ?? 0),
});
const failure = (code: string, status: number | null) => ({
  schemaVersion: 1,
  error: { code, status, message: `Failure ${code}` },
});

describe("GitCafeSourceControlProvider", () => {
  it("probes the cafe CLI against production", () => {
    const { discovery } = GitCafeSourceControlProvider;
    assert.strictEqual(discovery.kind, "gitcafe");
    assert.strictEqual(discovery.executable, "cafe");
    assert.deepStrictEqual(discovery.authArgs.slice(0, 2), ["--host", "https://git.cafe/api"]);
    assert.deepStrictEqual(discovery.authArgs.slice(-3), ["auth", "status", "--json"]);
  });

  it("reads a signed-in account and keeps transient failures apart from sign-out", () => {
    const { parseAuth } = GitCafeSourceControlProvider.discovery;
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
      provider: { kind: "gitcafe" as const, name: "GitCafe", baseUrl: `https://${host}` },
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
        GitCafeApi.layer.pipe(
          Layer.provide(GitCafeCredentials.layer),
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
});
