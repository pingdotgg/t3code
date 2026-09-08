import * as Prisma from "@/Prisma";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import ReadCompute from "./read-compute.ts";
import ReadWriteCompute from "./readwrite-compute.ts";
import WriteCompute from "./write-compute.ts";

/**
 * Deploys three Prisma Compute apps that all bind one shared Prisma Object
 * Store bucket — read / write / read-write. Extracted into its own stack file
 * so it can be deployed by the test suite AND inspected directly, e.g.
 *
 * ```sh
 * alchemy tail --stage test ./test/Prisma/fixtures/stack.ts
 * ```
 *
 * State is file-local (`.alchemy/` on the runner) — a Prisma-only suite must
 * not require another cloud's credentials just to store state, and the Prisma
 * Compute live smoke likewise keeps its state out of the cloud. An
 * interrupted run's resources stay reclaimable from the same checkout.
 */
export default Alchemy.Stack(
  "PrismaBucketBindingStack",
  { providers: Prisma.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const read = yield* ReadCompute;
    const write = yield* WriteCompute;
    const readWrite = yield* ReadWriteCompute;
    return {
      read: read.url.as<string>(),
      write: write.url.as<string>(),
      readWrite: readWrite.url.as<string>(),
    };
  }),
);
