// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { SourceControlProviderKind } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";
import type {
  ChangeRequest,
  GitActionProgressEvent,
  GitPreparePullRequestThreadInput,
  ModelSelection,
} from "@t3tools/contracts";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  SourceControlProviderError as SourceControlProviderFailure,
  TextGenerationError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  fromRunner,
  decodeJsonReply,
} from "@t3tools/provider-core/server/textGenerationOperations";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import type { SourceControlProvider } from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitManager from "./GitManager.ts";

/** A change request the fake host reports. Omitted fields read as an open, undated request. */

import {
  created,
  makeTempDir,
  runGit,
  initRepo,
  createBareRemote,
  createFakeSourceControlProvider,
  runStackedAction,
  makeManager,
  layerGitManagerTest,
} from "./GitManager-fixtures.testkit.ts";

it.layer(layerGitManagerTest)("GitManager", (it) => {
  it.effect(
    "status does not reuse a stale PR after the branch is retargeted to a different upstream",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/pr-retarget"]);

        const originRemote = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originRemote]);
        yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-retarget"]);

        const existingPr = {
          number: 214,
          title: "Sticky PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/214",
          baseRefName: "main",
          headRefName: "feature/pr-retarget",
        };
        const { manager } = yield* makeManager({
          providerScenario: {
            prListSequence: [[existingPr]],
            failWith: "The host is signed out.",
            failAfterCalls: 1,
          },
        });

        const first = yield* manager.status({ cwd: repoDir });
        expect(first.pr?.number).toBe(214);

        const forkRemote = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "fork", forkRemote]);
        yield* runGit(repoDir, ["push", "fork", "feature/pr-retarget"]);
        yield* runGit(repoDir, [
          "branch",
          "--set-upstream-to=fork/feature/pr-retarget",
          "feature/pr-retarget",
        ]);

        yield* manager.invalidateStatus(repoDir);
        const second = yield* manager.status({ cwd: repoDir });
        expect(second.pr).toBeNull();
      }),
  );
  it.effect("creates a commit when working tree is dirty", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nworld\n");
      let generatedPolicy: TextGeneration.CommitMessageGenerationInput["policy"] = undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          sourceControlWritingStyle: {
            mode: "custom" as const,
            customInstructions: "Use a direct tone.",
          },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedPolicy = input.policy;
            return Effect.succeed({ subject: "Implement stacked git actions", body: "" });
          },
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("skipped_not_requested");
      expect(generatedPolicy).toMatchObject({ commitInstructions: "Use a direct tone." });
      expect(result.toast).toMatchObject({
        description: "Implement stacked git actions",
        cta: {
          kind: "run_action",
          label: "Push",
          action: {
            kind: "push",
          },
        },
      });
      expect(result.toast.title).toMatch(/^Committed [0-9a-f]{7}$/);
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%s"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("Implement stacked git actions");
    }),
  );
  it.effect("includes CLAUDE.md for Claude writers only when it differs from AGENTS.md", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "AGENTS.md"), "Use imperative subjects.\n");
      NodeFS.copyFileSync(NodePath.join(repoDir, "AGENTS.md"), NodePath.join(repoDir, "CLAUDE.md"));
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\n");
      const commitInstructions: Array<string | undefined> = [];

      const { manager } = yield* makeManager({
        serverSettings: {
          textGenerationModelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-5",
          },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            commitInstructions.push(input.policy?.commitInstructions);
            return Effect.succeed({ subject: "Update readme", body: "" });
          },
        },
      });

      yield* runStackedAction(manager, { cwd: repoDir, action: "commit" });

      NodeFS.writeFileSync(NodePath.join(repoDir, "CLAUDE.md"), "Mention the Claude provider.\n");
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello again\n");
      yield* runStackedAction(manager, { cwd: repoDir, action: "commit" });

      expect(commitInstructions[0]).toContain("Local AGENTS.md:\nUse imperative subjects.");
      expect(commitInstructions[0]).not.toContain("Local CLAUDE.md:");
      expect(commitInstructions[1]).toContain("Local CLAUDE.md:\nMention the Claude provider.");
    }),
  );
  it.effect("keeps signature output out of recent commit subjects", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const signingKey = NodePath.join(yield* makeTempDir("t3code-git-signing-key-"), "key");
      NodeChildProcess.execFileSync("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        signingKey,
      ]);
      yield* runGit(repoDir, ["config", "gpg.format", "ssh"]);
      // A global signer such as 1Password's cannot use the fixture's generated key.
      yield* runGit(repoDir, ["config", "gpg.ssh.program", "ssh-keygen"]);
      yield* runGit(repoDir, ["config", "user.signingkey", `${signingKey}.pub`]);
      yield* runGit(repoDir, ["config", "log.showSignature", "true"]);
      yield* runGit(repoDir, ["commit", "--amend", "-S", "--no-edit"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello again\n");
      let commitInstructions: string | undefined;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) => {
            commitInstructions = input.policy?.commitInstructions;
            return Effect.succeed({ subject: "Update readme", body: "" });
          },
        },
      });

      yield* runStackedAction(manager, { cwd: repoDir, action: "commit" });

      expect(commitInstructions).toMatch(
        /Recent commit subjects from this repository:\nInitial commit$/,
      );
    }),
  );
  it.effect("falls back when the dedicated source control writer is unavailable", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nworld\n");
      const missingInstanceId = ProviderInstanceId.make("missing_writer");
      let generatedModelSelection:
        | TextGeneration.CommitMessageGenerationInput["modelSelection"]
        | undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          providerInstances: {
            [missingInstanceId]: {
              driver: ProviderDriverKind.make("missing-driver"),
              config: {},
            },
          },
          sourceControlWriterModelSelection: {
            instanceId: missingInstanceId,
            model: "missing-model",
          },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedModelSelection = input.modelSelection;
            return Effect.succeed({ subject: "Use the available writer", body: "" });
          },
        },
      });

      yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(generatedModelSelection).toEqual(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection);
    }),
  );
  it.effect("uses an explicit project's provider settings for generated commit text", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nproject\n");
      const projectId = ProjectId.make("project:git-action-settings");
      const disabledInstanceId = DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId;
      let generatedModelSelection:
        | TextGeneration.CommitMessageGenerationInput["modelSelection"]
        | undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          projectSettingsOverrides: {
            [projectId]: {
              providerInstances: { [disabledInstanceId]: { enabled: false } },
            },
          },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedModelSelection = input.modelSelection;
            return Effect.succeed({ subject: "Use the project writer", body: "" });
          },
        },
      });

      yield* manager.runStackedAction({
        actionId: "test-project-action-settings",
        cwd: repoDir,
        action: "commit",
        projectId,
      });

      expect(generatedModelSelection?.instanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    }),
  );
  it.effect("prefers a V2-native thread's project settings over an explicit project", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nproject\n");
      const projectId = ProjectId.make("project:git-settings");
      const threadId = ThreadId.make("thread:git-settings");
      const projectModel: ModelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-project-writer",
      };
      const providerInstanceId = ProviderInstanceId.make("codex");
      const createdAt = DateTime.makeUnsafe("2026-09-27T00:00:00.000Z");
      let generatedModelSelection:
        | TextGeneration.CommitMessageGenerationInput["modelSelection"]
        | undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          projectSettingsOverrides: { [projectId]: { textGenerationModelSelection: projectModel } },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedModelSelection = input.modelSelection;
            return Effect.succeed({ subject: "Use the project writer", body: "" });
          },
        },
        seed: Effect.gen(function* () {
          yield* (yield* ProjectStore.ProjectStoreV2).apply({
            sequence: 1,
            eventId: EventId.make("event:git-settings:project"),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: DateTime.formatIso(createdAt),
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId,
              title: "Git settings",
              workspaceRoot: "/elsewhere",
              defaultModelSelection: null,
              scripts: [],
              createdAt: DateTime.formatIso(createdAt),
              updatedAt: DateTime.formatIso(createdAt),
            },
          });
          yield* (yield* ProjectionStore.ProjectionStoreV2).apply({
            id: EventId.make("event:git-settings:thread"),
            type: "thread.created",
            threadId,
            providerInstanceId,
            occurredAt: createdAt,
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId,
              title: "Git settings",
              providerInstanceId,
              modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: repoDir,
              activeProviderThreadId: null,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          });
        }),
      });

      yield* manager.runStackedAction({
        actionId: "test-action-id",
        cwd: repoDir,
        action: "commit",
        threadId,
        projectId: ProjectId.make("project:other"),
      });

      expect(generatedModelSelection).toEqual(projectModel);
    }),
  );
  it.effect.each([undefined, ["README.md"]])(
    "a failed generation preserves staging changed while generating (paths: %s)",
    (filePaths) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nstaged\n");
        yield* runGit(repoDir, ["add", "README.md"]);
        NodeFS.appendFileSync(NodePath.join(repoDir, "README.md"), "unstaged\n");
        NodeFS.writeFileSync(NodePath.join(repoDir, "untracked.txt"), "untracked\n");
        const indexBefore = NodeFS.readFileSync(NodePath.join(repoDir, ".git/index"));
        const headBefore = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout;
        const gitDriver = yield* GitVcsDriver.GitVcsDriver;
        let indexDuring: Buffer | undefined;
        let indexAfterUserStage: Buffer | undefined;
        const { manager } = yield* makeManager({
          textGeneration: {
            generateCommitMessage: () =>
              Effect.gen(function* () {
                indexDuring = NodeFS.readFileSync(NodePath.join(repoDir, ".git/index"));
                yield* runGit(repoDir, ["add", "untracked.txt"]).pipe(
                  Effect.provideService(GitVcsDriver.GitVcsDriver, gitDriver),
                  Effect.orDie,
                );
                indexAfterUserStage = NodeFS.readFileSync(NodePath.join(repoDir, ".git/index"));
                return yield* new TextGenerationError({
                  operation: "generateCommitMessage",
                  detail: "Provider rejected generation",
                });
              }),
          },
        });
        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit",
          ...(filePaths ? { filePaths } : {}),
        }).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(indexDuring).toEqual(indexBefore);
        expect(NodeFS.readFileSync(NodePath.join(repoDir, ".git/index"))).toEqual(
          indexAfterUserStage,
        );
        expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout).toBe(headBefore);
        expect((yield* runGit(repoDir, ["diff"])).stdout).toContain("+unstaged");
      }),
  );
  it.effect("commits only selected files when filePaths is provided", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "a.txt"), "file a\n");
      NodeFS.writeFileSync(NodePath.join(repoDir, "b.txt"), "file b\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        filePaths: ["a.txt"],
      });

      expect(result.commit.status).toBe("created");

      const statusStdout = yield* runGit(repoDir, ["status", "--porcelain"]).pipe(
        Effect.map((r) => r.stdout),
      );
      expect(statusStdout).toContain("b.txt");
      expect(statusStdout).not.toContain("a.txt");
    }),
  );
  it.effect("creates feature branch, commits, and pushes with featureBranch option", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nfeature-branch\n");
      let generatedCount = 0;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "Implement stacked git actions",
                body: "",
                ...(input.includeBranch ? { branch: "feature/implement-stacked-git-actions" } : {}),
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
        featureBranch: true,
      });

      expect(result.branch.status).toBe("created");
      expect(result.branch.name).toBe("feature/implement-stacked-git-actions");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("pushed");
      expect(result.toast).toMatchObject({
        description: "Implement stacked git actions",
        cta: {
          kind: "run_action",
          label: "Create PR",
          action: {
            kind: "create_pr",
          },
        },
      });
      expect(result.toast.title).toMatch(
        /^Pushed [0-9a-f]{7} to origin\/feature\/implement-stacked-git-actions$/,
      );
      expect(
        yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("feature/implement-stacked-git-actions");

      const mainSha = yield* runGit(repoDir, ["rev-parse", "main"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      const mergeBase = yield* runGit(repoDir, ["merge-base", "main", "HEAD"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      expect(mergeBase).toBe(mainSha);
      expect(generatedCount).toBe(1);
    }),
  );
  it.effect.each([
    { branch: "fix/name", existingBranches: ["fix"], expected: "fix-2/name" },
    { branch: "fix/name", existingBranches: ["fix/name/child"], expected: "fix/name-2" },
  ])("commits on $expected when $branch has ref namespace collisions", (scenario) =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const mainSha = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();
      for (const branch of scenario.existingBranches) {
        yield* runGit(repoDir, ["branch", branch]);
      }
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nnamespace-collision\n");

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: () =>
            Effect.succeed({
              subject: "Fix namespace collision",
              body: "",
              branch: scenario.branch,
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        featureBranch: true,
      });

      expect(result.branch).toEqual({ status: "created", name: scenario.expected });
      expect(result.commit.status).toBe("created");
      expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe(
        scenario.expected,
      );
      expect((yield* runGit(repoDir, ["status", "--porcelain"])).stdout.trim()).toBe("");
      for (const branch of ["main", ...scenario.existingBranches]) {
        expect((yield* runGit(repoDir, ["rev-parse", branch])).stdout.trim()).toBe(mainSha);
      }
    }),
  );
  it.effect(
    "pushes and creates PR from a no-upstream branch when local commits are ahead of base",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/no-upstream-pr"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "feature.txt"), "feature\n");

        const { manager, providerCalls } = yield* makeManager({
          providerScenario: {
            prListSequence: [
              [],
              [
                {
                  number: 77,
                  title: "Add no-upstream PR flow",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/77",
                  baseRefName: "main",
                  headRefName: "feature/no-upstream-pr",
                },
              ],
            ],
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.branch.status).toBe("skipped_not_requested");
        expect(result.commit.status).toBe("created");
        expect(result.push.status).toBe("pushed");
        expect(result.push.setUpstream).toBe(true);
        expect(result.pr.status).toBe("created");
        expect(
          yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"]).pipe(
            Effect.map((result) => result.stdout.trim()),
          ),
        ).toBe("origin/feature/no-upstream-pr");
        expect(
          created(providerCalls).some(
            (call) => call.baseRefName === "main" && call.headSelector === "feature/no-upstream-pr",
          ),
        ).toBe(true);
      }),
  );
  it.effect("pushes existing commits without committing dirty worktree changes", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/push-dirty"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "push-dirty.txt"), "push dirty\n");
      yield* runGit(repoDir, ["add", "push-dirty.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Push dirty branch"]);
      NodeFS.mkdirSync(NodePath.join(repoDir, ".vercel"));
      NodeFS.writeFileSync(NodePath.join(repoDir, ".vercel", "project.json"), "{}\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "push",
      });

      expect(result.commit.status).toBe("skipped_not_requested");
      expect(result.push.status).toBe("pushed");
      expect(result.pr.status).toBe("skipped_not_requested");
      expect(
        yield* runGit(repoDir, ["status", "--porcelain"]).pipe(
          Effect.map((output) => output.stdout.trim()),
        ),
      ).toContain("?? .vercel/");
      expect(
        yield* runGit(remoteDir, [
          "--git-dir=.",
          "log",
          "-1",
          "--pretty=%s",
          "feature/push-dirty",
        ]).pipe(Effect.map((output) => output.stdout.trim())),
      ).toBe("Push dirty branch");
    }),
  );
  it.effect("hands the branch base to the host when a failed first push is retried", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "HEAD:main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/retried-push", "--track", "origin/main"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "retried.txt"), "retried\n");
      yield* runGit(repoDir, ["add", "retried.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Retried push"]);
      const rejectOnce = NodePath.join(remoteDir, "reject-once");
      NodeFS.writeFileSync(rejectOnce, "");
      NodeFS.writeFileSync(
        NodePath.join(remoteDir, "hooks", "pre-receive"),
        `#!/bin/sh\nif [ -f "${rejectOnce}" ]; then rm "${rejectOnce}"; exit 1; fi\n`,
        { mode: 0o755 },
      );

      const recorded: Array<{ branch: string; baseBranch: string }> = [];
      const { service } = createFakeSourceControlProvider();
      const { manager } = yield* makeManager({
        sourceControlProvider: {
          ...service,
          recordBranchBase: ({ branch, baseBranch }) =>
            Effect.sync(() => {
              recorded.push({ branch, baseBranch });
            }),
        },
      });
      const failed = yield* runStackedAction(manager, { cwd: repoDir, action: "push" }).pipe(
        Effect.flip,
      );
      expect(failed).toBeDefined();
      const result = yield* runStackedAction(manager, { cwd: repoDir, action: "push" });

      expect(result.push.status).toBe("pushed");
      expect(recorded).toEqual([{ branch: "feature/retried-push", baseBranch: "main" }]);
    }),
  );
});
