import * as Cloudflare from "alchemy/Cloudflare";

/**
 * Cloudflare-container twin of
 * {@link import("./opencode-image.ts").OpencodeMicrovm}: the same Dockerfile
 * shape (opencode server as the entrypoint), but Cloudflare boots the image
 * from scratch on each cold start — there is no build-time memory snapshot —
 * so opencode's process startup is inside every measured boot.
 *
 * Sized `standard-1` (1/2 vCPU, 4 GiB) — deliberately generous next to the
 * MicroVM's 1 GiB, so a slower container boot can't be blamed on CPU/memory
 * starvation at the `lite` tier.
 */
export class OpencodeContainer extends Cloudflare.Container<OpencodeContainer>()(
  "BenchOpencodeContainer",
  {
    context: `${import.meta.dirname}/../contexts/opencode`,
    maxInstances: 100,
    instanceType: "standard-1",
    instances: 0,
  },
) {}
