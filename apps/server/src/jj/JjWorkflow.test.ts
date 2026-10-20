import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  IsoDateTime,
  ProjectId,
  ServerSettingsError,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

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
  createJjRepo,
  describeJj,
  runGit,
  runJj,
  withJjRepo,
  type JjRepoFixture,
} from "../vcs/testing/JjTestSupport.ts";
import * as JjWorkflow from "./JjWorkflow.ts";
import { makeJjRemotes } from "./JjRemotes.ts";
import { workspaceNameForRef } from "./JjWorkspaces.ts";

const projectId = ProjectId.make("workflow-project");

const withWorkflow = <A, E>(
  setting: string | ServerSettingsError | ((base: string) => string),
  use: (
    fixture: JjRepoFixture & {
      readonly workflow: JjWorkflow.JjWorkflow["Service"];
      readonly home: string;
      readonly defaultDirectory: string;
    },
  ) => Effect.Effect<A, E>,
  options: {
    readonly settings?: Partial<typeof DEFAULT_SERVER_SETTINGS>;
    readonly provider?: Partial<SourceControlProvider.SourceControlProvider["Service"]>;
  } = {},
) =>
  withJjRepo({ prefix: "t3-jj-workflow-", seed: true }, (repo) =>
    Effect.gen(function* () {
      const home = repo.path.join(repo.base, "home");
      const defaultDirectory = repo.path.join(repo.base, "default-worktrees");
      const configuredSetting = typeof setting === "function" ? setting(repo.base) : setting;
      const config = yield* ServerConfig.pipe(
        Effect.provide(serverConfigLayerTest(repo.root, repo.path.join(repo.base, "config"))),
      );
      const workflow = yield* JjWorkflow.make.pipe(
        Effect.provideService(JjVcsDriver.JjVcsDriver, repo.driver),
        Effect.provideService(VcsProcess.VcsProcess, repo.process),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ServerConfig, { ...config, worktreesDir: defaultDirectory }),
            NodeCrypto.layer,
            Layer.mock(GitManager.GitManager)({}),
            Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
            Layer.mock(ProviderRegistry.ProviderRegistry)({}),
            Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
              resolveLink: () => undefined,
              resolve: () =>
                SourceControlProvider.SourceControlProvider.pipe(
                  Effect.provide(
                    Layer.mock(SourceControlProvider.SourceControlProvider)({
                      kind: SourceControlProviderKind.make("github"),
                      headBranchProbe: ({ headSelectors, state }) => ({
                        headSelectors,
                        limit: state === "open" ? 1 : 20,
                      }),
                      ...options.provider,
                    }),
                  ),
                ),
            }),
            Layer.mock(TextGeneration.TextGeneration)({}),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              findActiveByWorkspaceRoot: (workspaceRoot) =>
                Effect.succeed(
                  workspaceRoot === repo.root
                    ? Option.some({
                        projectId,
                        title: "Project",
                        workspaceRoot,
                        defaultModelSelection: null,
                        defaultThreadEnvMode: null,
                        autoPull: false,
                        faviconPath: null,
                        projectIcon: null,
                        scripts: [],
                        createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
                        updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
                        deletedAt: null,
                      })
                    : Option.none(),
                ),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings:
                typeof configuredSetting === "string"
                  ? Effect.succeed({
                      ...DEFAULT_SERVER_SETTINGS,
                      worktreesDirectory: configuredSetting,
                      ...options.settings,
                    })
                  : Effect.fail(configuredSetting),
            }),
          ),
        ),
      );
      return yield* use({ ...repo, workflow, home, defaultDirectory });
    }),
  );

const createInput = (root: string) => ({
  cwd: root,
  refName: "main",
  newRefName: "feat/settings",
  path: null,
});

