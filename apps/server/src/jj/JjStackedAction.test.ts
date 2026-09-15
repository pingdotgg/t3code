import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  GitCommandError,
  TextGenerationError,
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
} from "@t3tools/contracts";

import type { ChangeRequestStepServices, ChangeRequestVcsReads } from "../git/GitManager.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as JjProcess from "../vcs/JjProcess.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import {
  describeJj,
  JjDriverLayer,
  runJj,
  seedJjRepo,
  stubSourceControlProviders,
} from "../vcs/testing/JjTestSupport.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { makeJjRefs } from "./JjRefs.ts";
import { makeJjRemotes } from "./JjRemotes.ts";
import { makeJjStackedAction, type JjStackedActionOps } from "./JjStackedAction.ts";

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
};

const ServicesLayer = Layer.mergeAll(
  Layer.succeed(TextGeneration.TextGeneration, textGeneration),
  Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
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
});

const withRepo = <A, E>(
  use: (
    fixture: ActionFixture,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChangeRequestStepServices>,
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
        Effect.fail(
          new GitCommandError({
            operation: "test",
            command: "jj",
            cwd,
            detail: "the pull-request phase is not exercised here",
          }),
        ) as Effect.Effect<ChangeRequestVcsReads, GitCommandError>,
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

        assert.include(failure.detail, "Resolve conflicts in this change before pushing.");
      }),
    ),
  );
});
