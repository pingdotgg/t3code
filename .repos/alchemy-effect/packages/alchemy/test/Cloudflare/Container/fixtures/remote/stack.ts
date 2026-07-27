import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import RemoteContainerWorker from "./worker.ts";

export default Alchemy.Stack(
  "RemoteContainerStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* RemoteContainerWorker;
    return { url: worker.url.as<string>() };
  }),
);
