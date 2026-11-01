import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import MyContainerLive from "./container.ts";
import { Storage } from "./storage.ts";
import Worker from "./worker.ts";

export default Alchemy.Stack(
  "EffectfulContainerStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    const storage = yield* Storage;
    // yield* MyContainer.Application

    return {
      url: worker.url.as<string>(),
      bucketName: storage.bucketName,
    };
  }).pipe(Effect.provide(MyContainerLive)),
);
