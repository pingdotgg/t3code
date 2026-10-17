import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";

import {
  GitCommandError,
  SourceControlProviderError,
  SourceControlProviderKind,
  OrchestrationV2ThreadProjection,
  ThreadId,
  TextGenerationError,
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
} from "@t3tools/contracts";

import type {
  ChangeRequestStepServices,
  ChangeRequestVcsReads,
} from "../sourceControl/ChangeRequestStep.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as JjProcess from "../vcs/JjProcess.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import {
  describeJj,
  JjDriverLayer,
  runGit,
  runJj,
  seedJjRepo,
  stubSourceControlProviders,
} from "../vcs/testing/JjTestSupport.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { makeJjRefs } from "./JjRefs.ts";
import { makeJjRemotes } from "./JjRemotes.ts";
import { makeJjStackedAction, type JjStackedActionOps } from "./JjStackedAction.ts";
import { workspaceNameForRef } from "./JjWorkspaces.ts";

const textGeneration: TextGeneration.TextGeneration["Service"] = {
  generateCommitMessage: (input) =>
    Effect.succeed({
      subject: "Implement the change",
      body: "",
      ...(input.includeBranch ? { branch: "feature/implement-the-change" } : {}),
    }),
  generatePrContent: () =>
    Effect.fail(
      new TextGenerationError({ operation: "generatePrContent", detail: "not exercised" }),
    ),
  generateBranchName: () => Effect.succeed({ branch: "feature/implement-the-change" }),
  generateThreadTitle: () => Effect.succeed({ title: "Implement the change" }),
  generateReviewGuide: () =>
    Effect.fail(
      new TextGenerationError({ operation: "generateReviewGuide", detail: "not exercised" }),
    ),
};

const ServicesLayer = Layer.mergeAll(
  Layer.succeed(HostProcess.Environment, {}),
  Layer.succeed(TextGeneration.TextGeneration, textGeneration),
  Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  ServerSettings.layerTest(),
  Layer.effect(
    SourceControlProviderRegistry.SourceControlProviderRegistry,
    stubSourceControlProviders,
  ),
);

interface ActionFixture {
  readonly driver: JjVcsDriver.JjVcsDriverShape;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly actions: JjStackedActionOps;
  readonly createRef: (cwd: string, refName: string) => Effect.Effect<unknown, GitCommandError>;
  readonly events: Array<GitActionProgressEvent>;
  /** Every process invocation the action made, so the built argv can be asserted directly. */
  readonly runs: Array<VcsProcess.VcsProcessInput>;
  readonly root: string;
}

const runInput = (input: Partial<GitRunStackedActionInput>): GitRunStackedActionInput => ({
  actionId: "action-1",
  cwd: input.cwd ?? "",
  action: input.action ?? "commit",
  ...(input.commitMessage !== undefined ? { commitMessage: input.commitMessage } : {}),
  ...(input.featureBranch !== undefined ? { featureBranch: input.featureBranch } : {}),
  ...(input.filePaths !== undefined ? { filePaths: input.filePaths } : {}),
  ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
  ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
});

