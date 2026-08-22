#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import { importThread, threadTransferFlags } from "./thread-transfer.ts";

export const importThreadCommand = Command.make(
  "import-thread",
  {
    archive: Flag.string("archive").pipe(Flag.withDescription("Thread archive JSON to import.")),
    destination: threadTransferFlags.directory("destination"),
    state: threadTransferFlags.state,
    targetProjectId: Flag.string("target-project-id").pipe(
      Flag.optional,
      Flag.withDescription("Project id when it cannot be inferred from the destination path."),
    ),
    dangerousAllowT3Directory: Flag.boolean("dangerous-allow-t3-directory").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Allow importing into the live ~/.t3/userdata database. Stop the T3 server that uses it first.",
      ),
    ),
  },
  ({ archive, destination, state, targetProjectId, dangerousAllowT3Directory }) =>
    Effect.gen(function* () {
      const result = yield* importThread({
        archive,
        destination,
        state,
        targetProjectId: Option.getOrUndefined(targetProjectId),
        dangerousAllowT3Directory,
      });
      yield* Console.log(
        `Imported '${result.title}' (${result.threadId}, orchestrator v${result.orchestrationVersion}) into ${result.targetProjectTitle}`,
      );
      yield* Console.log(
        `  ${result.eventCount} events, ${result.attachmentCount} attachments, ${result.terminalLogCount} terminal logs`,
      );
      yield* Console.log(`  Database backup: ${result.backup}`);
      if (result.droppedWorktreePaths.length > 0) {
        yield* Console.log(
          `  Cleared worktree paths missing here (the thread will use the project workspace): ${result.droppedWorktreePaths.join(", ")}`,
        );
      }
      yield* Console.log(
        "Start the destination T3 server; it rebuilds the thread's read model from the imported events.",
      );
    }),
).pipe(Command.withDescription("Import one T3 thread into an isolated project database."));

if (import.meta.main) {
  Command.run(importThreadCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
