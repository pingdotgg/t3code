import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
import * as AzureDevOpsSourceControlProvider from "@t3tools/source-control-azure-devops/server/AzureDevOpsSourceControlProvider";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as GitLabSourceControlProvider from "@t3tools/source-control-gitlab/server/GitLabSourceControlProvider";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

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
      yield* runGit(cwd, ["remote", "add", "origin", cwd]);
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
    yield* runGit(cwd, ["update-ref", "refs/remotes/origin/main", "main"]);
    yield* runGit(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  });

const makeProvider = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  return yield* AzureDevOpsSourceControlProvider.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}),
        TestSourceControlHost.layer({
          git: { execute: git.execute, resolvePrimaryRemoteName: git.resolvePrimaryRemoteName },
        }),
      ),
    ),
  );
});

const readTemplate = (cwd: string, treeish = "main") =>
  Effect.gen(function* () {
    const provider = yield* makeProvider;
    assert.isFunction(provider.readChangeRequestTemplate);
    return yield* provider.readChangeRequestTemplate!({ cwd, treeish });
  });

it.effect(
  "reads the Azure default-branch template instead of feature-branch or uncommitted content",
  () =>
    runWithTempDirectory((cwd) =>
      Effect.gen(function* () {
        const templatePath = ".azuredevops/pull_request_template.md";
        yield* writeTemplate(cwd, templatePath, "Default branch template");
        yield* commitTemplates(cwd);
        yield* runGit(cwd, ["checkout", "-b", "feature"]);
        yield* writeTemplate(cwd, templatePath, "Feature branch template");
        yield* commitTemplates(cwd);
        yield* writeTemplate(cwd, templatePath, "Uncommitted template");

        assert.deepStrictEqual(yield* readTemplate(cwd), Option.some("Default branch template"));
      }),
    ),
);

// Microsoft searches these locations in order; extension choice must not override folder precedence.
it.effect.each([
  [".azuredevops/pull_request_template.txt", ".vsts/pull_request_template.md"],
  [".vsts/pull_request_template.txt", "docs/pull_request_template.md"],
  ["docs/pull_request_template.txt", "pull_request_template.md"],
] as const)("prefers %s over %s", ([preferred, fallback]) =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, preferred, "Preferred template");
      yield* writeTemplate(cwd, fallback, "Fallback template");
      yield* commitTemplates(cwd);

      assert.deepStrictEqual(yield* readTemplate(cwd), Option.some("Preferred template"));
    }),
  ),
);

it.effect.each([
  ".AzUrEdEvOpS/PuLl_ReQuEsT_TeMpLaTe.MD",
  ".VsTs/PULL_REQUEST_TEMPLATE.TxT",
  "DoCs/Pull_Request_Template.mD",
  "PULL_REQUEST_TEMPLATE.TXT",
])("recognizes case-insensitive Azure template path %s", (templatePath) =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, templatePath, "Case-insensitive template");
      yield* commitTemplates(cwd);

      assert.deepStrictEqual(yield* readTemplate(cwd), Option.some("Case-insensitive template"));
    }),
  ),
);

it.effect("returns the same absent value as GitLab for a repository without templates", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* commitTemplates(cwd);
      const git = yield* GitVcsDriver.GitVcsDriver;
      const gitlab = yield* GitLabSourceControlProvider.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(GitLabCli.GitLabCli)({}),
            TestSourceControlHost.layer({
              git: { execute: git.execute, resolvePrimaryRemoteName: git.resolvePrimaryRemoteName },
            }),
          ),
        ),
      );
      const absent = yield* gitlab.readChangeRequestTemplate!({ cwd, treeish: "main" });
      assert.deepStrictEqual(absent, Option.none());
      assert.deepStrictEqual(yield* readTemplate(cwd), absent);
    }),
  ),
);

it.effect("ignores blank templates", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, ".azuredevops/pull_request_template.md", " \n\t ");
      yield* commitTemplates(cwd);

      assert.deepStrictEqual(yield* readTemplate(cwd), Option.none());
    }),
  ),
);

it.effect("ignores symlinks and nested templates", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const target = yield* writeTemplate(cwd, "template.md", "Not a default template");
      yield* fileSystem.makeDirectory(`${cwd}/.azuredevops`);
      yield* fileSystem.symlink(target, `${cwd}/.azuredevops/pull_request_template.md`);
      yield* writeTemplate(cwd, "docs/nested/pull_request_template.md", "Nested template");
      yield* commitTemplates(cwd);

      assert.deepStrictEqual(yield* readTemplate(cwd), Option.none());
    }),
  ),
);

it.effect("bounds template content and marks truncation", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, "pull_request_template.md", "x".repeat(10_000));
      yield* commitTemplates(cwd);

      const template = yield* readTemplate(cwd);
      assert.isTrue(Option.isSome(template));
      if (Option.isSome(template)) {
        assert.isTrue(template.value.startsWith("x".repeat(8_000)));
        assert.isTrue(template.value.endsWith("[truncated]"));
        assert.isBelow(template.value.length, 8_100);
      }
    }),
  ),
);

it.effect("returns no template when the local remote default branch is unknown", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, "pull_request_template.md", "Target branch template");
      yield* commitTemplates(cwd);
      yield* runGit(cwd, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);

      assert.deepStrictEqual(yield* readTemplate(cwd), Option.none());
    }),
  ),
);