const withRepo = <A, E>(
  use: (
    fixture: ActionFixture,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChangeRequestStepServices>,
  reads?:
    | ChangeRequestVcsReads
    | ((cwd: string, executeGit: ChangeRequestVcsReads["executeGit"]) => ChangeRequestVcsReads),
) =>
  Effect.gen(function* () {
    const { root } = yield* seedJjRepo({
      prefix: "t3-jj-action-",
      withRemote: true,
    });
    yield* runJj(root, ["new", 'bookmarks(exact:"main")']);

    const driver = yield* JjVcsDriver.JjVcsDriver;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const process = yield* VcsProcess.VcsProcess;

    const events: Array<GitActionProgressEvent> = [];
    const runs: Array<VcsProcess.VcsProcessInput> = [];
    const recordingProcess: VcsProcess.VcsProcess["Service"] = {
      run: (processInput) =>
        Effect.suspend(() => {
          runs.push(processInput);
          return process.run(processInput);
        }),
    };
    // Every jj call the action makes, its bookmark moves included, goes through the recorder.
    const remotes = makeJjRemotes({ driver, process: recordingProcess });
    const refs = yield* makeJjRefs({ driver, process });

    const executeGit: Parameters<typeof makeJjStackedAction>[0]["executeGit"] = (gitInput) =>
      driver.repoPaths(gitInput.cwd).pipe(
        Effect.flatMap((paths) =>
          JjProcess.colocatedGitCommand(
            process,
            gitInput.operation,
            { gitDir: paths.gitDir ?? "", cwd: gitInput.cwd },
            gitInput.args,
            { allowNonZeroExit: true },
          ),
        ),
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: gitInput.operation,
              command: "git",
              cwd: gitInput.cwd,
              detail: "colocated git failed",
              cause,
            }),
        ),
      );

    const actions = makeJjStackedAction({
      driver,
      executeGit,
      process: recordingProcess,
      remotes,
      sourceControlProviders: yield* stubSourceControlProviders,
      changeRequestReads: (cwd) =>
        reads !== undefined
          ? Effect.succeed(typeof reads === "function" ? reads(cwd, executeGit) : reads)
          : Effect.fail(
              new GitCommandError({
                operation: "test",
                command: "jj",
                cwd,
                detail: "the pull-request phase is not exercised here",
              }),
            ),
      invalidateStatus: () => Effect.void,
    });

    return yield* use({
      driver,
      fileSystem,
      path,
      actions,
      createRef: (cwd, refName) => refs.createRef({ cwd, refName }),
      events,
      runs,
      root,
    });
  }).pipe(Effect.provide(Layer.mergeAll(JjDriverLayer, ServicesLayer)));

const reporter = (events: Array<GitActionProgressEvent>) => ({
  progressReporter: {
    publish: (event: GitActionProgressEvent) =>
      Effect.sync(() => {
        events.push(event);
      }),
  },
});

