import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig, layerTest as serverConfigLayerTest } from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  commitId,
  describeJj,
  runGit,
  runJj,
  withJjRepo,
  write,
  type JjRepoFixture,
} from "../vcs/testing/JjTestSupport.ts";
import * as JjWorkflow from "./JjWorkflow.ts";
import { workspaceNameForRef } from "./JjWorkspaces.ts";

const makeWorkflow = (
  repo: JjRepoFixture,
  options: {
    readonly provider?: Partial<SourceControlProvider.SourceControlProvider["Service"]>;
    readonly textGeneration?: Partial<TextGeneration.TextGeneration["Service"]>;
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
    readonly process?: VcsProcess.VcsProcess["Service"];
  } = {},
) =>
  Effect.gen(function* () {
    const providerLayer = Layer.mock(SourceControlProvider.SourceControlProvider)({
      readChangeRequestTemplate: () => Effect.succeedNone,
      kind: SourceControlProviderKind.make("github"),
      headBranchProbe: ({ headSelectors }) => ({ headSelectors, limit: 1 }),
      listChangeRequests: () => Effect.succeed([]),
      getDefaultBranch: () => Effect.succeed("main"),
      ...options.provider,
    });
    const config = yield* ServerConfig.pipe(
      Effect.provide(serverConfigLayerTest(repo.root, repo.path.join(repo.base, "config"))),
    );
    return yield* JjWorkflow.make.pipe(
      Effect.provideService(JjVcsDriver.JjVcsDriver, repo.driver),
      Effect.provideService(VcsProcess.VcsProcess, options.process ?? repo.process),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ServerConfig, config),
          NodeCrypto.layer,
          Layer.mock(GitManager.GitManager)({}),
          Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.mock(ProjectStore.ProjectStoreV2)({}),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          ServerSettings.layerTest(options.settings),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => undefined,
            resolve: () =>
              SourceControlProvider.SourceControlProvider.pipe(Effect.provide(providerLayer)),
          }),
          Layer.mock(TextGeneration.TextGeneration)(options.textGeneration ?? {}),
        ),
      ),
    );
  });

describeJj("JjWorkflow fresh workspace commit", () => {
  it.effect("generates the first commit description in a freshly created workspace", () =>
    withJjRepo({ prefix: "t3-jj-fresh-workspace-commit-", withRemote: true }, (repo) =>
      Effect.gen(function* () {
        const cwd = repo.path.join(repo.base, "fresh-workspace");
        const subject = "Describe the workspace change";
        const body = "Explain the first workspace commit.";
        let generationCalls = 0;
        const workflow = yield* makeWorkflow(repo, {
          textGeneration: {
            generateCommitMessage: (input) =>
              Effect.gen(function* () {
                generationCalls++;
                assert.equal(input.cwd, cwd);
                const change = yield* repo.driver.currentChange(cwd).pipe(Effect.orDie);
                assert.equal(change.description, "");
                return { subject, body };
              }),
          },
        });
        const created = yield* workflow.createWorktree(
          {
            cwd: repo.root,
            refName: "main",
            newRefName: "feat/generated-description",
            path: cwd,
          },
          {
            worktreesDirectory: repo.path.join(repo.base, "worktrees"),
            submodules: "none",
          },
        );
        assert.equal(created.worktree.path, cwd);
        assert.equal((yield* repo.driver.currentChange(cwd)).description, "");
        yield* repo.fileSystem.writeFileString(
          repo.path.join(cwd, "workspace-change.txt"),
          "First workspace change\n",
        );

        const result = yield* workflow.runStackedAction({
          actionId: "fresh-workspace-commit",
          cwd,
          action: "commit",
          featureBranch: false,
        });

        assert.equal(result.commit.status, "created");
        assert.equal(generationCalls, 1);
        assert.equal(
          (yield* repo.driver.changeAt(cwd, "@-"))?.description.trim(),
          `${subject}\n\n${body}`,
        );
      }),
    ),
  );
});

