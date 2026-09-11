import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-driver-utf8-test-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTmpDir = () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix: "git-vcs-driver-utf8-test-" });
  });

const writeTextFile = (cwd: string, relativePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.utf8Test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (cwd: string) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });

it.effect("keeps truncated multibyte output valid and within the byte budget", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    yield* initRepoWithCommit(cwd);
    yield* writeTextFile(cwd, "01-large-untracked.txt", `${"é".repeat(600_000)}\n`);

    const driver = yield* GitVcsDriver.GitVcsDriver;
    const preview = yield* driver.getReviewDiffPreview({ cwd });
    const source = preview.sources.find((candidate) => candidate.kind === "working-tree");

    assert.isDefined(source);
    assert.isTrue(source.truncated);
    assert.include(source.diff, "01-large-untracked.txt");
    assert.notInclude(source.diff, "\uFFFD");

    assert.isAtMost(new TextEncoder().encode(source.diff).byteLength, 1024 * 1024);
  }).pipe(Effect.provide(TestLayer)),
);
