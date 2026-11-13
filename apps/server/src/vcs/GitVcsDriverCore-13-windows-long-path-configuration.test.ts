// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it, describe } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner, CommandLine } from "effect/process";
import {
  GitCommandError,
  ReviewDiffPreviewInput,
  VcsRef,
  VcsListRefsResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffPreviewResult,
  type WorktreeSubmodules,
} from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as ServerConfig from "../config.ts";
import {
  makeGitVcsDriverCore,
  parseGitCheckoutProgressLine,
  splitNullSeparatedGitStdoutPaths,
  windowsLongPathConfigEnv,
} from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { gitConfigEnv } from "./VcsProcess.ts";

import { layerServerConfig, makeTmpDir, git, readGitConfig } from "./GitVcsDriverCore-fixtures.testkit.ts";

describe("Windows long path configuration", () => {
  const readGitConfig = Effect.fn("readGitConfig")(function* (
    platform: NodeJS.Platform,
    key: string,
  ) {
    const layer = GitVcsDriver.layer.pipe(
      Layer.provide(layerServerConfig),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
    );
    return yield* Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmpDir("git-longpath-test-");
      const result = yield* driver.execute({
        operation: "GitVcsDriverTest.readGitConfig",
        cwd,
        args: ["config", "--get", key],
        env: {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "user.name",
          GIT_CONFIG_VALUE_0: "inherited-name",
          GIT_CONFIG_KEY_1: "core.longpaths",
          GIT_CONFIG_VALUE_1: "false",
          GIT_CONFIG_KEY_2: "user.name",
          GIT_CONFIG_VALUE_2: "outside-count",
        },
      });
      return result.stdout.trim();
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("enables long paths for every Git command on Windows", () =>
    Effect.gen(function* () {
      assert.equal(yield* readGitConfig("win32", "core.longpaths"), "true");
      assert.equal(yield* readGitConfig("win32", "user.name"), "inherited-name");
    }),
  );

  it("extends the per-command count when inherited and per-command casings differ", () => {
    assert.deepStrictEqual(
      windowsLongPathConfigEnv("win32", { GIT_CONFIG_COUNT: "0", git_config_count: "1" }),
      {
        GIT_CONFIG_COUNT: "2",
        git_config_count: "2",
        GIT_CONFIG_KEY_1: "core.longpaths",
        GIT_CONFIG_VALUE_1: "true",
      },
    );
  });

  it("reads only the exact count name outside Windows", () => {
    assert.deepStrictEqual(
      gitConfigEnv({ git_config_count: "3" }, "safe.bareRepository", "explicit", "linux"),
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.bareRepository",
        GIT_CONFIG_VALUE_0: "explicit",
      },
    );
  });

  it("appends after inherited entries, parsing the count as Git does", () => {
    for (const [count, next] of [
      [undefined, 0],
      ["", 0],
      ["0", 0],
      ["-0", 0],
      ["2", 2],
      [" 2", 2],
      ["+2", 2],
      ["02", 2],
    ] as const) {
      assert.deepStrictEqual(
        windowsLongPathConfigEnv("win32", count === undefined ? {} : { GIT_CONFIG_COUNT: count }),
        {
          GIT_CONFIG_COUNT: String(next + 1),
          [`GIT_CONFIG_KEY_${next}`]: "core.longpaths",
          [`GIT_CONFIG_VALUE_${next}`]: "true",
        },
        `GIT_CONFIG_COUNT=${JSON.stringify(count)}`,
      );
    }
  });

  // regression: #14917 Windows worktrees with long paths failed or stranded
  it("leaves a count Git would reject for Git to report", () => {
    for (const count of ["nope", "2x", "-1", "1.5", "  ", "1 "]) {
      assert.deepStrictEqual(
        windowsLongPathConfigEnv("win32", { GIT_CONFIG_COUNT: count }),
        {},
        `GIT_CONFIG_COUNT=${JSON.stringify(count)}`,
      );
    }
  });
});
