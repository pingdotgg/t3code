import { processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";
import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";

const { parseAuth } = AzureDevOpsSourceControlProvider.discovery;

it.effect("looks up the default branch with the selected checkout repository", () =>
  Effect.gen(function* () {
    const provider = yield* AzureDevOpsSourceControlProvider.make;
    assert.strictEqual(yield* provider.getDefaultBranch({ cwd: "/repo" }), "trunk");
  }).pipe(
    Effect.provide(
      AzureDevOpsCli.layer.pipe(
        Layer.provideMerge(
          TestSourceControlHost.layer({
            process: {
              run: (input) => {
                assert.deepStrictEqual(input.args, [
                  "repos",
                  "show",
                  "--detect",
                  "true",
                  "--repository",
                  "my repo",
                  "--only-show-errors",
                  "--output",
                  "json",
                ]);
                return Effect.succeed(
                  processOutput(
                    JSON.stringify({
                      name: "My Repo",
                      webUrl: "https://dev.azure.com/acme/project/_git/My%20Repo",
                      remoteUrl: "https://dev.azure.com/acme/project/_git/My%20Repo",
                      sshUrl: "git@ssh.dev.azure.com:v3/acme/project/My%20Repo",
                      defaultBranch: "refs/heads/trunk",
                    }),
                  ),
                );
              },
            },
            git: {
              resolvePrimaryRemoteName: () => Effect.succeed("upstream"),
              readConfigValue: (_cwd, key) => {
                assert.strictEqual(key, "remote.upstream.url");
                return Effect.succeed("git@ssh.dev.azure.com:v3/acme/project/My%20Repo");
              },
            },
          }),
        ),
      ),
    ),
  ),
);

it("reads the signed-in Azure account and says when az is signed out", () => {
  assert.deepStrictEqual(parseAuth(processOutput("azure-user@example.com\n")), {
    status: "authenticated",
    account: Option.some("azure-user@example.com"),
    host: Option.some("dev.azure.com"),
    detail: Option.none(),
  });
  assert.strictEqual(
    parseAuth(
      processOutput("", {
        stderr: "Please run 'az login' to setup account.\n",
        exitCode: ChildProcessSpawner.ExitCode(1),
      }),
    ).status,
    "unauthenticated",
  );
  assert.strictEqual(parseAuth(processOutput("\n")).status, "unknown");
});
