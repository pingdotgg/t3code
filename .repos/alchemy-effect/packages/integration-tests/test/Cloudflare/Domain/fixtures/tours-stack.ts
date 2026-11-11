import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import DomainToursWorker from "./tours-worker.ts";

export default Alchemy.Stack(
  "DomainViewKeyStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* DomainToursWorker;
    return { url: worker.url.as<string>() };
  }),
);
