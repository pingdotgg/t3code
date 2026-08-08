import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";

function makeProvider(azure: Partial<AzureDevOpsCli.AzureDevOpsCli["Service"]>) {
  return AzureDevOpsSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)(azure)),
  );
}

const sshRepositoryContext = {
  provider: {
    kind: "azure-devops",
    name: "Azure DevOps",
    baseUrl: "https://dev.azure.com",
  },
  remoteName: "origin",
  remoteUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
} as const;

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

it.effect("preserves Azure DevOps fork identity in change requests", () =>
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
          isCrossRepository: true,
          headRepositoryNameWithOwner: "acme/fork-project/fork-repo",
          headRepositoryOwnerLogin: "acme",
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
      isCrossRepository: true,
      headRepositoryNameWithOwner: "acme/fork-project/fork-repo",
      headRepositoryOwnerLogin: "acme",
    });
  }),
);

it.effect("passes the SSH remote repository context to Azure CLI PR lookup", () =>
  Effect.gen(function* () {
    let getInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["getPullRequest"]>[0]
      | undefined;
    const provider = yield* makeProvider({
      getPullRequest: (input) => {
        getInput = input;
        return Effect.succeed({
          number: 42,
          title: "Azure provider",
          url: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open",
          updatedAt: Option.none(),
        });
      },
    });

    yield* provider.getChangeRequest({
      cwd: "/repo",
      context: sshRepositoryContext,
      reference: "42",
    });

    assert.deepStrictEqual(getInput?.repositoryContext, {
      organization: "acme",
      project: "project",
      repository: "repo",
    });
  }),
);

it.effect("passes the SSH remote repository context to Azure CLI PR listing", () =>
  Effect.gen(function* () {
    let listInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["listPullRequests"]>[0]
      | undefined;
    const provider = yield* makeProvider({
      listPullRequests: (input) => {
        listInput = input;
        return Effect.succeed([]);
      },
    });

    yield* provider.listChangeRequests({
      cwd: "/repo",
      context: sshRepositoryContext,
      headSelector: "feature/source-control",
      state: "open",
    });

    assert.deepStrictEqual(listInput?.repositoryContext, {
      organization: "acme",
      project: "project",
      repository: "repo",
    });
  }),
);

it.effect("passes the SSH remote repository context to Azure CLI checkout", () =>
  Effect.gen(function* () {
    let checkoutInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["checkoutPullRequest"]>[0]
      | undefined;
    const provider = yield* makeProvider({
      checkoutPullRequest: (input) => {
        checkoutInput = input;
        return Effect.void;
      },
    });

    yield* provider.checkoutChangeRequest({
      cwd: "/repo",
      context: sshRepositoryContext,
      reference: "42",
    });

    assert.deepStrictEqual(checkoutInput?.repositoryContext, {
      organization: "acme",
      project: "project",
      repository: "repo",
    });
    assert.strictEqual(checkoutInput?.remoteName, "origin");
    assert.strictEqual(checkoutInput?.remoteUrl, sshRepositoryContext.remoteUrl);
  }),
);

it.effect("adds change-request context while retaining Azure CLI causes", () =>
  Effect.gen(function* () {
    const cause = new AzureDevOpsCli.AzureDevOpsCommandFailedError({
      operation: "execute",
      command: "az",
      cwd: "/repo",
      argumentCount: 2,
      cause: new Error("raw upstream detail that should remain in the cause"),
    });
    const provider = yield* makeProvider({
      checkoutPullRequest: () => Effect.fail(cause),
    });

    const error = yield* provider
      .checkoutChangeRequest({ cwd: "/repo", reference: "#42" })
      .pipe(Effect.flip);

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        command: error.command,
        cwd: error.cwd,
        reference: error.reference,
        detail: error.detail,
      },
      {
        provider: "azure-devops",
        operation: "checkoutChangeRequest",
        command: "az",
        cwd: "/repo",
        reference: "#42",
        detail: "Azure DevOps CLI command failed.",
      },
    );
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes("raw upstream detail"), false);
  }),
);

it.effect("creates Azure DevOps PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["createPullRequest"]>[0]
      | null = null;
    const provider = yield* makeProvider({
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      context: sshRepositoryContext,
      baseRefName: "main",
      headSelector: "feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "feature/provider",
      repositoryContext: {
        organization: "acme",
        project: "project",
        repository: "repo",
      },
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

it.effect("uses Azure CLI repository detection for default branch lookup", () =>
  Effect.gen(function* () {
    let defaultBranchInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["getDefaultBranch"]>[0]
      | undefined;
    const provider = yield* makeProvider({
      getDefaultBranch: (input) => {
        defaultBranchInput = input;
        return Effect.succeed("main");
      },
    });

    const defaultBranch = yield* provider.getDefaultBranch({
      cwd: "/repo",
      context: sshRepositoryContext,
    });

    assert.strictEqual(defaultBranch, "main");
    assert.strictEqual(defaultBranchInput?.cwd, "/repo");
    assert.deepStrictEqual(defaultBranchInput?.repositoryContext, {
      organization: "acme",
      project: "project",
      repository: "repo",
    });
  }),
);
