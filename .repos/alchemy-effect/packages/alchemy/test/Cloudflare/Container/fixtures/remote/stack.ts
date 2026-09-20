import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import { EnvBucket, RemoteContainer } from "./object.ts";
import RemoteContainerWorker from "./worker.ts";

export default Alchemy.Stack(
  "RemoteContainerStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const bucket = yield* EnvBucket;
    const worker = yield* RemoteContainerWorker;
    const app = yield* RemoteContainer.Application;
    return { url: worker.url.as<string>(), bucketName: bucket.bucketName, app };
  }),
);
