// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as VcsConfigurationService from "./VcsConfigurationService.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as VcsProcess from "./VcsProcess.ts";

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.sync(() => NodeChildProcess.execFileSync("git", [...args], { cwd, encoding: "utf8" }));

const TestLayer = VcsConfigurationService.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("reads, writes, and resets guided Git repository configuration", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-config-" });
    yield* runGit(root, ["init", "--initial-branch=main"]);
    const configuration = yield* VcsConfigurationService.VcsConfigurationService;
    const inheritedThreshold = yield* Effect.sync(() =>
      NodeChildProcess.spawnSync("git", ["config", "--get", "core.bigFileThreshold"], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    assert.ok(inheritedThreshold.status === 0 || inheritedThreshold.status === 1);
    const expectedThreshold =
      inheritedThreshold.status === 0 ? inheritedThreshold.stdout.trim() : "512m";
    assert.equal((yield* configuration.read({ cwd: root })).largeFile.effective, expectedThreshold);

    yield* configuration.write({ cwd: root, setting: "userName", value: "Repository Author" });
    yield* configuration.write({ cwd: root, setting: "largeFile", value: "4 MiB" });
    const saved = yield* configuration.read({ cwd: root });
    assert.equal(saved.kind, "git");
    assert.equal(saved.userName.repository, "Repository Author");
    assert.equal(saved.userName.scope, "local");
    assert.equal(saved.largeFile.repository, "4m");
    assert.equal(
      (yield* runGit(root, ["config", "--local", "--get", "core.bigFileThreshold"])).trim(),
      "4m",
    );

    yield* configuration.write({ cwd: root, setting: "largeFile", value: null });
    const reset = yield* configuration.read({ cwd: root });
    assert.equal(reset.largeFile.repository, null);
    assert.equal(reset.largeFile.effective, expectedThreshold);
    const failure = yield* configuration
      .write({ cwd: root, setting: "largeFile", value: "5000" })
      .pipe(Effect.flip);
    assert.equal(failure._tag, "VcsUnsupportedOperationError");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("resets an empty local author override", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-config-empty-" });
    yield* runGit(root, ["init", "--initial-branch=main"]);
    yield* runGit(root, ["config", "--local", "user.name", ""]);
    const configuration = yield* VcsConfigurationService.VcsConfigurationService;

    const before = yield* configuration.read({ cwd: root });
    assert.equal(before.userName.repository, "");
    assert.equal(before.userName.scope, "local");
    yield* configuration.write({ cwd: root, setting: "userName", value: null });
    const after = yield* configuration.read({ cwd: root });
    assert.equal(after.userName.repository, null);
    assert.equal(after.userName.scope, null);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("edits and resets an active worktree override", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-config-worktree-" });
    yield* runGit(root, ["init", "--initial-branch=main"]);
    yield* runGit(root, ["config", "--local", "user.name", "Shared Author"]);
    yield* runGit(root, ["config", "--local", "extensions.worktreeConfig", "true"]);
    yield* runGit(root, ["config", "--worktree", "user.name", "Worktree Author"]);
    const configuration = yield* VcsConfigurationService.VcsConfigurationService;

    const before = yield* configuration.read({ cwd: root });
    assert.equal(before.userName.repository, "Worktree Author");
    assert.equal(before.userName.scope, "worktree");
    yield* configuration.write({ cwd: root, setting: "userName", value: "Updated Author" });
    assert.equal(
      (yield* runGit(root, ["config", "--worktree", "--get", "user.name"])).trim(),
      "Updated Author",
    );
    yield* configuration.write({ cwd: root, setting: "userName", value: null });
    const after = yield* configuration.read({ cwd: root });
    assert.equal(after.userName.repository, "Shared Author");
    assert.equal(after.userName.scope, "local");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("saves fractional MiB thresholds without rounding", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-git-config-size-" });
    yield* runGit(root, ["init", "--initial-branch=main"]);
    const configuration = yield* VcsConfigurationService.VcsConfigurationService;
    for (const [value, bytes] of [
      ["1024", "1073741824"],
      ["1.5", "1572864"],
      ["0.5", "524288"],
      ["0.00000095367431640625", "1"],
    ]) {
      yield* configuration.write({ cwd: root, setting: "largeFile", value: value! });
      assert.equal(
        (yield* runGit(root, ["config", "--int", "--get", "core.bigFileThreshold"])).trim(),
        bytes,
      );
    }
    for (const value of ["0", "-1", "0.0000001", "4097"]) {
      const error = yield* configuration
        .write({ cwd: root, setting: "largeFile", value })
        .pipe(Effect.flip);
      assert.equal(error._tag, "VcsUnsupportedOperationError");
    }
  }).pipe(Effect.provide(TestLayer)),
);
