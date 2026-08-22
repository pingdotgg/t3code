#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import { importThread, ThreadTransferState } from "./thread-transfer.ts";

export const importThreadCommand = Command.make(
  "import-thread",
  {
    archive: Flag.string("archive").pipe(Flag.withDescription("Thread archive JSON to import.")),
    destination: Flag.string("destination").pipe(
      Flag.withDescription("Workspace root, T3 base directory, or direct state directory."),
    ),
    state: Flag.choice("state", ThreadTransferState.literals).pipe(
      Flag.withDefault("userdata"),
      Flag.withDescription("State directory below the T3 base directory; defaults to userdata."),
    ),
    targetProjectId: Flag.string("target-project-id").pipe(
      Flag.optional,
      Flag.withDescription("Project id when it cannot be inferred from the destination path."),
    ),
  },
  ({ archive, destination, state, targetProjectId }) =>
    Effect.gen(function* () {
      const result = yield* importThread({
        archive,
        destination,
        state,
        targetProjectId: Option.getOrUndefined(targetProjectId),
      });
      yield* Console.log(
        `Imported '${result.title}' (${result.threadId}, orchestrator v${result.orchestrationVersion}) into ${result.targetProjectTitle}`,
      );
      yield* Console.log(
        `  ${result.eventCount} events, ${result.attachmentCount} attachments, ${result.terminalLogCount} terminal logs`,
      );
      yield* Console.log(`  Database backup: ${result.backup}`);
      yield* Console.log(
        "Restart the destination T3 server so its projector reads the new events.",
      );
    }),
).pipe(Command.withDescription("Import one T3 thread into an isolated project database."));

if (import.meta.main) {
  Command.run(importThreadCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
