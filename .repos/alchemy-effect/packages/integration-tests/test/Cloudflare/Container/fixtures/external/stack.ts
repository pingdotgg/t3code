import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import ExternalContainerWorker from "./worker.ts";

export default (state = Cloudflare.state()) =>
  Alchemy.Stack(
    "ExternalContainerStack",
    { providers: Cloudflare.providers(), state },
    Effect.gen(function* () {
      const worker = yield* ExternalContainerWorker;
      return { url: worker.url.as<string>() };
    }),
  );