describeJj("JjStackedAction commit phase", () => {
  for (const action of ["push", "create_pr"] as const) {
    it.effect(`refuses ${action} when the selected bookmark descends from the working copy`, () =>
      withRepo(({ actions, driver, fileSystem, path, root }) =>
        Effect.gen(function* () {
          yield* fileSystem.writeFileString(path.join(root, "x1.txt"), "x1\n");
          yield* runJj(root, ["commit", "-m", "First"]);
          yield* fileSystem.writeFileString(path.join(root, "x2.txt"), "x2\n");
          yield* runJj(root, ["describe", "-m", "Second"]);
          yield* runJj(root, ["bookmark", "create", "feat", "-r", "@"]);
          if (action === "push")
            yield* runJj(root, ["git", "push", "--bookmark", "feat", "--remote", "origin"]);
          const remote = (yield* runGit(root, ["config", "--get", "remote.origin.url"])).trim();
          const before = yield* runGit(remote, [
            "for-each-ref",
            "--format=%(objectname)",
            "refs/heads/feat",
          ]);
          yield* runJj(root, ["edit", "@-"]);
          yield* fileSystem.writeFileString(path.join(root, "x1.txt"), "in-progress\n");
          const change = yield* driver.currentChange(root);
          const failure = yield* actions
            .runStackedAction(runInput({ cwd: root, action }))
            .pipe(Effect.flip);
          assert.equal(
            yield* runGit(remote, ["for-each-ref", "--format=%(objectname)", "refs/heads/feat"]),
            before,
          );
          assert.include(failure.message, "Commit this change before pushing");
          assert.equal((yield* driver.currentChange(root)).commitId, change.commitId);
          assert.equal(
            yield* fileSystem.readFileString(path.join(root, "x1.txt")),
            "in-progress\n",
          );
        }),
      ),
    );
  }

  for (const sameRow of [false, true]) {
    it.effect(
      `refuses ambiguous descendant bookmarks ${sameRow ? "on the same change" : "on separate branches"}`,
      () =>
        withRepo(({ actions, driver, fileSystem, path, root }) =>
          Effect.gen(function* () {
            yield* fileSystem.writeFileString(path.join(root, "x1.txt"), "x1\n");
            yield* runJj(root, ["describe", "-m", "First"]);
            const first = (yield* driver.currentChange(root)).commitId;
            yield* runJj(root, ["new", "-m", "Branch A"]);
            yield* runJj(root, ["bookmark", "create", "feat-a", "-r", "@"]);
            if (!sameRow) yield* runJj(root, ["new", first, "-m", "Branch B"]);
            yield* runJj(root, ["bookmark", "create", "feat-b", "-r", "@"]);
            yield* runJj(root, ["edit", first]);
            yield* fileSystem.writeFileString(path.join(root, "x1.txt"), "edited\n");
            const before = yield* driver.currentChange(root);
            const failure = yield* actions
              .runStackedAction(runInput({ cwd: root, action: "commit_push" }))
              .pipe(Effect.flip);
            assert.include(failure.message.toLowerCase(), "ambiguous");
            assert.equal((yield* driver.currentChange(root)).commitId, before.commitId);
            const remote = (yield* runGit(root, ["config", "--get", "remote.origin.url"])).trim();
            assert.equal(
              (yield* runGit(remote, [
                "for-each-ref",
                "--format=%(refname)",
                "refs/heads/feat",
              ])).trim(),
              "",
            );
          }),
        ),
    );
  }

  it.effect("preserves the descendant feature bookmark when committing and pushing mid-stack", () =>
    withRepo(({ actions, driver, fileSystem, path, root }) =>
      Effect.gen(function* () {
        const main = (yield* driver.changeAt(root, "main"))?.commitId;
        yield* fileSystem.writeFileString(path.join(root, "x1.txt"), "x1\n");
        yield* runJj(root, ["commit", "-m", "x1"]);
        yield* fileSystem.writeFileString(path.join(root, "x2.txt"), "x2\n");
        yield* runJj(root, ["describe", "-m", "x2"]);
        yield* runJj(root, ["bookmark", "create", "feat", "-r", "@"]);
        const descendant = yield* runJj(root, ["log", "--no-graph", "-r", "@", "-T", "change_id"]);
        yield* runJj(root, ["git", "push", "--bookmark", "feat", "--remote", "origin"]);
        const remote = (yield* runGit(root, ["config", "--get", "remote.origin.url"])).trim();
        assert.equal(yield* runGit(root, ["--git-dir", remote, "show", "feat:x2.txt"]), "x2\n");
        yield* runJj(root, ["edit", "@-"]);
        yield* fileSystem.writeFileString(path.join(root, "x1.txt"), "x1 edited\n");
        const result = yield* actions.runStackedAction(
          runInput({ cwd: root, action: "commit_push" }),
        );
        assert.equal(result.push.branch, "feat");
        assert.equal((yield* driver.changeAt(root, "main"))?.commitId, main);
        assert.equal(
          (yield* driver.changeAt(root, 'remote_bookmarks(exact:"main", exact:"origin")'))
            ?.commitId,
          main,
        );
        const feature = yield* driver.changeAt(root, "feat");
        assert.equal(
          yield* runJj(root, ["log", "--no-graph", "-r", "feat", "-T", "change_id"]),
          descendant,
        );
        assert.equal(
          (yield* driver.changeAt(root, 'remote_bookmarks(exact:"feat", exact:"origin")'))
            ?.commitId,
          feature?.commitId,
        );
        assert.equal(yield* runJj(root, ["file", "show", "-r", "feat", "x2.txt"]), "x2\n");
        assert.equal(yield* runJj(root, ["file", "show", "-r", "feat", "x1.txt"]), "x1 edited\n");
        assert.equal(yield* runGit(root, ["--git-dir", remote, "show", "feat:x2.txt"]), "x2\n");
        assert.equal(
          yield* runGit(root, ["--git-dir", remote, "show", "feat:x1.txt"]),
          "x1 edited\n",
        );
      }),
    ),
  );

  it.effect("keeps a prewritten description instead of generating or replacing it", () =>
    withRepo(({ actions, driver, fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "written.txt"), "written\n");
        yield* runJj(root, ["describe", "-m", "User subject\n\nUser body"]);
        const before = (yield* driver.currentChange(root)).description;
        yield* actions.runStackedAction(runInput({ cwd: root, commitMessage: "Replacement" }));
        assert.equal((yield* driver.changeAt(root, "@-"))?.description, before);
      }),
    ),
  );

  it.effect("refuses a conflicted working-copy commit without rewriting it", () =>
    withRepo(({ actions, driver, fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "conflict.txt"), "left\n");
        yield* runJj(root, ["commit", "-m", "left"]);
        const left = (yield* driver.changeAt(root, "@-"))!.commitId;
        yield* runJj(root, ["new", "main"]);
        yield* fileSystem.writeFileString(path.join(root, "conflict.txt"), "right\n");
        yield* runJj(root, ["describe", "-m", "right"]);
        const right = (yield* driver.currentChange(root)).commitId;
        yield* runJj(root, ["new", left, right]);
        const before = yield* driver.currentChange(root);
        assert.isTrue(before.conflict);
        const failure = yield* actions
          .runStackedAction(runInput({ cwd: root, commitMessage: "Do not commit" }))
          .pipe(Effect.flip);
        if (failure._tag !== "GitCommandError") throw failure;
        assert.include(failure.detail, "Resolve conflicts");
        assert.equal((yield* driver.currentChange(root)).commitId, before.commitId);
      }),
    ),
  );

  it.effect("does not generate a patch for a supplied commit message", () =>
    withRepo(({ actions, driver, events, fileSystem, path, root, runs }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "custom-message.txt"), "change\n");
        const result = yield* actions.runStackedAction(
          runInput({ cwd: root, commitMessage: "Use the supplied subject\n\nSupplied body" }),
          reporter(events),
        );
        assert.equal(result.commit.status, "created");
        assert.equal(
          (yield* driver.changeAt(root, "@-"))?.description.trim(),
          "Use the supplied subject\n\nSupplied body",
        );
        assert.isTrue(runs.some((input) => input.args.includes("--stat")));
        assert.isFalse(runs.some((input) => input.args.includes("--git")));
      }),
    ),
  );

  for (const hasBookmark of [true, false]) {
    it.effect(`never moves main in a managed workspace with bookmark=${hasBookmark}`, () =>
      withRepo(({ actions, driver, events, fileSystem, path, root }) =>
        Effect.gen(function* () {
          const name = "z-thread";
          const cwd = path.join(root, "..", "thread");
          const mainBefore = (yield* driver.changeAt(root, "main"))?.commitId;
          yield* runJj(root, [
            "workspace",
            "add",
            "--name",
            workspaceNameForRef(name),
            "-r",
            "main",
            cwd,
          ]);
          if (hasBookmark) yield* runJj(root, ["bookmark", "create", name, "-r", "main"]);
          yield* fileSystem.writeFileString(path.join(cwd, "thread.txt"), "thread\n");
          const result = yield* actions.runStackedAction(
            runInput({
              cwd,
              action: hasBookmark ? "commit_push" : "commit",
              commitMessage: "Thread work",
            }),
            reporter(events),
          );
          assert.equal(result.commit.status, "created");
          assert.equal((yield* driver.changeAt(root, "main"))?.commitId, mainBefore);
          if (hasBookmark) {
            assert.equal(result.push.branch, name);
            assert.equal(
              (yield* driver.changeAt(root, name))?.commitId,
              (yield* driver.changeAt(cwd, "@-"))?.commitId,
            );
          } else {
            const failure = yield* actions
              .runStackedAction(runInput({ cwd, action: "push" }), reporter(events))
              .pipe(Effect.flip);
            assert.equal(failure._tag, "GitCommandError");
            assert.include(failure.message, "not on a bookmark");
          }
        }),
      ),
    );
  }

  it.effect("preserves hosting failures rather than reporting a jj command failure", () => {
    const cause = new SourceControlProviderError({
      provider: SourceControlProviderKind.make("github"),
      operation: "resolve",
      cwd: "/unused",
      detail: "Authenticate with the hosting provider.",
    });
    return withRepo(
      ({ actions, events, root }) =>
        Effect.gen(function* () {
          const providers = yield* stubSourceControlProviders;
          const failure = yield* actions
            .runStackedAction(runInput({ cwd: root, action: "create_pr" }), reporter(events))
            .pipe(
              Effect.provideService(SourceControlProviderRegistry.SourceControlProviderRegistry, {
                ...providers,
                resolve: () => Effect.fail(cause),
              }),
              Effect.flip,
            );
          assert.strictEqual(failure, cause);
        }),
      {
        refName: "main",
        hasUpstream: true,
        upstreamRef: "origin/main",
        providerCwd: "/unused",
        executeGit: () => Effect.die("not exercised"),
        readRangeContext: () => Effect.die("not exercised"),
        readConfigValue: () => Effect.die("not exercised"),
        resolvePrimaryRemoteName: () => Effect.die("not exercised"),
        resolveRefName: () => Effect.die("not exercised"),
        resolveDefaultRefName: () => Effect.die("not exercised"),
        resolveRemoteTrackingCommit: () => Effect.die("not exercised"),
      },
    );
  });

  for (const featureBranch of [false, true]) {
    it.effect(`preserves text generation errors with featureBranch=${featureBranch}`, () =>
      withRepo(({ actions, events, fileSystem, path, root }) => {
        const cause = new TextGenerationError({
          operation: "generateCommitMessage",
          detail: "Generation is unavailable.",
        });
        return Effect.gen(function* () {
          yield* fileSystem.writeFileString(path.join(root, "work.txt"), "work\n");
          const failure = yield* actions
            .runStackedAction(
              runInput({ cwd: root, action: "commit", featureBranch }),
              reporter(events),
            )
            .pipe(Effect.flip);
          assert.strictEqual(failure, cause);
          const failed = events.find((event) => event.kind === "action_failed");
          assert.equal(failed?.message, cause.message);
        }).pipe(
          Effect.provideService(TextGeneration.TextGeneration, {
            ...textGeneration,
            generateCommitMessage: () => Effect.fail(cause),
          }),
        );
      }),
    );
  }

  it.effect("describes `@`, moves the bookmark to `@-`, and emits no hook events", () =>
    withRepo(({ actions, driver, events, fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "work.txt"), "work\n");

        const result = yield* actions.runStackedAction(
          runInput({ cwd: root, action: "commit" }),
          reporter(events),
        );

        assert.equal(result.commit.status, "created");
        const parent = yield* driver.changeAt(root, "@-");
        assert.include(parent?.description ?? "", "Implement the change");
        assert.include(parent?.localBookmarks ?? [], "main");
        assert.isFalse(events.some((event) => event.kind.startsWith("hook_")));
      }),
    ),
  );

  it.effect("skips an empty change with nothing committed below it", () =>
    withRepo(({ actions, events, root }) =>
      Effect.gen(function* () {
        const result = yield* actions.runStackedAction(
          runInput({ cwd: root, action: "commit" }),
          reporter(events),
        );

        assert.equal(result.commit.status, "skipped_no_changes");
      }),
    ),
  );

  it.effect("moves the bookmark when the agent already committed the work itself", () =>
    withRepo(({ actions, driver, events, fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "agent.txt"), "agent\n");
        yield* runJj(root, ["commit", "-m", "agent work"]);

        const result = yield* actions.runStackedAction(
          runInput({ cwd: root, action: "commit_push" }),
          reporter(events),
        );

        assert.equal(result.commit.status, "created");
        assert.equal(result.push.status, "pushed");
        const parent = yield* driver.changeAt(root, "@-");
        assert.include(parent?.localBookmarks ?? [], "main");
      }),
    ),
  );

  it.effect("is idempotent when the same action runs twice", () =>
    withRepo(({ actions, events, fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "work.txt"), "work\n");

        const first = yield* actions.runStackedAction(
          runInput({ cwd: root, action: "commit_push" }),
          reporter(events),
        );
        const second = yield* actions.runStackedAction(
          runInput({ cwd: root, action: "commit_push" }),
          reporter(events),
        );

        assert.equal(first.push.status, "pushed");
        assert.equal(second.commit.status, "skipped_no_changes");
        assert.equal(second.push.status, "skipped_up_to_date");
      }),
    ),
  );
});

