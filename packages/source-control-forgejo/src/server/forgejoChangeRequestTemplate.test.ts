import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";

const templateRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { git } = yield* SourceControlHost.SourceControlHost;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-forgejo-pr-template-" });
  const runGit = (args: ReadonlyArray<string>) =>
    git.execute({ operation: "forgejoChangeRequestTemplate.test.git", cwd, args });
  yield* runGit(["init", "--initial-branch=main", "--template="]);
  yield* runGit(["config", "user.email", "test@example.com"]);
  yield* runGit(["config", "user.name", "Test User"]);
  const provider = yield* ForgejoSourceControlProvider.make;

  return {
    runGit,
    writeTemplate: (relativePath: string, body: string) =>
      Effect.gen(function* () {
        const file = path.join(cwd, relativePath);
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, body);
      }),
    commit: Effect.gen(function* () {
      yield* runGit(["add", "-A"]);
      yield* runGit(["commit", "--allow-empty", "-m", "Set pull request template"]);
    }),
    read: (treeish: string) =>
      provider.readChangeRequestTemplate?.({ cwd, treeish }) ?? Effect.succeedNone,
  };
});

const testLayer = Layer.mergeAll(
  TestSourceControlHost.layerWithRealGit(),
  Layer.mock(ForgejoCli.ForgejoCli)({}),
  NodeServices.layer,
);

it.live("reads the Gitea template committed to the target branch", () =>
  Effect.gen(function* () {
    const repo = yield* templateRepository;
    yield* repo.commit;
    yield* repo.runGit(["branch", "feature"]);
    yield* repo.writeTemplate(".gitea/pull_request_template.md", "## Expected on the PR");
    yield* repo.commit;
    yield* repo.runGit(["checkout", "feature"]);
    yield* repo.writeTemplate(".gitea/pull_request_template.md", "## Working tree only");

    assert.deepStrictEqual(yield* repo.read("main"), Option.some("## Expected on the PR"));
    assert.deepStrictEqual(yield* repo.read("HEAD"), Option.none());
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("uses the first non-empty Markdown template in Forgejo's lookup order", () =>
  Effect.gen(function* () {
    const repo = yield* templateRepository;
    yield* repo.writeTemplate("pull_request_template.md", " \n");
    yield* repo.writeTemplate(".forgejo/PULL_REQUEST_TEMPLATE.md", "## Forgejo");
    yield* repo.writeTemplate(".gitea/pull_request_template.md", "## Gitea");
    yield* repo.commit;
    assert.deepStrictEqual(yield* repo.read("HEAD"), Option.some("## Forgejo"));

    yield* repo.writeTemplate("pull_request_template.md", "## Root");
    yield* repo.commit;
    assert.deepStrictEqual(yield* repo.read("HEAD"), Option.some("## Root"));
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("rejects a committed template symlink and caps the fallback blob", () =>
  Effect.gen(function* () {
    const repo = yield* templateRepository;
    const fallback = "x".repeat(9_000);
    yield* repo.writeTemplate(".github/pull_request_template.md", fallback);
    yield* repo.writeTemplate("link-target", "README.md");
    yield* repo.commit;
    const linkBlob = yield* repo.runGit(["rev-parse", "HEAD:link-target"]);
    yield* repo.runGit([
      "update-index",
      "--add",
      "--cacheinfo",
      `120000,${linkBlob.stdout.trim()},pull_request_template.md`,
    ]);
    yield* repo.runGit(["commit", "-m", "Record a template symlink"]);

    assert.deepStrictEqual(
      yield* repo.read("HEAD"),
      Option.some(`${fallback.slice(0, 8_000)}\n\n[truncated]`),
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
