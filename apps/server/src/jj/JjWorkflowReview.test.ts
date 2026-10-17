import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { SourceControlProviderKind, TextGenerationError } from "@t3tools/contracts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
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
import { commitId, describeJj, runJj, withJjRepo, write } from "../vcs/testing/JjTestSupport.ts";
import * as JjWorkflow from "./JjWorkflow.ts";

describeJj("JjWorkflow review context", () => {
  it.effect("excludes diverged base-only edits from generated PR context", () =>
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
        yield* runJj(repo.root, ["bookmark", "set", "main", "-r", "@-"]);
        yield* runJj(repo.root, ["git", "push", "--remote", "origin", "--bookmark", "main"]);
        yield* runJj(repo.root, ["new", topic]);
        let generated = false;
        const providerLayer = Layer.mock(SourceControlProvider.SourceControlProvider)({
          readChangeRequestTemplate: () => Effect.succeedNone,
          kind: SourceControlProviderKind.make("github"),
          headBranchProbe: ({ headSelectors }) => ({ headSelectors, limit: 1 }),
          listChangeRequests: () => Effect.succeed([]),
          getDefaultBranch: () => Effect.succeed("main"),
        });
        const config = yield* ServerConfig.pipe(
          Effect.provide(serverConfigLayerTest(repo.root, repo.path.join(repo.base, "config"))),
        );
        const workflow = yield* JjWorkflow.make.pipe(
          Effect.provideService(JjVcsDriver.JjVcsDriver, repo.driver),
          Effect.provideService(VcsProcess.VcsProcess, repo.process),
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig, config),
              NodeCrypto.layer,
              Layer.mock(GitManager.GitManager)({}),
              Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
              Layer.mock(ProjectStore.ProjectStoreV2)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
              ServerSettings.layerTest(),
              Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
                resolveLink: () => undefined,
                resolve: () =>
                  SourceControlProvider.SourceControlProvider.pipe(Effect.provide(providerLayer)),
              }),
              Layer.mock(TextGeneration.TextGeneration)({
                generatePrContent: (input) =>
                  Effect.gen(function* () {
                    generated = true;
                    assert.include(input.commitSummary, "feature-only");
                    assert.notInclude(input.commitSummary, "base-only");
                    assert.include(input.diffSummary, "feature.txt");
                    assert.notInclude(input.diffSummary, "shared.txt");
                    assert.include(input.diffPatch, "+feature");
                    assert.notInclude(input.diffPatch, "base-only");
                    return yield* new TextGenerationError({
                      operation: "generatePrContent",
                      detail: "context captured",
                    });
                  }),
              }),
            ),
          ),
        );
        yield* workflow
          .runStackedAction({
            actionId: "range-context",
            cwd: repo.root,
            action: "create_pr",
            featureBranch: false,
          })
          .pipe(Effect.flip);
        assert.isTrue(generated);
      }),
    ),
  );
});