describeJj("JjStackedAction partial commits", () => {
  it.effect("commits only the selected file when its name reads as a fileset expression", () =>
    withRepo(({ actions, driver, events, fileSystem, path, root }) =>
      Effect.gen(function* () {
        // `weird~name (1).txt` is a difference expression followed by a syntax error when jj parses
        // it as a fileset, so a bare argument commits the wrong files or fails outright.
        const selected = "weird~name (1).txt";
        yield* fileSystem.writeFileString(path.join(root, selected), "selected\n");
        yield* fileSystem.writeFileString(path.join(root, "untouched.txt"), "untouched\n");

        const result = yield* actions.runStackedAction(
          runInput({ cwd: root, action: "commit", filePaths: [selected] }),
          reporter(events),
        );

        assert.equal(result.commit.status, "created");
        const committed = yield* driver.changeAt(root, "@-");
        assert.deepStrictEqual(
          (committed?.fileStats ?? []).map((file) => file.path),
          [selected],
        );
        const working = yield* driver.currentChange(root);
        assert.deepStrictEqual(
          working.fileStats.map((file) => file.path),
          ["untouched.txt"],
        );
      }),
    ),
  );

  it.effect("passes every selected path after the argument terminator, escaped", () =>
    withRepo(({ actions, driver, events, fileSystem, path, root, runs }) =>
      Effect.gen(function* () {
        const optionShaped = "--config=ui.pager=evil";
        const quoted = 'qu"ote.txt';
        yield* fileSystem.writeFileString(path.join(root, optionShaped), "option\n");
        yield* fileSystem.writeFileString(path.join(root, quoted), "quoted\n");
        yield* fileSystem.writeFileString(path.join(root, "untouched.txt"), "untouched\n");

        yield* actions.runStackedAction(
          runInput({ cwd: root, action: "commit", filePaths: [optionShaped, quoted] }),
          reporter(events),
        );

        const committed = yield* driver.changeAt(root, "@-");
        assert.deepStrictEqual(
          (committed?.fileStats ?? []).map((file) => file.path).toSorted(),
          [optionShaped, quoted].toSorted(),
        );

        const commitArgs = runs.find((entry) => entry.args.includes("commit"))?.args ?? [];
        assert.notInclude(commitArgs, optionShaped);
        assert.include(commitArgs, `file:"${optionShaped}"`);
        assert.include(commitArgs, 'file:"qu\\"ote.txt"');
        assert.isBelow(commitArgs.indexOf("--"), commitArgs.indexOf(`file:"${optionShaped}"`));
      }),
    ),
  );
});

