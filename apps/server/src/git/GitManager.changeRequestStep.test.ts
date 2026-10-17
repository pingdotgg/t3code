import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  GitCommandError,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  TextGenerationError,
} from "@t3tools/contracts";
import { ChildProcessSpawner } from "effect/process";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  runChangeRequestStep,
  resolveTextGenerationSettings,
  resolveBranchHeadContext,
  type ChangeRequestVcsReads,
  type SourceControlTextGenerationSettings,
} from "./GitManager.ts";

const settings: SourceControlTextGenerationSettings = {
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
  style: {
    mode: "conventional_commits",
    customInstructions: "",
    followChangeRequestTemplates: false,
  },
};

const textGeneration: TextGeneration.TextGeneration["Service"] = {
  generateCommitMessage: () =>
    Effect.fail(
      new TextGenerationError({ operation: "generateCommitMessage", detail: "not exercised" }),
    ),
  generatePrContent: () => Effect.succeed({ title: "Add the thing", body: "Body" }),
  generateBranchName: () => Effect.succeed({ branch: "feature/add-the-thing" }),
  generateThreadTitle: () => Effect.succeed({ title: "Add the thing" }),
  generateReviewGuide: () =>
    Effect.fail(
      new TextGenerationError({ operation: "generateReviewGuide", detail: "not exercised" }),
    ),
};

const emptyProcessOutput: GitVcsDriver.ExecuteGitResult = {
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

function makeLayer(
  created: Array<{ readonly baseRefName: string; readonly cwd: string }>,
  providerOverrides: Partial<SourceControlProvider.SourceControlProvider["Service"]> = {},
  generationOverrides: Partial<TextGeneration.TextGeneration["Service"]> = {},
) {
  const providerLayer = Layer.mock(SourceControlProvider.SourceControlProvider)({
    kind: SourceControlProviderKind.make("github"),
    headBranchProbe: ({ headSelectors, state }) => ({
      headSelectors,
      limit: state === "open" ? 1 : 20,
    }),
    readChangeRequestTemplate: () => Effect.succeed(Option.none()),
    listChangeRequests: () => Effect.succeed([]),
    getDefaultBranch: () => Effect.succeed("main"),
    createChangeRequest: (input) =>
      Effect.sync(() => {
        created.push({ baseRefName: input.baseRefName, cwd: input.cwd });
      }),
    ...providerOverrides,
  });

  return Layer.mergeAll(
    Layer.succeed(TextGeneration.TextGeneration, { ...textGeneration, ...generationOverrides }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ServerSettings.layerTest(),
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => undefined,
      resolve: () =>
        SourceControlProvider.SourceControlProvider.pipe(Effect.provide(providerLayer)),
      get: () => SourceControlProvider.SourceControlProvider.pipe(Effect.provide(providerLayer)),
    }),
    NodeServices.layer,
  );
}

/** Shared-step fixture; callers choose the repository directory used by the hosting CLI. */
function readsFor(providerCwd: string): ChangeRequestVcsReads {
  return {
    refName: "feat/thing",
    hasUpstream: true,
    upstreamRef: "origin/feat/thing",
    readRangeContext: () =>
      Effect.succeed({ commitSummary: "abc feat", diffSummary: "1 file", diffPatch: "diff" }),
    executeGit: () => Effect.succeed(emptyProcessOutput),
    providerCwd,
    readConfigValue: (_cwd, key) =>
      Effect.succeed(key === "branch.feat/thing.gh-merge-base" ? "release/v2" : null),
    resolvePrimaryRemoteName: () => Effect.succeed("origin"),
    resolveRefName: (_cwd, refName) => Effect.succeed(refName),
    resolveDefaultRefName: () => Effect.succeed("main"),
    resolveRemoteTrackingCommit: () => Effect.succeed({ commitSha: "deadbeef" }),
  };
}

