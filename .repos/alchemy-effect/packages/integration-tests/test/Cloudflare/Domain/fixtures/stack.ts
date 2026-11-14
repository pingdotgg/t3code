import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import DomainScheduleWorker from "./worker.ts";

export default Alchemy.Stack(
  "DomainScheduleStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* DomainScheduleWorker;
    return { url: worker.url.as<string>() };
  }),
);