describeJj("JjStackedAction branch phase", () => {
  it.effect("bookmarks `@` for a commit action", () =>
    withRepo(({ actions, driver, events, fileSystem, path, root, runs }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "work.txt"), "work\n");

        const result = yield* actions.runStackedAction(
          runInput({ cwd: root, action: "commit", featureBranch: true }),
          reporter(events),
        );

        assert.equal(result.branch.status, "created");
        // The commit phase moves the bookmark to `@-` afterwards either way, so the placement is
        // only visible in the argv the branch phase built.
        const created = runs.find((run) => run.args.includes("create"));
        assert.deepStrictEqual(created?.args.slice(-2), ["-r", "@"]);
        const parent = yield* driver.changeAt(root, "@-");
        assert.include(parent?.localBookmarks ?? [], result.branch.name ?? "");
      }),
    ),
  );

  it.effect("bookmarks `@-` for a push-only action", () =>
    withRepo(({ actions, driver, events, fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "committed.txt"), "committed\n");
        yield* runJj(root, ["commit", "-m", "already committed"]);
        yield* fileSystem.writeFileString(path.join(root, "editing.txt"), "editing\n");

        const result = yield* actions.runStackedAction(
          runInput({ cwd: root, action: "push", featureBranch: true }),
          reporter(events),
        );

        assert.equal(result.branch.status, "created");
        const parent = yield* driver.changeAt(root, "@-");
        assert.include(parent?.localBookmarks ?? [], result.branch.name ?? "");
        assert.equal(result.push.status, "pushed");
      }),
    ),
  );
});

