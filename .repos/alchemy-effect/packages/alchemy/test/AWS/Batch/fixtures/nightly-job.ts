import * as AWS from "@/AWS";
import * as Effect from "effect/Effect";

/**
 * Marker printed by the job body; the e2e test asserts it appears in the
 * job's `/aws/batch/job` log stream, proving the bundled Effect actually ran
 * to completion inside the Batch container.
 */
export const MARKER = "alchemy-batch-platform-marker";

/**
 * End-to-end fixture for the Effect-native `AWS.Batch.JobDefinition` form: an
 * inline run-to-completion Effect bundled + containerized + pushed to a
 * managed ECR repository and registered as a Batch job definition. The
 * container runs the `run` Effect and exits 0 (job `SUCCEEDED`).
 */
export default class NightlyJob extends AWS.Batch.JobDefinition<NightlyJob>()(
  "BatchE2ENightlyJob",
  {
    main: import.meta.filename,
    jobDefinitionName: "alchemy-test-batch-platform-e2e",
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
        yield* Effect.log("nightly job body complete");
      }),
    };
  }),
) {}
