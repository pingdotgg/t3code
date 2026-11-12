import * as NodeServices from "@effect/platform-node/NodeServices";
import { SourceControlProviderKind } from "@t3tools/contracts";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";
import { probeSourceControlProvider } from "@t3tools/source-control-core/server/discovery";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";

const { parseAuth } = AzureDevOpsSourceControlProvider.discovery;

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
  assert.strictEqual(
    parseAuth(
      processOutput(
        JSON.stringify({
          authenticatedUser: {
            id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            descriptor: "System:PublicAccess;aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            isActive: true,
            properties: { Account: { $value: "Anonymous" } },
          },
        }),
      ),
    ).status,
    "unauthenticated",
  );
});

it.effect("finds a PAT sign-in without letting one organization revoke an Azure login", () =>
  Effect.gen(function* () {
    const signedOut = processOutput("", {
      stderr: "Please run 'az login' to setup account.\n",
      exitCode: ChildProcessSpawner.ExitCode(1),
    });
    const rejected = processOutput("", {
      stderr: "TF400813: The user is not authorized to access this resource.\n",
      exitCode: ChildProcessSpawner.ExitCode(1),
    });
    const connectionData = processOutput(
      JSON.stringify({
        authenticatedUser: { id: "pat-id", properties: { Account: { $value: "pat@acme.dev" } } },
      }),
    );
    for (const [account, devops, expected] of [
      [signedOut, connectionData, "pat@acme.dev"],
      [processOutput("aad@acme.dev\n"), rejected, "aad@acme.dev"],
    ] as const) {
      const item = yield* probeSourceControlProvider({
        spec: AzureDevOpsSourceControlProvider.discovery,
        cwd: "/repo",
        process: {
          run: ({ args }) =>
            Effect.succeed(
              args[0] === "--version"
                ? processOutput("azure-cli 2.86.0\n")
                : args[0] === "account"
                  ? account
                  : devops,
            ),
        },
      });
      assert.strictEqual(item.auth.status, "authenticated");
      assert.deepStrictEqual(item.auth.account, Option.some(expected));
    }
  }),
);

it.effect("names the remote's repository when reading the default branch", () => {
  const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
    Effect.succeed(
      processOutput(
        JSON.stringify({
          name: "My Repo",
          webUrl: "https://dev.azure.com/acme/project/_git/My%20Repo",
          remoteUrl: "https://dev.azure.com/acme/project/_git/My%20Repo",
          sshUrl: "git@ssh.dev.azure.com:v3/acme/project/My%20Repo",
          defaultBranch: "refs/heads/master",
        }),
      ),
    ),
  );
  const support = Layer.mergeAll(
    TestSourceControlHost.layer({ process: { run } }),
    NodeServices.layer,
  );
  return Effect.gen(function* () {
    const provider = yield* AzureDevOpsSourceControlProvider.make;
    for (const [remoteUrl, repository] of [
      ["https://acme@dev.azure.com/acme/project/_git/My%20Repo", "My Repo"],
      ["https://dev.azure.com/acme/project/_git/My%20Repo?view=x#readme", "My Repo"],
      ["https://acme.visualstudio.com/DefaultCollection/project/_git/My%20Repo/", "My Repo"],
      ["git@ssh.dev.azure.com:v3/acme/project/My%20Repo", "My Repo"],
      ["ssh://git@ssh.dev.azure.com/v3/acme/project/My%20Repo", "My Repo"],
      ["https://dev.azure.com/acme/project/_git/service.git", "service.git"],
      ["https://dev.azure.com/acme/project/_git/-repo", "-repo"],
      ["https://dev.azure.com/acme/project/_git/%40.env", null],
    ] as const) {
      run.mockClear();
      const branch = yield* provider.getDefaultBranch({
        cwd: "/repo",
        context: {
          provider: {
            kind: SourceControlProviderKind.make("azure-devops"),
            name: "Azure DevOps",
            baseUrl: "https://dev.azure.com",
          },
          remoteName: "origin",
          remoteUrl,
        },
      });
      if (repository === null) {
        assert.strictEqual(branch, null, remoteUrl);
        assert.strictEqual(run.mock.calls.length, 0, remoteUrl);
        continue;
      }
      assert.strictEqual(branch, "master", remoteUrl);
      assert.include(
        [...(run.mock.calls[0]?.[0].args ?? [])],
        `--repository=${repository}`,
        remoteUrl,
      );
    }
  }).pipe(Effect.provide(AzureDevOpsCli.layer.pipe(Layer.provide(support))));
});

it.effect(
  "looks up a branch's pull requests a full page at a time, past forks' same-named branches",
  () =>
    Effect.gen(function* () {
      const provider = yield* AzureDevOpsSourceControlProvider.make;
      assert.deepStrictEqual(
        provider.headBranchProbe?.({
          headSelectors: ["octocat:feature", "feature"],
          state: "open",
        }),
        { headSelectors: ["feature"], limit: 100 },
      );
    }).pipe(Effect.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}))),
);
