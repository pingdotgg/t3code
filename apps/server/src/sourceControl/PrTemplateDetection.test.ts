import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { SourceControlProviderKind } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { detectPrTemplate } from "./PrTemplateDetection.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const SINGLE_TEMPLATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
] as const;

const TEMPLATE_DIRECTORIES = [
  ".github/PULL_REQUEST_TEMPLATE",
  "PULL_REQUEST_TEMPLATE",
  "docs/PULL_REQUEST_TEMPLATE",
] as const;

const GITLAB_DEFAULT_TEMPLATE_NAMES = [
  "Default.md",
  "default.md",
  "DEFAULT.MD",
  "Default.MD",
] as const;

const AZURE_DEVOPS_TEMPLATE_PATHS = [
  ".azuredevops/pull_request_template.md",
  ".azuredevops/pull_request_template.txt",
  ".vsts/pull_request_template.md",
  ".vsts/pull_request_template.txt",
  "docs/pull_request_template.md",
  "docs/pull_request_template.txt",
  "pull_request_template.md",
  "pull_request_template.txt",
] as const;

const PrTemplateDetectionTestLayer = GitVcsDriver.layer.pipe(
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
  ).pipe(Effect.provide(PrTemplateDetectionTestLayer));

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

const detectTemplate = (
  cwd: string,
  treeish = "HEAD",
  providerKind: SourceControlProviderKind = "github",
) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    return yield* detectPrTemplate(cwd, treeish, git.execute, providerKind);
  });

it.effect.each(SINGLE_TEMPLATE_PATHS)("recognizes $0", (relativePath) =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, relativePath, `template from ${relativePath}`);
      yield* commitTemplates(cwd);

      const template = yield* detectTemplate(cwd);
      assert.strictEqual(Option.getOrUndefined(template), `template from ${relativePath}`);
    }),
  ),
);

it.effect("reads templates from the requested base tree", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, "README.md", "initial\n");
      yield* commitTemplates(cwd);
      yield* runGit(cwd, ["branch", "feature"]);
      yield* writeTemplate(cwd, ".github/pull_request_template.md", "base template");
      yield* commitTemplates(cwd);
      yield* runGit(cwd, ["checkout", "feature"]);

      assert.isTrue(Option.isNone(yield* detectTemplate(cwd)));
      assert.strictEqual(
        Option.getOrUndefined(yield* detectTemplate(cwd, "main")),
        "base template",
      );
    }),
  ),
);

it.effect("uses the first non-empty template in the configured path order", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, ".github/pull_request_template.md", " \n");
      yield* writeTemplate(cwd, ".github/PULL_REQUEST_TEMPLATE.md", "  ## Preferred template  \n");
      yield* writeTemplate(cwd, "pull_request_template.md", "## Later template");
      yield* commitTemplates(cwd);

      const template = yield* detectTemplate(cwd);
      assert.strictEqual(Option.getOrUndefined(template), "## Preferred template");
    }),
  ),
);

it.effect.each(TEMPLATE_DIRECTORIES)("recognizes the $0 directory", (relativeDirectory) =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, `${relativeDirectory}/template.MD`, "directory template");
      yield* commitTemplates(cwd);

      const template = yield* detectTemplate(cwd);
      assert.strictEqual(Option.getOrUndefined(template), "directory template");
    }),
  ),
);

it.effect.each(GITLAB_DEFAULT_TEMPLATE_NAMES)(
  "recognizes the GitLab default template named $0",
  (templateFileName) =>
    runWithTempDirectory((cwd) =>
      Effect.gen(function* () {
        const relativePath = `.gitlab/merge_request_templates/${templateFileName}`;
        yield* writeTemplate(cwd, relativePath, `template from ${templateFileName}`);
        yield* commitTemplates(cwd);

        const template = yield* detectTemplate(cwd, "HEAD", "gitlab");
        assert.strictEqual(Option.getOrUndefined(template), `template from ${templateFileName}`);
      }),
    ),
);

it.effect("prefers the GitLab default template over named templates", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, ".gitlab/merge_request_templates/Default.md", "default template");
      yield* writeTemplate(cwd, ".gitlab/merge_request_templates/feature.md", "feature template");
      yield* commitTemplates(cwd);

      const template = yield* detectTemplate(cwd, "HEAD", "gitlab");
      assert.strictEqual(Option.getOrUndefined(template), "default template");
    }),
  ),
);

it.effect("does not use a named GitLab template when no default exists", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, ".gitlab/merge_request_templates/feature.md", "feature template");
      yield* commitTemplates(cwd);

      const template = yield* detectTemplate(cwd, "HEAD", "gitlab");
      assert.isTrue(Option.isNone(template));
    }),
  ),
);

it.effect.each(AZURE_DEVOPS_TEMPLATE_PATHS)(
  "recognizes the Azure DevOps template at $0",
  (relativePath) =>
    runWithTempDirectory((cwd) =>
      Effect.gen(function* () {
        yield* writeTemplate(cwd, relativePath, `template from ${relativePath}`);
        yield* commitTemplates(cwd);

        const template = yield* detectTemplate(cwd, "HEAD", "azure-devops");
        assert.strictEqual(Option.getOrUndefined(template), `template from ${relativePath}`);
      }),
    ),
);

