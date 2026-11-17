import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { state } from "../remote/local-stack.ts";
import FuseContainerWorker from "./worker.ts";

/**
 * Dev-only stack whose container mounts a FUSE filesystem. Shares
 * `LocalContainer.test.ts`'s in-memory state under its own stack name and
 * fixture identity.
 */

export default Alchemy.Stack(
  "FuseContainerStack",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const worker = yield* FuseContainerWorker;
    return { url: worker.url.as<string>() };
  }),
);
