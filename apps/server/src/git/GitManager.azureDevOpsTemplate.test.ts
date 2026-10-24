import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
import * as AzureDevOpsSourceControlProvider from "@t3tools/source-control-azure-devops/server/AzureDevOpsSourceControlProvider";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as GitManager from "./GitManager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

const layerPrTemplateDetectionTest = GitVcsDriver.layer.pipe(
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-pr-template-test-",
    }),
  ),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    return yield* git.execute({
      operation: "PrTemplateDetection.test.runGit",
      cwd,
      args,
    });
  });

const runWithTempDirectory = <A, E, R>(
  test: (cwd: string) => Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pr-template-" });
      yield* runGit(cwd, ["init", "--initial-branch=main"]);
      yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
      yield* runGit(cwd, ["config", "user.name", "Test User"]);
      return yield* test(cwd);
    }),
  ).pipe(Effect.provide(layerPrTemplateDetectionTest));

const writeTemplate = (cwd: string, relativePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const templatePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(templatePath), { recursive: true });
    yield* fileSystem.writeFileString(templatePath, contents);
    return templatePath;
  });

const commitTemplates = (cwd: string) =>
  Effect.gen(function* () {
    yield* runGit(cwd, ["add", "-A"]);
    yield* runGit(cwd, ["commit", "--allow-empty", "-m", "Add pull request templates"]);
  });

it.effect.each(["main", "different release template", "missing release template"])(
  "uses the Azure default template with %s",
  (target) =>
    runWithTempDirectory((cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["config", "core.autocrlf", "false"]);
        const templatePath = ".azuredevops/pull_request_template.md";
        yield* writeTemplate(cwd, templatePath, "Default branch template");
        yield* commitTemplates(cwd);
        const fs = yield* FileSystem.FileSystem;
        const remote = yield* fs.makeTempDirectoryScoped({ prefix: "t3-azure-template-remote-" });
        yield* runGit(remote, ["init", "--bare", "--initial-branch=main"]);
        yield* runGit(cwd, ["remote", "add", "origin", remote]);
        yield* runGit(cwd, ["push", "-u", "origin", "main"]);
        yield* runGit(cwd, ["remote", "set-head", "origin", "main"]);
        if (target !== "main") {
          yield* runGit(cwd, ["checkout", "-b", "release"]);
          if (target === "missing release template") {
            yield* fs.remove(`${cwd}/${templatePath}`);
          } else {
            yield* writeTemplate(cwd, templatePath, "Release branch template");
          }
          yield* commitTemplates(cwd);
          yield* runGit(cwd, ["push", "-u", "origin", "release"]);
        }
        yield* runGit(cwd, ["checkout", "-b", "feature/azure-template"]);
        if (target !== "main") {
          yield* runGit(cwd, [
            "config",
            "branch.feature/azure-template.t3-merge-base-ref",
            "refs/remotes/origin/release",
          ]);
        }
        yield* writeTemplate(cwd, templatePath, "Feature branch template");
        yield* writeTemplate(cwd, "feature.txt", "Feature work");
        yield* commitTemplates(cwd);
        yield* runGit(cwd, ["push", "-u", "origin", "feature/azure-template"]);

        const git = yield* GitVcsDriver.GitVcsDriver;
        let created = false;
        const provider = yield* AzureDevOpsSourceControlProvider.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
                getDefaultBranch: () => Effect.succeed("main"),
                listPullRequests: () => Effect.succeed([]),
                createPullRequest: ({ bodyFile }) =>
                  Effect.gen(function* () {
                    assert.strictEqual(
                      yield* fs.readFileString(bodyFile).pipe(Effect.orDie),
                      "Generated body",
                    );
                    created = true;
                  }),
              }),
              TestSourceControlHost.layer({
                git: {
                  execute: git.execute,
                  resolvePrimaryRemoteName: git.resolvePrimaryRemoteName,
                },
              }),
            ),
          ),
        );
        const generated: TextGeneration.PrContentGenerationInput[] = [];
        const services = Layer.mergeAll(
          Layer.mock(TextGeneration.TextGeneration)({
            generatePrContent: (input) => {
              generated.push(input);
              return Effect.succeed({ title: "Azure template PR", body: "Generated body" });
            },
          }),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolve: () => Effect.succeed(provider),
            resolveHandle: () => Effect.succeed({ provider, context: null }),
            get: () => Effect.succeed(provider),
            discover: Effect.succeed([]),
            resolveLink: () => undefined,
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([]),
          }),
          Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
            runForThread: () => Effect.succeed({ status: "no-script" as const }),
          }),
          ServerSettings.ServerSettingsService.layerTest({
            sourceControlWritingStyle: { followChangeRequestTemplates: true },
          }),
          Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(
            Layer.provide(SqlitePersistence.layerMemory),
          ),
        );
        const manager = yield* GitManager.make.pipe(
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provide(services),
        );

        const result = yield* manager.runStackedAction({
          actionId: "azure-template-test",
          cwd,
          action: "create_pr",
        });

        assert.strictEqual(result.pr.status, "created");
        assert.isTrue(created);
        assert.lengthOf(generated, 1);
        assert.strictEqual(generated[0]?.baseBranch, target === "main" ? "main" : "release");
        assert.include(generated[0]?.diffPatch ?? "", "+Feature work");
        assert.strictEqual(generated[0]?.changeRequestTemplate, "Default branch template");
      }),
    ),
);