it.effect("uses the first Azure DevOps template in folder precedence order", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, ".azuredevops/pull_request_template.txt", "azuredevops txt");
      yield* writeTemplate(cwd, ".vsts/pull_request_template.md", "vsts md");
      yield* writeTemplate(cwd, "docs/pull_request_template.txt", "docs txt");
      yield* writeTemplate(cwd, "pull_request_template.md", "root md");
      yield* commitTemplates(cwd);

      const template = yield* detectTemplate(cwd, "HEAD", "azure-devops");
      assert.strictEqual(Option.getOrUndefined(template), "azuredevops txt");
    }),
  ),
);

it.effect("only detects templates for the active provider kind", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, ".github/pull_request_template.md", "github template");
      yield* writeTemplate(cwd, ".gitlab/merge_request_templates/Default.md", "gitlab template");
      yield* writeTemplate(cwd, ".azuredevops/pull_request_template.md", "azure template");
      yield* commitTemplates(cwd);

      assert.strictEqual(
        Option.getOrUndefined(yield* detectTemplate(cwd, "HEAD", "github")),
        "github template",
      );
      assert.strictEqual(
        Option.getOrUndefined(yield* detectTemplate(cwd, "HEAD", "gitlab")),
        "gitlab template",
      );
      assert.strictEqual(
        Option.getOrUndefined(yield* detectTemplate(cwd, "HEAD", "azure-devops")),
        "azure template",
      );
      assert.isTrue(Option.isNone(yield* detectTemplate(cwd, "HEAD", "bitbucket")));
    }),
  ),
);

it.effect.skipIf(!symlinksSupported)(
  "skips unusable directory entries and uses the one valid template",
  () =>
    runWithTempDirectory((cwd) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const templateDirectory = path.join(cwd, ".github", "PULL_REQUEST_TEMPLATE");
        yield* fileSystem.makeDirectory(path.join(templateDirectory, "b-directory.md"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(path.join(templateDirectory, "a-empty.md"), " \n");
        yield* fileSystem.symlink(
          path.join(templateDirectory, "missing.md"),
          path.join(templateDirectory, "c-broken.md"),
        );
        yield* fileSystem.writeFileString(path.join(templateDirectory, "z-valid.md"), "valid");
        yield* commitTemplates(cwd);

        const template = yield* detectTemplate(cwd);
        assert.strictEqual(Option.getOrUndefined(template), "valid");
      }),
    ),
);

it.effect("does not guess between multiple directory templates", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      yield* writeTemplate(cwd, ".github/PULL_REQUEST_TEMPLATE/a.md", "first");
      yield* writeTemplate(cwd, ".github/PULL_REQUEST_TEMPLATE/b.md", "second");
      yield* writeTemplate(cwd, "PULL_REQUEST_TEMPLATE/fallback.md", "fallback");
      yield* commitTemplates(cwd);

      const template = yield* detectTemplate(cwd);
      assert.isTrue(Option.isNone(template));
    }),
  ),
);

it.effect.skipIf(!symlinksSupported)(
  "rejects a committed template symlink escaping the repository",
  () =>
    runWithTempDirectory((cwd) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outsideDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-pr-template-outside-",
        });
        const outsideTemplate = path.join(outsideDirectory, "secret.md");
        yield* fileSystem.writeFileString(outsideTemplate, "LOCAL_SECRET_SENTINEL");
        const escapedTemplatePath = path.join(cwd, ".github", "pull_request_template.md");
        yield* fileSystem.makeDirectory(path.dirname(escapedTemplatePath), { recursive: true });
        yield* fileSystem.symlink(outsideTemplate, escapedTemplatePath);
        yield* writeTemplate(cwd, "pull_request_template.md", "safe template");
        yield* commitTemplates(cwd);

        const template = yield* detectTemplate(cwd);
        assert.strictEqual(Option.getOrUndefined(template), "safe template");
        assert.notInclude(
          Option.getOrElse(template, () => ""),
          "LOCAL_SECRET_SENTINEL",
        );
      }),
    ),
);

it.effect.skipIf(!symlinksSupported)(
  "reads the committed template when a worktree parent is replaced",
  () =>
    runWithTempDirectory((cwd) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outsideDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-pr-template-outside-",
        });
        const templatePath = yield* writeTemplate(
          cwd,
          ".github/pull_request_template.md",
          "committed template",
        );
        yield* commitTemplates(cwd);
        yield* writeTemplate(outsideDirectory, "pull_request_template.md", "LOCAL_SECRET_SENTINEL");

        const templateDirectory = path.dirname(templatePath);
        yield* fileSystem.rename(templateDirectory, path.join(cwd, ".github-original"));
        yield* fileSystem.symlink(outsideDirectory, templateDirectory);

        const template = yield* detectTemplate(cwd);
        assert.strictEqual(Option.getOrUndefined(template), "committed template");
        assert.notInclude(
          Option.getOrElse(template, () => ""),
          "LOCAL_SECRET_SENTINEL",
        );
      }),
    ),
);

it.effect("bounds template reads and marks truncated content", () =>
  runWithTempDirectory((cwd) =>
    Effect.gen(function* () {
      const prefix = "a".repeat(8_000);
      yield* writeTemplate(cwd, ".github/pull_request_template.md", `${prefix}SECRET_SENTINEL`);
      yield* commitTemplates(cwd);

      const template = Option.getOrThrow(yield* detectTemplate(cwd));
      assert.strictEqual(template, `${prefix}\n\n[truncated]`);
      assert.lengthOf(template.match(/\[truncated\]/g) ?? [], 1);
      assert.notInclude(template, "SECRET_SENTINEL");
    }),
  ),
);
