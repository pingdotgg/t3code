import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import AlarmCallbackWorker from "./worker.ts";

export default (state = Cloudflare.state()) =>
  Alchemy.Stack(
    "AlarmCallbackStack",
    { providers: Cloudflare.providers(), state },
    Effect.gen(function* () {
      const worker = yield* AlarmCallbackWorker;
      return { url: worker.url.as<string>() };
    }),
  );
