import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as GitLabSourceControlProvider from "@t3tools/source-control-gitlab/server/GitLabSourceControlProvider";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const TEMPLATE_DIRECTORY = ".gitlab/merge_request_templates";

const layerTemplateTest = GitVcsDriver.layer.pipe(
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-gitlab-template-test-",
    }),
  ),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    return yield* git.execute({ operation: "GitLabChangeRequestTemplate.test.runGit", cwd, args });
  });

const runWithTempRepository = <A, E, R>(
  test: (cwd: string) => Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gitlab-template-" });
      yield* runGit(cwd, ["init", "--initial-branch=main"]);
      yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
      yield* runGit(cwd, ["config", "user.name", "Test User"]);
      return yield* test(cwd);
    }),
  ).pipe(Effect.provide(layerTemplateTest));

// Writes each file, then commits the working tree.
const commitFiles = (cwd: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = path.join(cwd, relativePath);
      yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fileSystem.writeFileString(filePath, contents);
    }
    yield* runGit(cwd, ["add", "-A"]);
    yield* runGit(cwd, ["commit", "--allow-empty", "-m", "Add templates"]);
  });

// The provider is built over the real git driver, so templates come from real commits.
const detectTemplate = (cwd: string, treeish = "HEAD") =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const provider = yield* GitLabSourceControlProvider.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(GitLabCli.GitLabCli)({}),
          TestSourceControlHost.layer({ git: { execute: git.execute } }),
        ),
      ),
    );
    const template = yield* provider.readChangeRequestTemplate!({ cwd, treeish });
    return template._tag === "Some" ? template.value : undefined;
  });

it.effect.each(["Default.md", "default.md", "DEFAULT.MD"])("recognizes %s", (name) =>
  runWithTempRepository((cwd) =>
    Effect.gen(function* () {
      yield* commitFiles(cwd, { [`${TEMPLATE_DIRECTORY}/${name}`]: "  ## GitLab default  \n" });

      assert.strictEqual(yield* detectTemplate(cwd), "## GitLab default");
    }),
  ),
);

it.effect("prefers Default.md over the other templates in the directory", () =>
  runWithTempRepository((cwd) =>
    Effect.gen(function* () {
      yield* commitFiles(cwd, {
        [`${TEMPLATE_DIRECTORY}/Bugfix.md`]: "bugfix template",
        [`${TEMPLATE_DIRECTORY}/Default.md`]: "default template",
        [`${TEMPLATE_DIRECTORY}/Feature.md`]: "feature template",
      });

      assert.strictEqual(yield* detectTemplate(cwd), "default template");
    }),
  ),
);

it.effect("does not treat a lone non-default template as the default", () =>
  runWithTempRepository((cwd) =>
    Effect.gen(function* () {
      yield* commitFiles(cwd, { [`${TEMPLATE_DIRECTORY}/Bugfix.md`]: "bugfix template" });

      assert.isUndefined(yield* detectTemplate(cwd));
    }),
  ),
);

it.effect("ignores GitHub template locations", () =>
  runWithTempRepository((cwd) =>
    Effect.gen(function* () {
      yield* commitFiles(cwd, {
        ".github/pull_request_template.md": "github template",
        "pull_request_template.md": "root template",
      });

      assert.isUndefined(yield* detectTemplate(cwd));
    }),
  ),
);

it.effect("reads the template from the requested base tree", () =>
  runWithTempRepository((cwd) =>
    Effect.gen(function* () {
      yield* commitFiles(cwd, { "README.md": "initial\n" });
      yield* runGit(cwd, ["branch", "feature"]);
      yield* commitFiles(cwd, { [`${TEMPLATE_DIRECTORY}/Default.md`]: "base template" });
      yield* runGit(cwd, ["checkout", "feature"]);

      assert.isUndefined(yield* detectTemplate(cwd));
      assert.strictEqual(yield* detectTemplate(cwd, "main"), "base template");
    }),
  ),
);

it.effect("treats a blank template as none", () =>
  runWithTempRepository((cwd) =>
    Effect.gen(function* () {
      yield* commitFiles(cwd, { [`${TEMPLATE_DIRECTORY}/Default.md`]: " \n\n" });

      assert.isUndefined(yield* detectTemplate(cwd));
    }),
  ),
);

it.effect.skipIf(!symlinksSupported)("rejects a committed symlink template", () =>
  runWithTempRepository((cwd) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gitlab-outside-" });
      yield* fileSystem.writeFileString(path.join(outside, "secret.md"), "LOCAL_SECRET_SENTINEL");
      yield* fileSystem.makeDirectory(path.join(cwd, TEMPLATE_DIRECTORY), { recursive: true });
      yield* fileSystem.symlink(
        path.join(outside, "secret.md"),
        path.join(cwd, TEMPLATE_DIRECTORY, "Default.md"),
      );
      yield* commitFiles(cwd, {});

      assert.isUndefined(yield* detectTemplate(cwd));
    }),
  ),
);

it.effect("bounds the template and marks truncated content", () =>
  runWithTempRepository((cwd) =>
    Effect.gen(function* () {
      const prefix = "a".repeat(8_000);
      yield* commitFiles(cwd, { [`${TEMPLATE_DIRECTORY}/Default.md`]: `${prefix}SECRET_SENTINEL` });

      assert.strictEqual(yield* detectTemplate(cwd), `${prefix}\n\n[truncated]`);
    }),
  ),
);
