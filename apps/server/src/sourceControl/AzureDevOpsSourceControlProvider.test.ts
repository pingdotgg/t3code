import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { AzureDevOpsCli, type AzureDevOpsCliShape } from "./AzureDevOpsCli.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

function makeProvider(azure: Partial<AzureDevOpsCliShape>, originUrl?: string | null) {
  return AzureDevOpsSourceControlProvider.make().pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(AzureDevOpsCli)(azure),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          readConfigValue: (_cwd, key) =>
            key === "remote.origin.url"
              ? Effect.succeed(originUrl ?? "https://dev.azure.com/acme/project/_git/repo")
              : Effect.succeed(null),
        }),
      ),
    ),
  );
}

it.effect("maps Azure DevOps PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add Azure provider",
          url: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open",
          updatedAt: Option.none(),
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "azure-devops",
      number: 42,
      title: "Add Azure provider",
      url: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: false,
    });
  }),
);

it.effect("creates Azure DevOps PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput: Parameters<AzureDevOpsCliShape["createPullRequest"]>[0] | null = null;
    const provider = yield* makeProvider({
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

it.effect("uses the current Azure DevOps repository for default branch lookup", () =>
  Effect.gen(function* () {
    let repositoryInput: string | null = null;
    const provider = yield* makeProvider({
      getDefaultBranch: (input) => {
        repositoryInput = input.repository;
        return Effect.succeed("main");
      },
    });

    const defaultBranch = yield* provider.getDefaultBranch({ cwd: "/repo" });

    assert.strictEqual(defaultBranch, "main");
    assert.strictEqual(repositoryInput, "repo");
  }),
);