describeJj("JjWorkflow status cache invalidation", () => {
  it.effect("retains repository metadata and ref snapshots across status polls", () =>
    withWorkflow("", ({ workflow, root, driver }) => {
      const listBookmarks = vi.spyOn(driver, "listBookmarks");
      const invalidateRepoCaches = vi.spyOn(driver, "invalidateRepoCaches");

      return Effect.gen(function* () {
        yield* workflow.listRefs({ cwd: root });
        const snapshotReads = listBookmarks.mock.calls.length;
        assert.isAbove(snapshotReads, 0);

        for (let poll = 0; poll < 2; poll++) {
          yield* workflow.invalidateLocalStatus(root);
          yield* workflow.invalidateRemoteStatus(root);
          yield* workflow.listRefs({ cwd: root });
        }

        assert.equal(listBookmarks.mock.calls.length, snapshotReads);
        assert.equal(invalidateRepoCaches.mock.calls.length, 0);

        yield* workflow.invalidateStatus(root);
        yield* workflow.listRefs({ cwd: root });

        assert.equal(listBookmarks.mock.calls.length, snapshotReads + 1);
        assert.equal(invalidateRepoCaches.mock.calls.length, 1);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            listBookmarks.mockRestore();
            invalidateRepoCaches.mockRestore();
          }),
        ),
      );
    }),
  );

  it.effect("drops a cached ref snapshot when the repository markers are replaced", () =>
    withWorkflow("", ({ workflow, root, base, fileSystem, path }) =>
      Effect.gen(function* () {
        const before = yield* workflow.listRefs({ cwd: root });
        assert.isAbove(before.refs.length, 0);

        yield* fileSystem.rename(path.join(root, ".jj"), path.join(base, "old-jj"));
        yield* fileSystem.rename(path.join(root, ".git"), path.join(base, "old-git"));
        yield* createJjRepo(root);

        const after = yield* workflow.listRefs({ cwd: root });
        assert.deepEqual(after.refs, []);
      }),
    ),
  );

  it.effect("invalidates cached default metadata and refs after a bookmark mutation", () =>
    withWorkflow("", ({ workflow, root, driver }) =>
      Effect.gen(function* () {
        assert.equal(yield* driver.resolveDefaultBookmark(root), "main");
        yield* workflow.listRefs({ cwd: root });

        yield* workflow.renameBranch({
          cwd: root,
          oldBranch: "main",
          newBranch: "renamed",
          exactName: true,
        });

        assert.notEqual(yield* driver.resolveDefaultBookmark(root), "main");
        const refs = yield* workflow.listRefs({ cwd: root });
        assert.isFalse(refs.refs.some((ref) => ref.name === "main"));
        assert.isTrue(refs.refs.some((ref) => ref.name === "renamed"));
      }),
    ),
  );

  it.effect("refreshes cached refs after a direct remote bookmark mutation", () =>
    withWorkflow("", ({ workflow, root, driver, process }) =>
      Effect.gen(function* () {
        yield* workflow.listRefs({ cwd: root });
        yield* makeJjRemotes({ driver, process }).bookmarkTo({
          cwd: root,
          name: "remote-created",
          revset: "@-",
          operation: "test",
        });
        const refs = yield* workflow.listRefs({ cwd: root });
        assert.isTrue(refs.refs.some((ref) => ref.name === "remote-created"));
      }),
    ),
  );
});

describeJj("JjWorkflow worktree directory settings", () => {
  it.effect("uses the options directory instead of the server setting", () =>
    withWorkflow("~/settings-worktrees", ({ workflow, root, base }) =>
      Effect.gen(function* () {
        const directory = `${base}/options-worktrees`;
        const created = yield* workflow.createWorktree(createInput(root), {
          worktreesDirectory: directory,
        });
        assert.equal(created.worktree.path, `${directory}/project/feat-settings`);
      }),
    ),
  );

  it.effect("uses the configured absolute directory", () =>
    withWorkflow(
      (base) => `${base}/custom-worktrees`,
      ({ workflow, root, base }) =>
        Effect.gen(function* () {
          const created = yield* workflow.createWorktree(createInput(root));
          assert.equal(created.worktree.path, `${base}/custom-worktrees/project/feat-settings`);
        }),
    ),
  );

  it.effect("expands the home directory from server settings", () =>
    withWorkflow("~/worktrees", ({ workflow, root, home }) =>
      Effect.gen(function* () {
        const created = yield* workflow.createWorktree(createInput(root));
        assert.equal(created.worktree.path, `${home}/worktrees/project/feat-settings`);
      }),
    ),
  );

  for (const setting of ["relative/worktrees", "/", "C:\\"]) {
    it.effect(`rejects invalid configured directory ${setting}`, () =>
      withWorkflow(setting, ({ workflow, root }) =>
        Effect.gen(function* () {
          const error = yield* workflow.createWorktree(createInput(root)).pipe(Effect.flip);
          assert.include(
            error.detail,
            "must be an absolute folder on this machine, not a drive root",
          );
        }),
      ),
    );
  }

  it.effect("allows an explicit workspace path despite invalid directory settings", () =>
    withWorkflow("relative/worktrees", ({ workflow, root }) =>
      Effect.gen(function* () {
        const destination = `${root}/explicit-workspace`;
        const created = yield* workflow.createWorktree({ ...createInput(root), path: destination });
        assert.equal(created.worktree.path, destination);
      }),
    ),
  );

  for (const setting of [
    "",
    new ServerSettingsError({
      settingsPath: "<test>",
      operation: "read-file",
      cause: new Error("settings unavailable"),
    }),
  ]) {
    it.effect(
      `falls back to the configured default when settings are ${typeof setting === "string" ? "empty" : "unavailable"}`,
      () =>
        withWorkflow(setting, ({ workflow, root, defaultDirectory }) =>
          Effect.gen(function* () {
            const created = yield* workflow.createWorktree(createInput(root));
            assert.equal(created.worktree.path, `${defaultDirectory}/project/feat-settings`);
          }),
        ),
    );
  }
});

