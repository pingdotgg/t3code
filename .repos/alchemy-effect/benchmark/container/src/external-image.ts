import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { MicrovmBuildRole } from "./build-role.ts";

/**
 * Non-Effect ("external") MicroVM image — built server-side from a plain
 * Dockerfile (a tiny Python HTTP server on :8080). No Effect program is
 * bundled and no in-VM runtime is injected; it is the AWS analog of the
 * Cloudflare `bun`/`remote` container variants.
 */
export class ExternalMicrovm extends AWS.Lambda.MicrovmImage<ExternalMicrovm>()(
  "MicrovmBenchExternal",
) {}

export default ExternalMicrovm.make(
  MicrovmBuildRole.pipe(
    Effect.map((buildRole) => ({
      context: new URL("../contexts/microvm-python/", import.meta.url).pathname,
      buildRole,
      // Pin memory to match the effectful image so both fit the per-account
      // MicroVM memory quota at the benchmark's concurrency. Keep the default
      // x86_64 arch — forcing ARM_64 breaks the Python image build.
      resources: [{ minimumMemoryInMiB: 512 }],
    })),
  ),
  // External mode builds from the Dockerfile; there is no Effect runtime to
  // bundle, so the impl shape is empty.
  Effect.succeed({}),
);
