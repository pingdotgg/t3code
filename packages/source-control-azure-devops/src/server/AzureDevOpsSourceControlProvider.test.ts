import { processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";
import { assert, it } from "@effect/vitest";
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
