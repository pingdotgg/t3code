// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { VcsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../../config.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { TicketCheckpointService } from "../Services/TicketCheckpointService.ts";
import { TicketDiffQuery } from "../Services/TicketDiffQuery.ts";
import { TicketCheckpointServiceLive } from "./TicketCheckpointService.ts";
import { TicketDiffQueryLive, WorktreeDiffPortLive } from "./TicketDiffQuery.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-ticket-diff-test-",
});
const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer));
const GitVcsDriverTestLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

const layer = it.layer(
  TicketDiffQueryLive.pipe(
    Layer.provideMerge(WorktreeDiffPortLive),
    Layer.provideMerge(TicketCheckpointServiceLive),
    Layer.provideMerge(CheckpointStore.layer),
    Layer.provideMerge(GitVcsDriverTestLayer),
    Layer.provideMerge(VcsDriverTestLayer),
    Layer.provideMerge(VcsProcessTestLayer),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const makeTmpDir = (
  prefix = "ticket-diff-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const writeTextFile = (
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "TicketDiffQuery.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(NodePath.join(cwd, "README.md"), "# original\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });

layer("TicketDiffQuery", (it) => {
  it.effect("returns accumulated base-to-worktree diff for tracked and untracked files", () =>
    Effect.gen(function* () {
      const tmp = yield* makeTmpDir();
      yield* initRepoWithCommit(tmp);
      const checkpointService = yield* TicketCheckpointService;
      const query = yield* TicketDiffQuery;
      const ticketId = "t-1" as never;

      const baseRef = yield* checkpointService.captureBaseline(ticketId, tmp);
      yield* writeTextFile(NodePath.join(tmp, "README.md"), "# changed\n");
      yield* writeTextFile(NodePath.join(tmp, "notes.txt"), "new note\n");

      const diff = yield* query.getTicketDiff(ticketId, tmp, baseRef);

      assert.equal(diff.ticketId, ticketId);
      assert.equal(diff.baseRef, baseRef);
      assert.equal(diff.truncated, false);
      assert.include(diff.patch, "diff --git");
      assert.include(diff.patch, "README.md");
      assert.include(diff.patch, "notes.txt");
      assert.deepEqual(
        new Map(diff.files.map((file) => [file.path, file])),
        new Map([
          ["README.md", { path: "README.md", additions: 1, deletions: 1 }],
          ["notes.txt", { path: "notes.txt", additions: 1, deletions: 0 }],
        ]),
      );
    }),
  );
});