describeJj("JjWorkflow worktree submodule settings", () => {
  for (const projectOverride of [false, true]) {
    it.effect(
      `disables submodules using the ${projectOverride ? "project override" : "default setting"} and retains progress callbacks`,
      () =>
        withWorkflow(
          "",
          ({ workflow, root, fileSystem }) =>
            Effect.gen(function* () {
              yield* fileSystem.writeFileString(`${root}/.gitmodules`, "");
              yield* fileSystem.writeFileString(
                `${root}/t3.json`,
                '{"worktreeSubmodules":"recursive"}\n',
              );
              yield* runJj(root, ["commit", "-m", "Submodule policy"]);
              yield* runJj(root, ["bookmark", "set", "main", "-r", "@-"]);
              const events: string[] = [];
              const created = yield* workflow.createWorktree(createInput(root), {
                progress: {
                  onWorktreeClaimed: (path) =>
                    Effect.sync(() => {
                      events.push(`claimed:${path}`);
                    }),
                  onSubmodulesDisabled: ({ source }) =>
                    Effect.sync(() => {
                      events.push(`disabled:${source}`);
                    }),
                  onSubmodulesStarted: () =>
                    Effect.sync(() => {
                      events.push("started");
                    }),
                },
              });
              assert.deepStrictEqual(events, [
                `claimed:${created.worktree.path}`,
                "disabled:settings",
              ]);
              assert.isTrue(yield* fileSystem.exists(`${created.worktree.path}/.gitmodules`));
            }),
          {
            settings: {
              worktreeSubmodules: projectOverride ? "recursive" : "none",
              projectSettingsOverrides: projectOverride
                ? { [projectId]: { worktreeSubmodules: "none" } }
                : {},
            },
          },
        ),
    );
  }

  it.effect("lets explicit submodule options override settings without losing progress", () =>
    withWorkflow(
      "",
      ({ workflow, root, fileSystem }) =>
        Effect.gen(function* () {
          yield* fileSystem.writeFileString(`${root}/.gitmodules`, "");
          yield* runJj(root, ["commit", "-m", "Submodule metadata"]);
          yield* runJj(root, ["bookmark", "set", "main", "-r", "@-"]);
          const events: string[] = [];
          const created = yield* workflow.createWorktree(createInput(root), {
            submodules: "recursive",
            progress: {
              onWorktreeClaimed: (path) =>
                Effect.sync(() => {
                  events.push(`claimed:${path}`);
                }),
              onSubmodulesStarted: () =>
                Effect.sync(() => {
                  events.push("started");
                }),
              onSubmodulesFinished: ({ ok }) =>
                Effect.sync(() => {
                  events.push(`finished:${ok}`);
                }),
              onSubmodulesDisabled: () =>
                Effect.sync(() => {
                  events.push("disabled");
                }),
            },
          });
          assert.deepStrictEqual(events, [
            `claimed:${created.worktree.path}`,
            "started",
            "finished:true",
          ]);
        }),
      { settings: { worktreeSubmodules: "none" } },
    ),
  );
});

