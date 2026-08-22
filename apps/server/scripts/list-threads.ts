#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import { listThreads, ThreadListing, threadTransferFlags } from "./thread-transfer.ts";

const oneLine = (value: string) => value.replaceAll(/[\r\n\t]+/g, " ");
const encodeListing = Schema.encodeEffect(fromJsonStringPretty(ThreadListing));

export const listThreadsCommand = Command.make(
  "list-threads",
  {
    source: threadTransferFlags.directory("source"),
    state: threadTransferFlags.state,
    json: Flag.boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the complete thread list as JSON."),
    ),
  },
  ({ source, state, json }) =>
    Effect.gen(function* () {
      const listing = yield* listThreads({ source, state });
      if (json) {
        yield* Console.log(yield* encodeListing(listing));
        return;
      }
      if (listing.projects.length === 0) {
        yield* Console.log("No projects found.");
      } else {
        yield* Console.log("PROJECT_ID\tWORKSPACE\tTITLE");
        for (const project of listing.projects) {
          yield* Console.log(
            `${project.id}\t${oneLine(project.workspaceRoot)}\t${oneLine(project.title)}`,
          );
        }
      }
      yield* Console.log("");
      if (listing.threads.length === 0) {
        yield* Console.log("No threads found.");
        return;
      }
      yield* Console.log("THREAD_ID\tVERSION\tPROJECT_ID\tTITLE");
      for (const thread of listing.threads) {
        yield* Console.log(
          `${thread.id}\tv${thread.orchestrationVersion}\t${thread.projectId}\t${oneLine(thread.title)}`,
        );
      }
    }),
).pipe(Command.withDescription("List the projects and threads stored in a T3 state directory."));

if (import.meta.main) {
  Command.run(listThreadsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
