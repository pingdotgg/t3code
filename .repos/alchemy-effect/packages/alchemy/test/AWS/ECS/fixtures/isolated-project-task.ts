import { Task } from "@/AWS/ECS/Task.ts";
import * as Effect from "effect/Effect";
import { isolatedProject } from "../../../IsolatedProject.ts";

/**
 * The isolated consumer project this task is bundled from (see
 * `test/IsolatedProject.ts`): `main` lives outside the repository, so the
 * bundle `cwd` resolves none of alchemy's dependencies — the bun bootstrap's
 * own imports (`@distilled.cloud/aws/*`, `@effect/platform-bun`, …) must be
 * anchored by the bundler, not found by accident from the project root.
 */
export const project = isolatedProject("ecs-task", import.meta.filename);

/**
 * Regression fixture for the generated bun bootstrap's imports: before the
 * virtual-entry plugin anchored them, an isolated project left them
 * `[UNRESOLVED_IMPORT]` / external and the container died at boot with
 * `Cannot find module …`.
 *
 * The `{ run }` impl logs a marker and completes, so a successful boot is
 * observable as the Fargate task stopping with container exit code 0.
 */
export class IsolatedProjectTask extends Task<IsolatedProjectTask>()(
  "EcsIsolatedProjectTask",
) {}

export default IsolatedProjectTask.make(
  {
    main: project.main,
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
    taskName: "alchemy-test-ecs-isolated-project",
  },
  Effect.gen(function* () {
    return {
      // One-shot entry: log the marker and exit 0.
      run: Effect.log("alchemy-isolated-project-ran"),
    };
  }),
);
