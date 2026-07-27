import * as Cloudflare from "alchemy/Cloudflare";

/**
 * Non-Effect ("remote image") container: Alchemy pulls a pre-built public image
 * and re-pushes it — no Effect program is bundled and no runtime is injected.
 * `mendhak/http-https-echo` serves on port 8080 and writes to its inherited
 * stdout fd directly, so it boots cleanly inside Cloudflare's container sandbox.
 */
export class RemoteContainer extends Cloudflare.Container<RemoteContainer>()(
  "BenchRemoteContainer",
  {
    image: "mendhak/http-https-echo:latest",
    maxInstances: 100,
    instanceType: "lite",
    instances: 0,
  },
) {}
