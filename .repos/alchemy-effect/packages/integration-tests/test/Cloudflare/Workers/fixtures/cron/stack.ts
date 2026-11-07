import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
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
      workerName: worker.workerName,
      url: worker.url.as<string>(),
      crons: worker.crons,
    };
  }),
);
