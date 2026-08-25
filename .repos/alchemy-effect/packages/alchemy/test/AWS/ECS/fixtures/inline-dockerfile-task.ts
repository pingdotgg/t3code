import { Task } from "@/AWS/ECS/Task.ts";
import * as Dockerfile from "@/Docker/Dockerfile.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * A one-shot `AWS.ECS.Task` whose ENVIRONMENT is inline Dockerfile content
 * (`Dockerfile.inline`) composed with a bundled `main` program.
 *
 * The inline content carries its own `FROM` plus a `RUN` that bakes a marker
 * file into an image layer; the bundled `{ run }` program then reads that
 * file back at container runtime and exits non-zero if it is missing or
 * wrong. A Fargate exit code of 0 therefore proves BOTH halves of the
 * composition: the inline content replaced the generated `FROM` preamble
 * (the `RUN` executed during the build), and the Effect bundle was layered
 * on top of that environment (the program ran inside it).
 */
export class InlineDockerfileTask extends Task<InlineDockerfileTask>()(
  "EcsInlineDockerfileTask",
) {}

export default InlineDockerfileTask.make(
  {
    main: import.meta.filename,
    dockerfile: Dockerfile.inline`
FROM oven/bun:1
RUN echo inline-env-artifact > /inline-artifact.txt
`,
    cpu: 256,
    memory: 512,
    // Build/run on ARM64 so an image built on an Apple Silicon host matches
    // the Fargate runtime architecture (Graviton).
    runtimePlatform: {
      cpuArchitecture: "ARM64",
      operatingSystemFamily: "LINUX",
    },
    taskName: "alchemy-test-ecs-inline-dockerfile",
  },
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return {
      run: Effect.gen(function* () {
        const artifact = yield* fs.readFileString("/inline-artifact.txt");
        if (artifact.trim() !== "inline-env-artifact") {
          return yield* Effect.die(
            new Error(`unexpected artifact content: ${artifact}`),
          );
        }
        yield* Effect.log("alchemy-inline-dockerfile-artifact-ok");
      }).pipe(Effect.orDie),
    };
  }),
);
