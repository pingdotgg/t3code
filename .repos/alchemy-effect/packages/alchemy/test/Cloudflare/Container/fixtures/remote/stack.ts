import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import { EnvBucket, RemoteContainer } from "./object.ts";
import RemoteContainerWorker from "./worker.ts";

export default (state = Cloudflare.state()) =>
  Alchemy.Stack(
    "RemoteContainerStack",
    { providers: Cloudflare.providers(), state },
    Effect.gen(function* () {
      const bucket = yield* EnvBucket;
      const worker = yield* RemoteContainerWorker;
      const app = yield* RemoteContainer.Application;
      return {
        url: worker.url.as<string>(),
        bucketName: bucket.bucketName,
        app,
      };
    }),
  );
