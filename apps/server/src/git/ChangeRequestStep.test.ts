import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import {
  ProviderInstanceId,
  SourceControlProviderKind,
  TextGenerationError,
} from "@t3tools/contracts";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { resolveBranchHeadContext } from "./GitManager.ts";
import {
  runChangeRequestStep,
  type ChangeRequestVcsReads,
  type SourceControlTextGenerationSettings,
} from "./GitManager.ts";

const settings: SourceControlTextGenerationSettings = {
  projectId: null,
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
  generateReviewGuide: () => Effect.die("not exercised"),
  generateTranscriptionPostProcessing: () => Effect.die("not exercised"),
};

function makeLayer(created: Array<{ readonly baseRefName: string; readonly cwd: string }>) {
  const providerLayer = Layer.mock(SourceControlProvider.SourceControlProvider)({
    kind: SourceControlProviderKind.make("github"),
    headBranchProbe: ({ headSelectors }) => ({ headSelectors, limit: 1 }),
    listChangeRequests: () => Effect.succeed([]),
    getDefaultBranch: () => Effect.succeed("main"),
    createChangeRequest: (input) =>
      Effect.sync(() => {
        created.push({ baseRefName: input.baseRefName, cwd: input.cwd });
      }),
  });

  return Layer.mergeAll(
    Layer.succeed(TextGeneration.TextGeneration, textGeneration),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ServerSettings.layerTest(),
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => undefined,
      resolve: () =>
        SourceControlProvider.SourceControlProvider.pipe(Effect.provide(providerLayer)),
    }),
    NodeServices.layer,
    NodeCrypto.layer,
  );
}

/** The one read that differs between the lanes is where the hosting CLI runs. */
function readsFor(providerCwd: string): ChangeRequestVcsReads {
  return {
    refName: "feat/thing",
    hasUpstream: true,
    upstreamRef: "origin/feat/thing",
    readRangeContext: () =>
      Effect.succeed({ commitSummary: "abc feat", diffSummary: "1 file", diffPatch: "diff" }),
    recentSubjects: () => Effect.succeed([]),
    providerCwd,
    configuredPrBase: () => Effect.succeed({ baseBranch: "release/v2", baseRef: "release/v2" }),
    headContext: (cwd, refName, upstreamRef) =>
      resolveBranchHeadContext(
        {
          readConfigValue: () => Effect.succeed(null),
          executeGit: () =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(1),
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        },
        cwd,
        { branch: refName, upstreamRef },
      ),
    resolvePrimaryRemoteName: () => Effect.succeed("origin"),
    resolveDefaultRefName: () => Effect.succeed("main"),
    resolveRemoteTrackingCommit: () => Effect.succeed({ commitSha: "deadbeef" }),
  };
}

it.effect("opens the change request against the base the thread recorded, in both lanes", () => {
  const created: Array<{ readonly baseRefName: string; readonly cwd: string }> = [];

  return Effect.gen(function* () {
    const git = yield* runChangeRequestStep({
      settings,
      cwd: "/repo",
      fallbackRefName: null,
      emit: () => Effect.void,
      reads: readsFor("/repo"),
    });

    const jj = yield* runChangeRequestStep({
      settings,
      cwd: "/repo/worktrees/thread",
      fallbackRefName: null,
      emit: () => Effect.void,
      reads: readsFor("/repo"),
    });

    assert.equal(git.status, "created");
    assert.equal(jj.status, "created");
    assert.deepStrictEqual(
      created.map((entry) => entry.baseRefName),
      ["release/v2", "release/v2"],
    );
    // Both lanes run the hosting CLI in the main workspace root.
    assert.deepStrictEqual(
      created.map((entry) => entry.cwd),
      ["/repo", "/repo"],
    );
  }).pipe(Effect.provide(makeLayer(created)));
});

it.effect("refuses to open a change request for a ref that was never pushed", () => {
  const created: Array<{ readonly baseRefName: string; readonly cwd: string }> = [];

  return Effect.gen(function* () {
    const failure = yield* runChangeRequestStep({
      settings,
      cwd: "/repo",
      fallbackRefName: null,
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