describeJj("JjStackedAction push phase", () => {
  it.effect("publishes work the agent committed and then bookmarked itself", () =>
    withRepo(({ actions, createRef, events, fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "agent.txt"), "agent\n");
        yield* runJj(root, ["commit", "-m", "agent work"]);
        yield* createRef(root, "feat/captured");

        const result = yield* actions.runStackedAction(
          runInput({ cwd: root, action: "push" }),
          reporter(events),
        );

        assert.equal(result.push.status, "pushed");
        assert.equal(result.push.branch, "feat/captured");
      }),
    ),
  );

  it.effect("refuses to publish a conflicted change", () =>
    withRepo(({ actions, driver, events, fileSystem, path, root }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(root, "conflict.txt"), "left\n");
        yield* runJj(root, ["commit", "-m", "left"]);
        const left = yield* driver.changeAt(root, "@-");
        yield* runJj(root, ["new", 'bookmarks(exact:"main")']);
        yield* fileSystem.writeFileString(path.join(root, "conflict.txt"), "right\n");
        yield* runJj(root, ["commit", "-m", "right"]);
        const right = yield* driver.changeAt(root, "@-");
        yield* runJj(root, ["new", left?.commitId ?? "", right?.commitId ?? ""]);

        const failure = yield* actions
          .runStackedAction(runInput({ cwd: root, action: "push" }), reporter(events))
          .pipe(Effect.flip);

        if (failure._tag !== "GitCommandError") throw failure;
        assert.include(
          failure.detail,
          "Resolve conflicts in this change before committing or pushing.",
        );
      }),
    ),
  );
});

