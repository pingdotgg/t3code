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

    yield* configuration.write({ cwd: root, setting: "userName", value: "Repository Author" });
    yield* configuration.write({ cwd: root, setting: "largeFile", value: "4 MiB" });
    const saved = yield* configuration.read({ cwd: root });
    assert.equal(saved.kind, "git");
    assert.equal(saved.userName.repository, "Repository Author");
    assert.equal(saved.largeFile.repository, "4m");
    assert.equal(
      (yield* runGit(root, ["config", "--local", "--get", "core.bigFileThreshold"])).trim(),
      "4m",
    );

    yield* configuration.write({ cwd: root, setting: "largeFile", value: null });
    assert.equal((yield* configuration.read({ cwd: root })).largeFile.repository, null);
    const failure = yield* configuration
      .write({ cwd: root, setting: "largeFile", value: "5000" })
      .pipe(Effect.flip);
    assert.equal(failure._tag, "VcsUnsupportedOperationError");
  }).pipe(Effect.provide(TestLayer)),
);
