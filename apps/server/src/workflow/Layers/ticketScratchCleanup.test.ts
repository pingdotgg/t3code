import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { MergeGitPort } from "../Services/TicketMergeService.ts";
import { MergeGitPortLive } from "./TicketMergeService.ts";
import { cleanupTicketScratch } from "./ticketScratchCleanup.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-ticket-scratch-cleanup-test-",
});

const TestLayer = MergeGitPortLive.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const writeTextFile = (cwd: string, relativePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

/** Init a real git repo that does NOT gitignore `.t3`, with one committed file. */
const initRepo = (cwd: string) =>
  Effect.gen(function* () {
    const git = yield* MergeGitPort;
    yield* git.run({ cwd, args: ["init"] });
    yield* git.run({ cwd, args: ["config", "user.email", "test@test.com"] });
    yield* git.run({ cwd, args: ["config", "user.name", "Test"] });
    // NB: intentionally no .gitignore for `.t3`, so the scratch leak is real.
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git.run({ cwd, args: ["add", "-A"] });
    yield* git.run({ cwd, args: ["commit", "--no-verify", "-m", "initial"] });
  });

it.layer(TestLayer)("cleanupTicketScratch (real git)", (it) => {
  it.effect("purges the whole .t3/ticket/<id> scratch tree from a snapshot commit", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const git = yield* MergeGitPort;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ticket-scratch-cleanup-",
      });
      yield* initRepo(cwd);

      const ticketId = "ticket-1";
      // A real tracked change that MUST survive the cleanup + snapshot.
      yield* writeTextFile(cwd, "src/app.ts", "export const x = 1;\n");
      // Pipeline scratch under .t3/ticket/<id> that MUST be purged.
      yield* writeTextFile(cwd, `.t3/ticket/${ticketId}/DESCRIPTION.md`, "# desc\n");
      yield* writeTextFile(cwd, `.t3/ticket/${ticketId}/handoff/x.md`, "handoff\n");
      yield* writeTextFile(cwd, `.t3/ticket/${ticketId}/design/SPEC.md`, "spec\n");

      yield* cleanupTicketScratch(git, cwd, ticketId);

      // Mirror the service: stage + commit the post-cleanup worktree.
      yield* git.run({ cwd, args: ["add", "-A"] });
      yield* git.run({ cwd, args: ["commit", "--no-verify", "-m", "snapshot"] });

      const tracked = (yield* git.run({
        cwd,
        args: ["ls-tree", "-r", "--name-only", "HEAD"],
      })).stdout;
      assert.include(tracked, "src/app.ts");
      assert.notInclude(tracked, ".t3/ticket/ticket-1/");
    }),
  );

  it.effect("purges ignored .t3 scratch from disk when the repo gitignores .t3", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const git = yield* MergeGitPort;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ticket-scratch-cleanup-ignored-",
      });
      yield* git.run({ cwd, args: ["init"] });
      yield* git.run({ cwd, args: ["config", "user.email", "test@test.com"] });
      yield* git.run({ cwd, args: ["config", "user.name", "Test"] });
      // This repo DOES gitignore `.t3` — so the scratch is untracked-AND-ignored,
      // which `git clean -f -d` (without -x) would leave on disk.
      yield* writeTextFile(cwd, ".gitignore", ".t3\n");
      yield* writeTextFile(cwd, "README.md", "# test\n");
      yield* git.run({ cwd, args: ["add", "-A"] });
      yield* git.run({ cwd, args: ["commit", "--no-verify", "-m", "initial"] });

      const ticketId = "ticket-1";
      yield* writeTextFile(cwd, `.t3/ticket/${ticketId}/DESCRIPTION.md`, "# desc\n");
      yield* writeTextFile(cwd, `.t3/ticket/${ticketId}/handoff/x.md`, "handoff\n");

      yield* cleanupTicketScratch(git, cwd, ticketId);

      // The -x flag removes the ignored scratch from DISK, not just the index.
      const descExists = yield* fileSystem.exists(
        pathService.join(cwd, `.t3/ticket/${ticketId}/DESCRIPTION.md`),
      );
      const handoffExists = yield* fileSystem.exists(
        pathService.join(cwd, `.t3/ticket/${ticketId}/handoff/x.md`),
      );
      assert.isFalse(descExists);
      assert.isFalse(handoffExists);
    }),
  );
});
