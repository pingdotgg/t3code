import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import CronTestWorker from "./cron-worker.ts";

export default Alchemy.Stack(
  "CronEventSourceStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* CronTestWorker;
    return {
      url: worker.url.as<string>(),
      crons: worker.crons,
    };
  }),
);