describeJj("JjStackedAction pull request thread history", () => {
  for (const readFails of [false, true]) {
    it.effect(
      readFails
        ? "creates a PR without thread history after a typed projection read failure"
        : "includes projected thread history in the created PR body",
      () =>
        withRepo(
          ({ actions, fileSystem, root }) =>
            Effect.gen(function* () {
              const threadId = ThreadId.make("thread:jj-pr-history");
              const now = DateTime.makeUnsafe("2026-09-27T00:00:00.000Z");
              const history = "Preserve the user-selected remote when preparing this change.";
              const projection = yield* Schema.decodeUnknownEffect(OrchestrationV2ThreadProjection)({
                thread: {
                  createdBy: "user",
                  creationSource: "web",
                  id: threadId,
                  projectId: "project:jj-pr-history",
                  title: "JJ PR history",
                  providerInstanceId: "codex",
                  modelSelection: { instanceId: "codex", model: "gpt-5" },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: root,
                  activeProviderThreadId: null,
                  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                  archivedAt: null,
                  deletedAt: null,
                },
                runs: [],
                attempts: [],
                nodes: [],
                subagents: [],
                providerSessions: [],
                providerThreads: [],
                providerTurns: [],
                runtimeRequests: [],
                messages: [],
                plans: [],
                turnItems: [],
                checkpointScopes: [],
                checkpoints: [],
                contextHandoffs: [],
                contextTransfers: [],
                visibleTurnItems: [{
                  position: 0,
                  visibility: "local",
                  sourceThreadId: threadId,
                  sourceItemId: "item:jj-pr-history",
                  item: {
                    id: "item:jj-pr-history",
                    threadId,
                    runId: null,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 1,
                    status: "completed",
                    title: null,
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                    type: "assistant_message",
                    messageId: "message:jj-pr-history",
                    text: history,
                    streaming: false,
                  },
                }],
                updatedAt: now,
              });
              let createdBody: string | undefined;
              let projectionReads = 0;
              const provider = yield* SourceControlProvider.SourceControlProvider.pipe(
                Effect.provide(Layer.mock(SourceControlProvider.SourceControlProvider)({
                  kind: SourceControlProviderKind.make("github"),
                  headBranchProbe: ({ headSelectors }) => ({ headSelectors, limit: 1 }),
                  getDefaultBranch: () => Effect.succeed("main"),
                  listChangeRequests: () => Effect.succeed([]),
                  readChangeRequestTemplate: () => Effect.succeed(Option.none()),
                  createChangeRequest: ({ bodyFile }) =>
                    fileSystem.readFileString(bodyFile).pipe(
                      Effect.tap((body) =>
                        Effect.sync(() => {
                          createdBody = body;
                        }),
                      ),
                      Effect.orDie,
                      Effect.asVoid,
                    ),
                })),
              );
              const providers = yield* stubSourceControlProviders;
              const result = yield* actions.runStackedAction(
                runInput({ cwd: root, action: "create_pr", threadId }),
              ).pipe(
                Effect.provideService(SourceControlProviderRegistry.SourceControlProviderRegistry, {
                  ...providers,
                  resolve: () => Effect.succeed(provider),
                }),
                Effect.provideService(TextGeneration.TextGeneration, {
                  ...textGeneration,
                  generatePrContent: ({ threadContext }) => Effect.succeed({
                    title: "Preserve selected remote",
                    body: `## Summary\n${threadContext ?? "No thread history available."}`,
                  }),
                }),
                Effect.provide(Layer.mock(ProjectionStore.ProjectionStoreV2)({
                  getThreadProjection: (requestedId) => Effect.suspend(() => {
                    projectionReads += 1;
                    assert.equal(requestedId, threadId);
                    return readFails
                      ? Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId }))
                      : Effect.succeed(projection);
                  }),
                })),
              );
              assert.equal(result.pr.status, "created");
              assert.equal(projectionReads, 1);
              assert.include(
                createdBody ?? "",
                readFails ? "No thread history available." : history,
              );
            }),
          (cwd, executeGit) => ({
            refName: "feature/history",
            hasUpstream: true,
            upstreamRef: "origin/feature/history",
            providerCwd: cwd,
            executeGit,
            readRangeContext: () => Effect.succeed({
              commitSummary: "Implement remote selection",
              diffSummary: "1 file changed",
              diffPatch: "+selected remote",
            }),
            readConfigValue: () => Effect.succeed(null),
            resolvePrimaryRemoteName: () => Effect.succeed("origin"),
            resolveRefName: () => Effect.succeed("main"),
            resolveDefaultRefName: () => Effect.succeed("main"),
            resolveRemoteTrackingCommit: () => Effect.succeed({ commitSha: "main" }),
          }),
        ),
    );
  }
});