describeJj("JjWorkflow change-request identity", () => {
  it.effect("finds an imported alias PR without source bookmarks or an available fork", () => {
    const probes: Array<{ readonly cwd: string; readonly headSelector: string }> = [];
    return withWorkflow(
      "",
      ({ workflow, root, base, driver, fileSystem }) =>
        Effect.gen(function* () {
          const alias = "z-imported-pr";
          yield* runJj(root, ["bookmark", "create", "aaa-unrelated", "-r", "main"]);
          yield* runJj(root, [
            "git",
            "remote",
            "add",
            "origin",
            "https://github.com/upstream/repo.git",
          ]);
          const fork = `${base}/fork.git`;
          yield* runGit(root, ["init", "--bare", fork]);
          yield* runGit(root, ["push", fork, "refs/heads/main:refs/heads/topic"]);
          yield* runJj(root, ["git", "remote", "add", "contributor", fork]);
          yield* runGit(root, [
            "fetch",
            "--refmap=",
            "contributor",
            `refs/heads/topic:refs/heads/${alias}`,
          ]);
          yield* runJj(root, ["git", "import"]);
          yield* fileSystem.remove(fork, { recursive: true });
          yield* runGit(root, [
            "config",
            "remote.contributor.url",
            "https://github.com/contributor/repo.git",
          ]);
          yield* runGit(root, ["config", `branch.${alias}.remote`, "contributor"]);
          yield* runGit(root, ["config", `branch.${alias}.merge`, "refs/heads/topic"]);
          yield* runGit(root, ["config", `branch.${alias}.t3code-imported-pr-head`, "true"]);
          assert.isFalse(
            (yield* driver.listBookmarks(root)).some(
              (bookmark) => bookmark.name === alias && bookmark.remote === "origin",
            ),
          );
          assert.isFalse(
            (yield* driver.listBookmarks(root)).some(
              (bookmark) => bookmark.name === "topic" && bookmark.remote === "contributor",
            ),
          );
          const cwd = `${base}/imported-workspace`;
          yield* runJj(root, [
            "workspace",
            "add",
            "--name",
            workspaceNameForRef(alias),
            "-r",
            "main",
            cwd,
          ]);
          const result = yield* workflow.runStackedAction({
            actionId: "imported-pr",
            cwd,
            action: "create_pr",
          });
          assert.equal(result.push.status, "skipped_not_requested");
          assert.equal(result.pr.status, "opened_existing");
          if (result.pr.status !== "opened_existing") {
            throw new Error(`Expected existing imported PR, got ${result.pr.status}`);
          }
          assert.equal(result.pr.headBranch, "topic");
          assert.equal(result.pr.number, 42);
          assert.deepStrictEqual(probes, [{ cwd: root, headSelector: "contributor:topic" }]);
          const rejectedPush = yield* workflow
            .runStackedAction({ actionId: "imported-push", cwd, action: "push" })
            .pipe(Effect.flip);
          assert.include(rejectedPush.message, "source repository");
        }),
      {
        provider: {
          listChangeRequests: (input) =>
            Effect.sync(() => {
              probes.push({ cwd: input.cwd, headSelector: input.headSelector });
              return [
                {
                  provider: SourceControlProviderKind.make("github"),
                  state: "open" as const,
                  number: 42,
                  title: "Fork change",
                  url: "https://github.com/upstream/repo/pull/42",
                  baseRefName: "main",
                  headRefName: "topic",
                  isCrossRepository: true,
                  headRepositoryNameWithOwner: "contributor/repo",
                  headRepositoryOwnerLogin: "contributor",
                  updatedAt: Option.none(),
                },
              ];
            }),
        },
      },
    );
  });

  it.effect(
    "refuses an imported PR shortcut when local commits are ahead of its available source",
    () =>
      withWorkflow("", ({ workflow, root, base, fileSystem }) =>
        Effect.gen(function* () {
          const alias = "z-imported-pr";
          const fork = `${base}/fork.git`;
          yield* runGit(root, ["init", "--bare", fork]);
          yield* runGit(root, ["push", fork, "refs/heads/main:refs/heads/topic"]);
          yield* runJj(root, [
            "git",
            "remote",
            "add",
            "origin",
            "https://github.com/upstream/repo.git",
          ]);
          yield* runJj(root, ["git", "remote", "add", "contributor", fork]);
          yield* runJj(root, ["git", "fetch", "--remote", "contributor"]);
          yield* runJj(root, ["bookmark", "create", alias, "-r", "main"]);
          yield* runGit(root, ["config", `branch.${alias}.remote`, "contributor"]);
          yield* runGit(root, ["config", `branch.${alias}.merge`, "refs/heads/topic"]);
          yield* runGit(root, ["config", `branch.${alias}.t3code-imported-pr-head`, "true"]);
          const cwd = `${base}/imported-workspace`;
          yield* runJj(root, [
            "workspace",
            "add",
            "--name",
            workspaceNameForRef(alias),
            "-r",
            "main",
            cwd,
          ]);
          yield* fileSystem.writeFileString(`${cwd}/local.txt`, "unpublished change\n");
          yield* runJj(cwd, ["commit", "-m", "Unpublished local change"]);
          yield* runJj(cwd, ["bookmark", "set", alias, "-r", "@-"]);
          const failure = yield* workflow
            .runStackedAction({ actionId: "ahead-imported-pr", cwd, action: "create_pr" })
            .pipe(Effect.flip);
          assert.include(failure.message, "source repository");
        }),
      ),
  );
});
