#!/usr/bin/env bun

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import {
  DaytonaClientLive,
  JEVIN_AI_SNAPSHOT_NAME,
  SnapshotService,
  SnapshotServiceLive,
} from "../index";
import { version } from "../../package.json" with { type: "json" };

class SnapshotCommandError extends Data.TaggedError("SnapshotCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") {
      return message;
    }
  }

  return String(error);
}

const replaceFlag = Flag.boolean("replace").pipe(
  Flag.withDescription(`Replace the existing ${JEVIN_AI_SNAPSHOT_NAME} snapshot if it exists.`),
  Flag.optional,
);

const createSnapshotProgram = (replace: boolean) =>
  Effect.gen(function* () {
    const snapshotService = yield* SnapshotService;

    yield* Console.log(`Ensuring Daytona snapshot "${JEVIN_AI_SNAPSHOT_NAME}"...`);

    const snapshot = yield* snapshotService.ensureSnapshot({
      replace,
      activate: true,
      timeoutSeconds: 0,
      onLogs: (chunk) => {
        process.stdout.write(chunk.endsWith("\n") ? chunk : `${chunk}\n`);
      },
    });

    yield* Console.log(`Snapshot ready: ${snapshot.name}`);
    yield* Console.log(`Snapshot id: ${snapshot.id}`);
    yield* Console.log(`Snapshot state: ${snapshot.state}`);
    yield* Console.log(`Snapshot image: ${snapshot.imageName}`);
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.fail(
          new SnapshotCommandError({
            message: formatUnknownError(error),
            cause: error instanceof Error && "cause" in error ? error.cause : undefined,
          }),
        ),
      onSuccess: (value) => Effect.succeed(value),
    }),
  );

const snapshotCommand = Command.make("snapshot", {
  replace: replaceFlag,
}).pipe(
  Command.withDescription("Create or refresh the reusable jevin-ai Daytona snapshot."),
  Command.withHandler((input) =>
    Effect.scoped(createSnapshotProgram(Option.getOrElse(input.replace, () => false))),
  ),
);

Command.run(snapshotCommand, { version }).pipe(
  Effect.provide(SnapshotServiceLive()),
  Effect.provide(DaytonaClientLive()),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