describeJj("JjWorkflow review context", () => {
  it.effect("creates from a secondary workspace using its configured base and project settings", () =>
    withJjRepo({ prefix: "t3-jj-pr-range-", withRemote: true }, (repo) =>
      Effect.gen(function* () {
        yield* write(repo, "shared.txt", "original\n");
        yield* runJj(repo.root, ["commit", "-m", "common"]);
        const common = yield* commitId(repo.root, "@-");
        yield* write(repo, "feature.txt", "feature\n");
        yield* runJj(repo.root, ["commit", "-m", "feature-only"]);
        yield* runJj(repo.root, ["bookmark", "create", "topic", "-r", "@-"]);
        yield* runJj(repo.root, ["git", "push", "--remote", "origin", "--bookmark", "topic"]);
        const topic = yield* commitId(repo.root, "@-");
        yield* runJj(repo.root, ["new", common]);
        yield* write(repo, "shared.txt", "base-only\n");
        yield* runJj(repo.root, ["commit", "-m", "base-only"]);
        yield* runJj(repo.root, ["bookmark", "create", "release", "-r", "@-"]);
        yield* runJj(repo.root, ["git", "push", "--remote", "origin", "--bookmark", "release"]);
        yield* runGit(repo.root, ["config", "branch.topic.gh-merge-base", "refs/heads/release"]);
        const cwd = repo.path.join(repo.base, "topic-workspace");
        yield* runJj(repo.root, [
          "workspace",
          "add",
          "--name",
          workspaceNameForRef("topic"),
          "-r",
          topic,
          cwd,
        ]);
        let generated = false;
        let bodyFile: string | undefined;
        const providerCalls: Array<{ readonly operation: string; readonly cwd: string }> = [];
        const projectId = ProjectId.make("review-project");
        const template = "## What changed?";
        const modelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "project-review-writer",
        };
        const workflow = yield* makeWorkflow(repo, {
          settings: {
            projectSettingsOverrides: {
              [projectId]: {
                textGenerationModelSelection: modelSelection,
                sourceControlWritingStyle: {
                  mode: "custom",
                  customInstructions: "Lead with the project impact.",
                  followChangeRequestTemplates: true,
                },
              },
            },
          },
          provider: {
            listChangeRequests: (input) =>
              Effect.sync(() => {
                providerCalls.push({ operation: "list", cwd: input.cwd });
                return [];
              }),
            readChangeRequestTemplate: (input) =>
              Effect.sync(() => {
                providerCalls.push({ operation: "template", cwd: input.cwd });
                return template;
              }).pipe(Effect.flatMap(Effect.succeedSome)),
            createChangeRequest: (input) =>
              Effect.gen(function* () {
                providerCalls.push({ operation: "create", cwd: input.cwd });
                bodyFile = input.bodyFile;
                assert.equal(input.baseRefName, "release");
                assert.equal(input.headSelector, "topic");
                assert.equal(input.title, "Feature review");
                const body = yield* repo.fileSystem.readFileString(input.bodyFile).pipe(Effect.orDie);
                assert.equal(body, "Feature body");
              }),
          },
          textGeneration: {
            generatePrContent: (input) =>
              Effect.sync(() => {
                generated = true;
                assert.equal(input.cwd, cwd);
                assert.equal(input.baseBranch, "release");
                assert.equal(input.changeRequestTemplate, template);
                assert.deepStrictEqual(input.modelSelection, modelSelection);
                assert.include(input.policy?.changeRequestInstructions ?? "", "project impact");
                assert.include(input.commitSummary, "feature-only");
                assert.notInclude(input.commitSummary, "base-only");
                assert.include(input.diffSummary, "feature.txt");
                assert.notInclude(input.diffSummary, "shared.txt");
                assert.include(input.diffPatch, "+feature");
                assert.notInclude(input.diffPatch, "base-only");
                return { title: "Feature review", body: "Feature body" };
              }),
          },
        });
        const result = yield* workflow.runStackedAction({
          actionId: "range-context",
          cwd,
          action: "create_pr",
          featureBranch: false,
          projectId,
        });
        assert.equal(result.pr.status, "created");
        assert.equal(result.pr.baseBranch, "release");
        assert.isTrue(generated);
        assert.deepStrictEqual(providerCalls, [
          { operation: "list", cwd: repo.root },
          { operation: "template", cwd: repo.root },
          { operation: "create", cwd: repo.root },
          { operation: "list", cwd: repo.root },
        ]);
        assert.isDefined(bodyFile);
        assert.isFalse(yield* repo.fileSystem.exists(bodyFile ?? ""));
      }),
    ),
  );
  it.effect("keeps the selected upstream PR base through workspace creation and bookmark rename", () =>
    withJjRepo({ prefix: "t3-jj-pr-renamed-base-", withRemote: true }, (repo) =>
      Effect.gen(function* () {
        const upstream = repo.path.join(repo.base, "upstream.git");
        yield* runGit(repo.root, ["init", "--bare", "--quiet", upstream]);
        yield* runGit(repo.root, ["remote", "add", "upstream", upstream]);
        yield* write(repo, "upstream-only.txt", "upstream base\n");
        yield* runJj(repo.root, ["commit", "-m", "upstream-only"]);
        yield* runJj(repo.root, ["bookmark", "create", "release", "-r", "@-"]);
        yield* runJj(repo.root, ["git", "push", "--remote", "upstream", "--bookmark", "release"]);
        yield* runGit(repo.root, [
          "update-ref",
          "refs/remotes/origin/release",
          yield* commitId(repo.root, "main"),
        ]);
        yield* runJj(repo.root, [
          "bookmark",
          "set",
          "release",
          "-r",
          "main",
          "--allow-backwards",
        ]);
        let generated = false;
        const workflow = yield* makeWorkflow(repo, {
          provider: {
            createChangeRequest: (input) =>
              Effect.sync(() => {
                assert.equal(input.baseRefName, "release");
                assert.equal(input.headSelector, "topic");
              }),
          },
          textGeneration: {
            generatePrContent: (input) =>
              Effect.sync(() => {
                generated = true;
                assert.equal(input.baseBranch, "release");
                assert.include(input.commitSummary, "feature-only");
                assert.notInclude(input.commitSummary, "upstream-only");
                assert.include(input.diffPatch, "+feature");
                assert.notInclude(input.diffPatch, "upstream base");
                assert.notInclude(input.diffSummary, "upstream-only.txt");
                return { title: "Feature", body: "Feature body" };
              }),
          },
        });
        const created = yield* workflow.createWorktree({
          cwd: repo.root,
          refName: yield* commitId(repo.root, "release@upstream"),
          newRefName: "t3code/temporary",
          baseRefName: "refs/remotes/upstream/release",
          path: repo.path.join(repo.base, "topic-workspace"),
        });
        const cwd = created.worktree.path;
        yield* workflow.renameBranch({
          cwd,
          oldBranch: "t3code/temporary",
          newBranch: "topic",
        });
        yield* repo.fileSystem.writeFileString(repo.path.join(cwd, "feature.txt"), "feature\n");
        yield* runJj(cwd, ["commit", "-m", "feature-only"]);
        yield* runJj(cwd, ["bookmark", "set", "topic", "-r", "@-"]);
        yield* runJj(cwd, ["git", "push", "--remote", "origin", "--bookmark", "topic"]);
        const result = yield* workflow.runStackedAction({
          actionId: "renamed-base",
          cwd,
          action: "create_pr",
          featureBranch: false,
        });
        assert.equal(result.pr.status, "created");
        assert.equal(result.pr.baseBranch, "release");
        assert.isTrue(generated);
      }),
    ),
  );
  it.effect("propagates a failed merge-base config read before generating or creating a PR", () =>
    withJjRepo({ prefix: "t3-jj-pr-config-failure-", withRemote: true }, (repo) =>
      Effect.gen(function* () {
        yield* write(repo, "feature.txt", "feature\n");
        yield* runJj(repo.root, ["commit", "-m", "feature-only"]);
        yield* runJj(repo.root, ["bookmark", "create", "topic", "-r", "@-"]);
        yield* runJj(repo.root, ["git", "push", "--remote", "origin", "--bookmark", "topic"]);
        const cwd = repo.path.join(repo.base, "topic-workspace");
        yield* runJj(repo.root, [
          "workspace",
          "add",
          "--name",
          workspaceNameForRef("topic"),
          "-r",
          "topic",
          cwd,
        ]);
        let failedRead = false;
        let generated = false;
        let created = false;
        const workflow = yield* makeWorkflow(repo, {
          process: {
            run: (input) => {
              if (
                input.operation === "JjWorkflow.readConfigValue" &&
                input.args.includes("branch.topic.gh-merge-base")
              ) {
                failedRead = true;
                return Effect.fail(
                  new VcsProcessTimeoutError({
                    operation: input.operation,
                    command: input.command,
                    cwd: input.cwd,
                    timeoutMs: 10_000,
                  }),
                );
              }
              return repo.process.run(input);
            },
          },
          provider: {
            createChangeRequest: () =>
              Effect.sync(() => {
                created = true;
              }),
          },
          textGeneration: {
            generatePrContent: () =>
              Effect.sync(() => {
                generated = true;
                return { title: "Unexpected", body: "Unexpected" };
              }),
          },
        });
        const failure = yield* workflow
          .runStackedAction({ actionId: "config-failure", cwd, action: "create_pr" })
          .pipe(Effect.flip);
        assert.isTrue(failedRead);
        assert.equal(failure._tag, "GitCommandError");
        assert.include(failure.message, "Colocated Git command failed");
        assert.isFalse(generated);
        assert.isFalse(created);
      }),
    ),
  );
});
