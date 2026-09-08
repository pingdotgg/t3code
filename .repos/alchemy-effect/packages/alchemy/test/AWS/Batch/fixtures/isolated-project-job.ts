import * as AWS from "@/AWS";
import * as Effect from "effect/Effect";
import { isolatedProject } from "../../../IsolatedProject.ts";

/**
 * The isolated consumer project this job is bundled from (see
 * `test/IsolatedProject.ts`): `main` lives outside the repository, so the
 * bundle `cwd` resolves none of alchemy's dependencies and the bun
 * bootstrap's own imports must be anchored by the bundler.
 */
export const project = isolatedProject("batch-job", import.meta.filename);

/** Printed by the job body; asserted in the job's `/aws/batch/job` stream. */
export const MARKER = "alchemy-batch-isolated-project-marker";

/**
 * Minimal run-to-completion `AWS.Batch.JobDefinition` bundled from an
 * isolated project. A `SUCCEEDED` job (container exit 0) proves the
 * generated bootstrap booted — with its imports left external bun dies at
 * module load and the job lands in `FAILED`.
 */
export default class IsolatedProjectJob extends AWS.Batch.JobDefinition<IsolatedProjectJob>()(
  "BatchIsolatedProjectJob",
  {
    main: project.main,
    jobDefinitionName: "alchemy-test-batch-isolated-project",
    vcpus: 0.25,
    memory: 512,
    timeout: "10 minutes",
    // Docker Hub's `oven/bun` image; the public.ecr.aws default mirror
    // aggressively rate-limits anonymous pulls (429) during local builds.
    docker: { base: "oven/bun:1" },
  },
  Effect.gen(function* () {
    return {
      run: Effect.gen(function* () {
        // The awslogs driver captures stdout — print the marker for the
        // out-of-band log assertion.
        yield* Effect.sync(() => console.log(MARKER));
      }),
    };
  }),
) {}