it.effect(
  "uses the recorded base and hosting workspace for repository and worktree callers",
  () => {
    const created: Array<{ readonly baseRefName: string; readonly cwd: string }> = [];

    return Effect.gen(function* () {
      const git = yield* runChangeRequestStep({
        settings,
        cwd: "/repo",
        fallbackRefName: null,
        tempDir: process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp",
        emit: () => Effect.void,
        reads: readsFor("/repo"),
      });

      const jj = yield* runChangeRequestStep({
        settings,
        cwd: "/repo/worktrees/thread",
        fallbackRefName: null,
        tempDir: process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp",
        emit: () => Effect.void,
        reads: readsFor("/repo"),
      });

      assert.equal(git.status, "created");
      assert.equal(jj.status, "created");
      assert.deepStrictEqual(
        created.map((entry) => entry.baseRefName),
        ["release/v2", "release/v2"],
      );
      // A worktree caller still runs the hosting CLI in the main workspace root.
      assert.deepStrictEqual(
        created.map((entry) => entry.cwd),
        ["/repo", "/repo"],
      );
    }).pipe(Effect.provide(makeLayer(created)));
  },
);

it.effect("uses the supplied temp directory and removes the PR body after creation", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pr-body-" });
    let bodyFile: string | undefined;
    yield* runChangeRequestStep({
      settings,
      cwd: "/repo",
      fallbackRefName: null,
      tempDir: directory,
      emit: () => Effect.void,
      reads: readsFor("/repo"),
    }).pipe(
      Effect.provide(
        makeLayer([], {
          createChangeRequest: (input) =>
            Effect.gen(function* () {
              bodyFile = input.bodyFile;
              assert.equal(path.dirname(input.bodyFile), directory);
              assert.equal(
                yield* fileSystem.readFileString(input.bodyFile).pipe(Effect.orDie),
                "Body",
              );
            }),
        }),
      ),
    );
    assert.isDefined(bodyFile);
    assert.equal(yield* fileSystem.exists(bodyFile!), false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses to open a change request for a ref that was never pushed", () => {
  const created: Array<{ readonly baseRefName: string; readonly cwd: string }> = [];

  return Effect.gen(function* () {
    const failure = yield* runChangeRequestStep({
      settings,
      cwd: "/repo",
      fallbackRefName: null,
      tempDir: process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp",
      emit: () => Effect.void,
      reads: { ...readsFor("/repo"), hasUpstream: false },
    }).pipe(Effect.flip);

    assert.include(
      failure.message,
      "Current branch has not been pushed. Push before creating a PR.",
    );
    assert.equal(created.length, 0);
  }).pipe(Effect.provide(makeLayer(created)));
});

it.effect("propagates a failed recorded-base config read without creating a change request", () => {
  const created: Array<{ readonly baseRefName: string; readonly cwd: string }> = [];
  const error = new GitCommandError({
    operation: "readConfigValue",
    command: "git config --get branch.feat/thing.gh-merge-base",
    cwd: "/repo",
    detail: "Git config timed out.",
  });

  return Effect.gen(function* () {
    const failure = yield* runChangeRequestStep({
      settings,
      cwd: "/repo",
      fallbackRefName: null,
      tempDir: process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp",
      emit: () => Effect.void,
      reads: { ...readsFor("/repo"), readConfigValue: () => Effect.fail(error) },
    }).pipe(Effect.flip);

    assert.strictEqual(failure, error);
    assert.equal(created.length, 0);
  }).pipe(Effect.provide(makeLayer(created)));
});

it.effect("falls back to the default branch when no base config is set", () => {
  const created: Array<{ readonly baseRefName: string; readonly cwd: string }> = [];

  return Effect.gen(function* () {
    yield* runChangeRequestStep({
      settings,
      cwd: "/repo",
      fallbackRefName: null,
      tempDir: process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp",
      emit: () => Effect.void,
      reads: { ...readsFor("/repo"), readConfigValue: () => Effect.succeed(null) },
    });
    assert.deepStrictEqual(
      created.map((entry) => entry.baseRefName),
      ["main"],
    );
  }).pipe(Effect.provide(makeLayer(created)));
});

it.effect("ignores a recorded base ref that no longer resolves", () => {
  const created: Array<{ readonly baseRefName: string; readonly cwd: string }> = [];

  return Effect.gen(function* () {
    yield* runChangeRequestStep({
      settings,
      cwd: "/repo",
      fallbackRefName: null,
      tempDir: process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp",
      emit: () => Effect.void,
      reads: { ...readsFor("/repo"), resolveRefName: () => Effect.succeed(null) },
    });
    assert.deepStrictEqual(
      created.map((entry) => entry.baseRefName),
      ["main"],
    );
  }).pipe(Effect.provide(makeLayer(created)));
});

