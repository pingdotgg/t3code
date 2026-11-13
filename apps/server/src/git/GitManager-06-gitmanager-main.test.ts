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
  makeDirectory,
  runGit,
  initRepo,
  createBareRemote,
  configureVisibleRemoteUrlWithLocalRewrite,
  runStackedAction,
  preparePullRequestThread,
  makeManager,
  layerGitManagerTest,
  setUpLocalCheckoutPullRequest,
} from "./GitManager-fixtures.testkit.ts";

it.layer(layerGitManagerTest)("GitManager", (it) => {
  it.effect.each(["main", "release/1.2"])(
    "generates PR content from branch changes when the remote base advances (%s)",
    (baseBranch) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["branch", "-m", baseBranch]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", baseBranch]);
        yield* runGit(remoteDir, [
          "--git-dir=.",
          "symbolic-ref",
          "HEAD",
          `refs/heads/${baseBranch}`,
        ]);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreePath = NodePath.join(yield* makeTempDir("t3code-git-worktrees-"), "feature");
        yield* driver.createWorktree({
          cwd: repoDir,
          path: worktreePath,
          refName: baseBranch,
          newRefName: "feature/remote-base",
          baseRefName: baseBranch,
        });
        NodeFS.writeFileSync(NodePath.join(worktreePath, "feature.txt"), "feature\n");
        yield* runGit(worktreePath, ["add", "feature.txt"]);
        yield* runGit(worktreePath, ["commit", "-m", "Feature commit"]);

        const peerDir = yield* makeTempDir("t3code-git-peer-");
        yield* runGit(peerDir, ["clone", remoteDir, "."]);
        yield* runGit(peerDir, ["config", "user.email", "peer@example.com"]);
        yield* runGit(peerDir, ["config", "user.name", "Peer User"]);
        NodeFS.writeFileSync(NodePath.join(peerDir, "remote.txt"), "remote\n");
        NodeFS.mkdirSync(NodePath.join(peerDir, ".github"));
        NodeFS.writeFileSync(
          NodePath.join(peerDir, ".github/pull_request_template.md"),
          "Updated main template",
        );
        yield* runGit(peerDir, ["add", "."]);
        yield* runGit(peerDir, ["commit", "-m", "Remote base commit"]);
        yield* runGit(peerDir, ["push", "origin", baseBranch]);

        NodeFS.writeFileSync(NodePath.join(peerDir, "later-main.txt"), "unrelated\n");
        yield* runGit(peerDir, ["add", "later-main.txt"]);
        yield* runGit(peerDir, ["commit", "-m", "Later main commit"]);
        yield* runGit(peerDir, ["push", "origin", baseBranch]);
        yield* runGit(worktreePath, ["fetch", "origin"]);
        yield* runGit(worktreePath, ["rebase", `origin/${baseBranch}`]);

        const preview = yield* driver.getReviewDiffPreview({ cwd: worktreePath });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        expect
          .soft(changes.files)
          .toEqual([{ path: "feature.txt", previousPath: null, additions: 1, deletions: 0 }]);
        yield* runGit(worktreePath, ["push", "-u", "origin", "feature/remote-base"]);

        const generatedInputs: TextGeneration.PrContentGenerationInput[] = [];
        const { manager, providerCalls } = yield* makeManager({
          providerScenario: {
            prListSequence: [[], []],
          },
          textGeneration: {
            generatePrContent: (input) => {
              generatedInputs.push(input);
              return Effect.succeed({ title: "Feature PR", body: "Feature body" });
            },
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: worktreePath,
          action: "create_pr",
        });

        expect(result.pr.status).toBe("created");
        expect(generatedInputs).toHaveLength(1);
        const generated = generatedInputs[0]!;
        expect.soft(generated.baseBranch).toBe(baseBranch);
        expect.soft(generated.commitSummary.trim()).toMatch(/^[a-f0-9]+ Feature commit$/);
        expect.soft(generated.diffSummary).toContain("feature.txt");
        expect.soft(generated.diffSummary).toContain("1 file changed, 1 insertion(+)");
        expect.soft(generated.diffPatch).toContain("+feature");
        expect.soft(generated.diffPatch).not.toContain("remote.txt");
        expect.soft(generated.diffPatch).not.toContain("later-main.txt");
        expect.soft(generated.diffPatch).not.toContain("pull_request_template.md");
        expect.soft(generated.changeRequestTemplate).toBe("Updated main template");
        expect(
          created(providerCalls).some(
            (call) =>
              call.baseRefName === baseBranch && call.headSelector === "feature/remote-base",
          ),
        ).toBe(true);
      }),
  );
  it.effect(
    "creates a new PR instead of reusing an unrelated fork PR with the same head branch",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/no-fork-match"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "changes.txt"), "change\n");
        yield* runGit(repoDir, ["add", "changes.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Feature commit"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "feature/no-fork-match"]);

        const { manager, providerCalls } = yield* makeManager({
          providerScenario: {
            prListSequence: [
              [
                {
                  number: 1661,
                  title: "Fork PR with same branch name",
                  url: "https://github.com/pingdotgg/t3code/pull/1661",
                  baseRefName: "main",
                  headRefName: "feature/no-fork-match",
                  state: "open",
                  isCrossRepository: true,
                  headRepositoryNameWithOwner: "lnieuwenhuis/t3code",
                  headRepositoryOwnerLogin: "lnieuwenhuis",
                },
              ],
              [
                {
                  number: 188,
                  title: "Add stacked git actions",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/188",
                  baseRefName: "main",
                  headRefName: "feature/no-fork-match",
                  state: "open",
                  isCrossRepository: false,
                },
              ],
            ],
          },
        });
        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.pr.status).toBe("created");
        expect(result.pr.number).toBe(188);
        expect(result.toast).toEqual({
          title: "Created PR #188",
          description: "Add stacked git actions",
          cta: {
            kind: "open_pr",
            label: "View PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/188",
          },
        });
        expect(
          created(providerCalls).some(
            (call) => call.baseRefName === "main" && call.headSelector === "feature/no-fork-match",
          ),
        ).toBe(true);
      }),
  );
  it.effect("creates cross-repo PRs with the fork owner selector and default base branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      // A lone remote would be treated as the base repository.
      yield* runGit(repoDir, [
        "remote",
        "add",
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
      ]);
      yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "changes.txt"), "change\n");
      yield* runGit(repoDir, ["add", "changes.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Feature commit"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
      yield* runGit(repoDir, ["checkout", "-b", "t3code/pr-91/statemachine"]);
      yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/statemachine"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "fork-seed",
        "git@github.com:octocat/codething-mvp.git",
        forkDir,
      );

      const { manager, providerCalls } = yield* makeManager({
        providerScenario: {
          prListSequenceByHeadSelector: {
            statemachine: [
              [],
              [
                {
                  number: 188,
                  title: "Add stacked git actions",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/188",
                  baseRefName: "main",
                  headRefName: "statemachine",
                  state: "open",
                  isCrossRepository: true,
                  headRepositoryNameWithOwner: "octocat/codething-mvp",
                  headRepositoryOwnerLogin: "octocat",
                },
              ],
            ],
          },
        },
      });

      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      });

      expect(result.pr.status).toBe("created");
      expect(result.pr.number).toBe(188);
      expect(
        created(providerCalls).some(
          (call) => call.baseRefName === "main" && call.headSelector === "octocat:statemachine",
        ),
      ).toBe(true);
      expect(
        created(providerCalls).some(
          (call) =>
            call.baseRefName === "statemachine" && call.headSelector === "octocat:statemachine",
        ),
      ).toBe(false);
    }),
  );
  it.effect("rejects push/pr actions from detached HEAD", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "--detach", "HEAD"]);

      const { manager } = yield* makeManager();
      const errorMessage = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );
      expect(errorMessage).toContain("detached HEAD");
    }),
  );
  it.effect.each([
    { mode: "local", repositoryType: "same repo" },
    { mode: "local", repositoryType: "fork" },
    { mode: "worktree", repositoryType: "same repo" },
    { mode: "worktree", repositoryType: "fork" },
  ] as const)(
    "checks out same-named repositories on the pull request host ($mode, $repositoryType)",
    ({ mode, repositoryType }) =>
      Effect.gen(function* () {
        const isCrossRepository = repositoryType === "fork";
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        // The checkout is on github.com, which also has a same-named repository,
        // and the pull request is on another host. Clone lookups that fall back
        // to the checkout's host find the github.com repository.
        const enterpriseRemote = yield* createBareRemote();
        const defaultHostRemote = yield* createBareRemote();
        const host = "github.enterprise.test";
        const repository = isCrossRepository ? "fork/repo" : "owner/base";
        const cloneUrl = `https://${host}/${repository}.git`;
        yield* runGit(repoDir, ["remote", "add", "origin", defaultHostRemote]);
        yield* runGit(repoDir, ["push", "origin", "main", "main:feature/host"]);
        yield* runGit(repoDir, ["push", enterpriseRemote, "main"]);
        yield* runGit(repoDir, ["checkout", "-b", "feature/host"]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "host.txt"), "enterprise head\n");
        yield* runGit(repoDir, ["add", "host.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Enterprise head"]);
        const expectedHead = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
        yield* runGit(repoDir, ["push", enterpriseRemote, "feature/host"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        if (mode === "worktree") {
          yield* runGit(repoDir, ["branch", "-D", "feature/host"]);
        }
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "origin",
          "https://github.com/owner/base.git",
          defaultHostRemote,
        );
        yield* runGit(repoDir, ["config", `url.${enterpriseRemote}.insteadOf`, cloneUrl]);
        const defaultCloneUrl = `https://github.com/${repository}.git`;
        yield* runGit(repoDir, [
          "config",
          "--add",
          `url.${defaultHostRemote}.insteadOf`,
          defaultCloneUrl,
        ]);

        const { manager } = yield* makeManager({
          providerScenario: {
            pullRequest: {
              number: 42,
              title: "Enterprise head",
              url: `https://${host}/owner/base/pull/42`,
              baseRefName: "main",
              headRefName: "feature/host",
              state: "open",
              isCrossRepository,
              headRepositoryNameWithOwner: repository,
              headRepositoryOwnerLogin: isCrossRepository ? "fork" : "owner",
            },
            repositoryCloneUrls: {
              [repository]: { url: defaultCloneUrl, sshUrl: defaultCloneUrl },
              [`${host}/${repository}`]: { url: cloneUrl, sshUrl: cloneUrl },
            },
          },
        });
        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "42",
          mode,
        });
        const checkoutDir = result.worktreePath ?? repoDir;
        const upstreamRemote = (yield* runGit(checkoutDir, [
          "config",
          `branch.${result.branch}.remote`,
        ])).stdout.trim();
        const upstreamUrl = (yield* runGit(checkoutDir, [
          "config",
          `remote.${upstreamRemote}.url`,
        ])).stdout.trim();
        const head = (yield* runGit(checkoutDir, ["rev-parse", "HEAD"])).stdout.trim();
        expect({ upstreamUrl, head }).toEqual({ upstreamUrl: cloneUrl, head: expectedHead });
        expect(NodeFS.readFileSync(NodePath.join(checkoutDir, "host.txt"), "utf8")).toBe(
          "enterprise head\n",
        );
      }),
  );
  it.effect.each([
    { mode: "local", url: "malformed pull request URL" },
    { mode: "worktree", url: "malformed pull request URL" },
    { mode: "local", url: "file:///owner/base/pull/42" },
    { mode: "worktree", url: "file:///owner/base/pull/42" },
  ] as const)(
    "checks out pull requests with hostless URLs using the default host ($mode, $url)",
    ({ mode, url }) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        const cloneUrl = "https://github.com/fork/repo.git";
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "origin", "main"]);
        yield* runGit(repoDir, ["checkout", "-b", "feature/malformed-url"]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "fork.txt"), "fork head\n");
        yield* runGit(repoDir, ["add", "fork.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Fork head"]);
        const expectedHead = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
        yield* runGit(repoDir, ["push", forkDir, "feature/malformed-url"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        if (mode === "worktree") {
          yield* runGit(repoDir, ["branch", "-D", "feature/malformed-url"]);
        }
        yield* runGit(repoDir, ["config", `url.${forkDir}.insteadOf`, cloneUrl]);

        const { manager } = yield* makeManager({
          providerScenario: {
            pullRequest: {
              number: 42,
              title: "Fork head",
              url,
              baseRefName: "main",
              headRefName: "feature/malformed-url",
              state: "open",
              isCrossRepository: true,
              headRepositoryNameWithOwner: "fork/repo",
              headRepositoryOwnerLogin: "fork",
            },
            repositoryCloneUrls: {
              "fork/repo": { url: cloneUrl, sshUrl: cloneUrl },
            },
          },
        });
        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "42",
          mode,
        });
        const checkoutDir = result.worktreePath ?? repoDir;
        const upstreamRemote = (yield* runGit(checkoutDir, [
          "config",
          `branch.${result.branch}.remote`,
        ])).stdout.trim();
        const upstreamUrl = (yield* runGit(checkoutDir, [
          "config",
          `remote.${upstreamRemote}.url`,
        ])).stdout.trim();
        const head = (yield* runGit(checkoutDir, ["rev-parse", "HEAD"])).stdout.trim();
        expect({ upstreamUrl, head }).toEqual({ upstreamUrl: cloneUrl, head: expectedHead });
        expect(NodeFS.readFileSync(NodePath.join(checkoutDir, "fork.txt"), "utf8")).toBe(
          "fork head\n",
        );
      }),
  );
  it.effect.each(["switch", "create-and-switch", "feature-branch", "commit"] as const)(
    "local PR checkout excludes a concurrent %s from a nested project with an alternate root",
    (operation) =>
      Effect.gen(function* () {
        const gate = {
          matches: (args: ReadonlyArray<string>) =>
            args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD^{commit}",
          reached: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        const { repoDir, manager, pullHead } = yield* setUpLocalCheckoutPullRequest(
          (head) => head,
          false,
          gate,
        );
        const nestedCwd = NodePath.join(repoDir, "nested-project");
        yield* makeDirectory(nestedCwd);
        const mainCommit = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();
        yield* runGit(repoDir, ["checkout", "main"]);
        const registry = yield* Layer.build(
          VcsDriverRegistry.layer.pipe(
            Layer.provide(VcsProjectConfig.layer),
            Layer.provide(VcsProcess.layer),
          ),
        );
        const handle = yield* Context.get(registry, VcsDriverRegistry.VcsDriverRegistry).resolve({
          cwd: repoDir,
        });
        const resolvedHandle = {
          ...handle,
          repository: { ...handle.repository, rootPath: `${handle.repository.rootPath}/.` },
        };
        const fileSystem = yield* FileSystem.FileSystem;
        const canonicalRoot = yield* fileSystem.realPath(resolvedHandle.repository.rootPath);
        const git = yield* GitVcsDriver.GitVcsDriver;
        const events: string[] = [];
        const workflows = yield* Effect.forEach([0, 1], () =>
          GitWorkflowService.make.pipe(
            // Cache the real filesystem result so startImmediately reaches lease acquisition.
            Effect.provideService(FileSystem.FileSystem, {
              ...fileSystem,
              realPath: (root) =>
                root === resolvedHandle.repository.rootPath
                  ? Effect.succeed(canonicalRoot)
                  : fileSystem.realPath(root),
            }),
            Effect.provideService(GitManager.GitManager, {
              ...manager,
              runStackedAction: (input, options) =>
                Effect.sync(() => {
                  events.push(input.featureBranch ? "feature-branch" : "commit");
                  NodeFS.writeFileSync(
                    NodePath.join(repoDir, "second-client.txt"),
                    "second client\n",
                  );
                }).pipe(Effect.andThen(manager.runStackedAction(input, options))),
            }),
            Effect.provideService(VcsDriverRegistry.VcsDriverRegistry, {
              ...Context.get(registry, VcsDriverRegistry.VcsDriverRegistry),
              resolve: ({ cwd }) => Effect.succeed(cwd === repoDir ? handle : resolvedHandle),
            }),
            Effect.provideService(GitVcsDriver.GitVcsDriver, {
              ...git,
              switchRef: (input) =>
                Effect.sync(() => events.push("switch")).pipe(Effect.andThen(git.switchRef(input))),
              createRef: (input) =>
                Effect.sync(() => events.push("create-and-switch")).pipe(
                  Effect.andThen(git.createRef(input)),
                ),
            }),
          ),
        );
        const preparing = yield* Effect.forkChild(
          workflows[0]!.preparePullRequestThread({ cwd: repoDir, reference: "91", mode: "local" }),
        );
        yield* Deferred.await(gate.reached);
        const switching = yield* Effect.forkChild(
          operation === "switch"
            ? workflows[1]!.switchRef({ cwd: nestedCwd, refName: "main" })
            : operation === "create-and-switch"
              ? workflows[1]!.createRef({
                  cwd: nestedCwd,
                  refName: "second-client",
                  switchRef: true,
                })
              : workflows[1]!.runStackedAction({
                  cwd: nestedCwd,
                  actionId: `second-client-${operation}`,
                  action: "commit",
                  featureBranch: operation === "feature-branch",
                  commitMessage: "Second client commit",
                }),
          { startImmediately: true },
        );
        // Both independent server workflows have started, but the second cannot touch Git yet.
        expect(events).toEqual([]);
        yield* Deferred.succeed(gate.release, undefined);
        const prepared = yield* Fiber.join(preparing);
        const switched = yield* Fiber.join(switching);
        expect(events).toEqual([operation]);
        expect(prepared).toMatchObject({ branch: "feature/pr-safe", isOnPullRequestHead: true });
        expect((yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim()).toBe(mainCommit);
        const pullBranch = operation === "commit" ? "feature/pr-safe^" : "feature/pr-safe";
        expect((yield* runGit(repoDir, ["rev-parse", pullBranch])).stdout.trim()).toBe(pullHead);
        expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe(
          operation === "switch"
            ? "main"
            : operation === "commit"
              ? "feature/pr-safe"
              : "branch" in switched
                ? switched.branch.name
                : "second-client",
        );
        if ("commit" in switched) {
          expect(switched.commit.status).toBe("created");
          expect((yield* runGit(repoDir, ["rev-parse", "HEAD^"])).stdout.trim()).toBe(pullHead);
        }
      }),
  );
  it.effect.each([false, true])(
    "local PR checkout refuses and preserves tracked edits (staged: %s)",
    (staged) =>
      Effect.gen(function* () {
        const { repoDir, manager, providerCalls, firstCommit } =
          yield* setUpLocalCheckoutPullRequest();
        NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "my unsaved edit\n");
        if (staged) {
          yield* runGit(repoDir, ["add", "README.md"]);
        }
        const beforeStatus = (yield* runGit(repoDir, ["status", "--porcelain"])).stdout;

        const error = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "91",
          mode: "local",
        }).pipe(Effect.flip);

        expect(error.message).toContain("uncommitted changes");
        expect(NodeFS.readFileSync(NodePath.join(repoDir, "README.md"), "utf8")).toBe(
          "my unsaved edit\n",
        );
        expect((yield* runGit(repoDir, ["status", "--porcelain"])).stdout).toBe(beforeStatus);
        expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(firstCommit);
        expect(providerCalls.some((call) => call.operation === "checkoutChangeRequest")).toBe(
          false,
        );
      }),
  );
  it.effect("local PR checkout refuses a diverged branch and keeps its extra commit", () =>
    Effect.gen(function* () {
      const { repoDir, manager, providerCalls } = yield* setUpLocalCheckoutPullRequest();
      NodeFS.writeFileSync(NodePath.join(repoDir, "mine.txt"), "mine\n");
      yield* runGit(repoDir, ["add", "mine.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "My unpublished commit"]);
      const localCommit = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      yield* runGit(repoDir, ["checkout", "main"]);

      const error = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "91",
        mode: "local",
      }).pipe(Effect.flip);

      // The host's fast-forward-only update fails rather than resetting the branch.
      expect(error.message).toContain("Host checkout failed");
      expect(providerCalls).toContainEqual({
        operation: "checkoutChangeRequest",
        reference: "91",
        force: false,
      });
      expect((yield* runGit(repoDir, ["rev-parse", "feature/pr-safe"])).stdout.trim()).toBe(
        localCommit,
      );
      expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(localCommit);
      expect(NodeFS.readFileSync(NodePath.join(repoDir, "mine.txt"), "utf8")).toBe("mine\n");
    }),
  );
  it.effect.each([false, true])(
    "local PR checkout lands cleanly (existing branch: %s)",
    (existing) =>
      Effect.gen(function* () {
        const { repoDir, manager, pullHead } = yield* setUpLocalCheckoutPullRequest();
        yield* runGit(repoDir, ["checkout", "main"]);
        if (!existing) {
          yield* runGit(repoDir, ["branch", "-D", "feature/pr-safe"]);
        }
        NodeFS.writeFileSync(NodePath.join(repoDir, "untracked.txt"), "keep me\n");

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "91",
          mode: "local",
        });

        expect(result).toMatchObject({
          branch: "feature/pr-safe",
          worktreePath: null,
          isOnPullRequestHead: true,
        });
        expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(pullHead);
        expect(NodeFS.readFileSync(NodePath.join(repoDir, "untracked.txt"), "utf8")).toBe(
          "keep me\n",
        );
      }),
  );
  it.effect("local PR checkout fast-forwards a branch the host's checkout only switched to", () =>
    Effect.gen(function* () {
      // Like Bitbucket or Forgejo without `force`: the existing branch is checked out as it was.
      const { repoDir, manager, firstCommit, pullHead } = yield* setUpLocalCheckoutPullRequest(
        (head) => head.slice(0, 12),
        false,
      );
      yield* runGit(repoDir, ["checkout", "main"]);
      expect((yield* runGit(repoDir, ["rev-parse", "feature/pr-safe"])).stdout.trim()).toBe(
        firstCommit,
      );

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "91",
        mode: "local",
      });

      expect(result).toMatchObject({ branch: "feature/pr-safe", isOnPullRequestHead: true });
      expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(pullHead);
    }),
  );
  it.effect(
    "local PR checkout keeps a branch that is ahead and reports it is not on the head",
    () =>
      Effect.gen(function* () {
        const { repoDir, manager, pullHead } = yield* setUpLocalCheckoutPullRequest();
        yield* runGit(repoDir, ["reset", "--hard", pullHead]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "mine.txt"), "mine\n");
        yield* runGit(repoDir, ["add", "mine.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "My unpublished commit"]);
        const localCommit = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
        yield* runGit(repoDir, ["checkout", "main"]);

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "91",
          mode: "local",
        });

        expect(result).toMatchObject({ branch: "feature/pr-safe", isOnPullRequestHead: false });
        expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(localCommit);
        expect(NodeFS.readFileSync(NodePath.join(repoDir, "mine.txt"), "utf8")).toBe("mine\n");
      }),
  );
  it.effect.each([undefined, "0".repeat(40)])(
    "local PR checkout cannot confirm an unavailable provider head (%s)",
    (reportedHead) =>
      Effect.gen(function* () {
        const { repoDir, manager, pullHead } = yield* setUpLocalCheckoutPullRequest(
          () => reportedHead,
        );
        yield* runGit(repoDir, ["checkout", "main"]);

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "91",
          mode: "local",
        });

        expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(pullHead);
        expect(result.isOnPullRequestHead).toBe(false);
      }),
  );
});
