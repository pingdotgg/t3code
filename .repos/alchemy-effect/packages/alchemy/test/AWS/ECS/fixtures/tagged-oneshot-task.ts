import { Task } from "@/AWS/ECS/Task.ts";
import * as Effect from "effect/Effect";

/**
 * A one-shot `AWS.ECS.Task` in the TAGGED form: the class declares the task
 * identity, and the default export is `Task.make(props, impl)` — a Layer,
 * not an Effect.
 *
 * This is the regression fixture for the tagged-form ECS bootstrap: the
 * generated container entry imports this module's default export. Before the
 * fix, the bun bootstrap piped the export as an Effect and a Layer export
 * died at boot with "Not a valid effect"; it now folds both forms through
 * `makeEntrypointLayer` (same as the Lambda / Cloudflare Container bridges).
 *
 * The `{ run }` impl logs a marker and completes, so a successful boot is
 * observable as the Fargate task stopping with container exit code 0.
 */
export class TaggedOneShotTask extends Task<TaggedOneShotTask>()(
  "EcsTaggedOneShotTask",
) {}

export default TaggedOneShotTask.make(
  {
    main: import.meta.filename,
    // Docker Hub's `oven/bun`; the public.ecr.aws default mirror rate-limits
    // anonymous pulls during local builds (see fixtures/task.ts).
    image: "oven/bun:1",
    cpu: 256,
    memory: 512,
    // Build/run on ARM64 so an image built on an Apple Silicon host matches
    // the Fargate runtime architecture (Graviton).
    runtimePlatform: {
      cpuArchitecture: "ARM64",
      operatingSystemFamily: "LINUX",
    },
    taskName: "alchemy-test-ecs-tagged-oneshot",
  },
  Effect.gen(function* () {
    return {
      // One-shot entry: log the marker and exit 0.
      run: Effect.log("alchemy-tagged-oneshot-ran"),
    };
  }),
);