it.effect("uses the resolved name of a recorded base ref", () => {
  const created: Array<{ readonly baseRefName: string; readonly cwd: string }> = [];

  return Effect.gen(function* () {
    yield* runChangeRequestStep({
      settings,
      cwd: "/repo",
      fallbackRefName: null,
      tempDir: process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp",
      emit: () => Effect.void,
      reads: { ...readsFor("/repo"), resolveRefName: () => Effect.succeed("release/canonical") },
    });
    assert.deepStrictEqual(
      created.map((entry) => entry.baseRefName),
      ["release/canonical"],
    );
  }).pipe(Effect.provide(makeLayer(created)));
});

it.effect(
  "honors provider head probes and reads provider templates in the hosting workspace",
  () => {
    const created: Array<{ readonly baseRefName: string; readonly cwd: string }> = [];
    const lists: Array<{ headSelector: string; limit: number | undefined }> = [];
    const templates: Array<{ cwd: string; treeish: string }> = [];
    const generatedTemplates: Array<string | undefined> = [];

    return Effect.gen(function* () {
      yield* runChangeRequestStep({
        settings: {
          ...settings,
          style: { ...settings.style, followChangeRequestTemplates: true },
        },
        cwd: "/repo/worktrees/thread",
        fallbackRefName: null,
        tempDir: process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp",
        emit: () => Effect.void,
        reads: readsFor("/repo"),
      });
      assert.deepStrictEqual(lists, [
        { headSelector: "provider-selected-head", limit: 100 },
        { headSelector: "provider-selected-head", limit: 100 },
      ]);
      assert.deepStrictEqual(templates, [{ cwd: "/repo", treeish: "deadbeef" }]);
      assert.deepStrictEqual(generatedTemplates, ["Provider template"]);
    }).pipe(
      Effect.provide(
        makeLayer(
          created,
          {
            kind: SourceControlProviderKind.make("gitlab"),
            headBranchProbe: () => ({ headSelectors: ["provider-selected-head"], limit: 100 }),
            listChangeRequests: (input) =>
              Effect.sync(() => {
                lists.push({ headSelector: input.headSelector, limit: input.limit });
                return [];
              }),
            readChangeRequestTemplate: (input) =>
              Effect.sync(() => {
                templates.push(input);
                return Option.some("Provider template");
              }),
          },
          {
            generatePrContent: (input) =>
              Effect.sync(() => {
                generatedTemplates.push(input.changeRequestTemplate);
                return { title: "Add the thing", body: "Body" };
              }),
          },
        ),
      ),
    );
  },
);

it.effect("applies explicit project settings without requiring orchestration stores", () => {
  const projectId = ProjectId.make("project-jj");
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "project-writer",
  };
  return Effect.gen(function* () {
    const resolved = yield* resolveTextGenerationSettings({
      operation: "runStackedAction",
      cwd: "/repo/worktrees/thread",
      projectId,
    });
    assert.deepStrictEqual(resolved.modelSelection, modelSelection);
  }).pipe(
    Effect.provide(
      Layer.merge(
        ServerSettings.layerTest({
          sourceControlWriterModelSelection: null,
          projectSettingsOverrides: {
            [projectId]: { textGenerationModelSelection: modelSelection },
          },
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      ),
    ),
  );
});

it.effect("uses provider repository parsing and reads an origin head only once", () => {
  const created: Array<{ readonly baseRefName: string; readonly cwd: string }> = [];
  const remoteReads: string[] = [];
  const parsedUrls: string[] = [];
  const remoteUrl = "https://github.com/prefix/owner/repo.git";

  return Effect.gen(function* () {
    const context = yield* resolveBranchHeadContext(
      (_cwd, key) =>
        Effect.sync(() => {
          if (key === "branch.feat/thing.remote") return "origin";
          remoteReads.push(key);
          return remoteUrl;
        }),
      "/repo",
      { branch: "feat/thing", upstreamRef: "origin/feat/thing" },
    );
    assert.equal(context.headRepositoryNameWithOwner, "owner/repo");
    assert.equal(context.headRepositoryOwnerLogin, "owner");
    assert.deepStrictEqual(remoteReads, ["remote.origin.url"]);
    assert.deepStrictEqual(parsedUrls, [remoteUrl]);
  }).pipe(
    Effect.provide(
      makeLayer(created, {
        repositoryNameFromRemoteUrl: (url) => {
          parsedUrls.push(url);
          return "owner/repo";
        },
      }),
    ),
  );
});
