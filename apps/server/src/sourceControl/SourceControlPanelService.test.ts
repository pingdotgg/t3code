import { assert, describe, it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { VcsRef } from "@t3tools/contracts";

import {
  SourceControlPanelService,
  layer as SourceControlPanelServiceLayer,
} from "./SourceControlPanelService.ts";
import { GitWorkflowService, type GitWorkflowServiceShape } from "../git/GitWorkflowService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  GitVcsDriver,
  type ExecuteGitInput,
  type ExecuteGitResult,
  type GitVcsDriverShape,
} from "../vcs/GitVcsDriver.ts";

const branchRef: VcsRef = {
  name: "feature/source-control",
  current: false,
  isDefault: false,
  worktreePath: null,
};

const success = (stdout = ""): ExecuteGitResult => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const failure = (stderr: string): ExecuteGitResult => ({
  exitCode: ChildProcessSpawner.ExitCode(1),
  stdout: "",
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
});

function makeTestLayer(
  execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, never>,
) {
  return SourceControlPanelServiceLayer.pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provide(Layer.succeed(GitWorkflowService, {} as GitWorkflowServiceShape)),
    Layer.provide(
      Layer.succeed(GitVcsDriver, {
        execute,
      } as unknown as GitVcsDriverShape),
    ),
  );
}

describe("SourceControlPanelService", () => {
  it.effect("uses the selected branch head for history queries", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.branchCommits({
        cwd: "/repo",
        branch: branchRef,
        baseRef: "main",
        kind: "history",
        skip: 0,
        limit: 10,
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          ["rev-list", "--count", "feature/source-control"],
          [
            "log",
            "--skip=0",
            "--max-count=10",
            "--format=%H%x09%h%x09%an%x09%ae%x09%aI%x09%s",
            "feature/source-control",
          ],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success(input.args[0] === "rev-list" ? "0" : "");
          }),
        ),
      ),
    );
  });

  it.effect("falls back when discarding staged additions missing from HEAD", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.discardFiles({
        cwd: "/repo",
        paths: ["new-file.ts"],
        staged: true,
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          ["restore", "--staged", "--worktree", "--source=HEAD", "--", "new-file.ts"],
          ["reset", "--", "new-file.ts"],
          ["restore", "--worktree", "--", "new-file.ts"],
          ["clean", "-fd", "--", "new-file.ts"],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return input.operation === "vcs.panel.discardStagedFiles"
              ? failure("pathspec 'new-file.ts' did not match any files")
              : success();
          }),
        ),
      ),
    );
  });
});
