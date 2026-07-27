import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { MicrovmBuildRole } from "./build-role.ts";

/**
 * MicroVM image running an eagerly-started opencode server (a real coding
 * agent, ~100 MB binary on a Bun runtime). The Dockerfile's ENTRYPOINT is
 * `opencode serve`; the MicroVM image build runs it and snapshots the running
 * memory+disk, so every `RunMicrovm` resumes from a snapshot where the server
 * is ALREADY listening — the process startup cost is paid once at build time,
 * not on each boot. Compare with the Cloudflare
 * {@link import("./opencode-container.ts").OpencodeContainer}, which starts
 * the same image's entrypoint from scratch on every cold start.
 */
export class OpencodeMicrovm extends AWS.Lambda.MicrovmImage<OpencodeMicrovm>()(
  "MicrovmBenchOpencode",
) {}

export default OpencodeMicrovm.make(
  MicrovmBuildRole.pipe(
    Effect.map((buildRole) => ({
      context: new URL("../contexts/microvm-opencode/", import.meta.url)
        .pathname,
      buildRole,
      // opencode is heavier than the hello-world servers; give it 1 GiB
      // (matching the Cloudflare variant's tier as closely as the two
      // platforms' sizing knobs allow).
      resources: [{ minimumMemoryInMiB: 1024 }],
      cpuConfigurations: [{ architecture: "ARM_64" }],
    })),
  ),
  // Built from the Dockerfile; no Effect program is bundled.
  Effect.succeed({}),
);
