import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import WorkflowTestWorker from "./workflow-worker.ts";

export default Alchemy.Stack(
  "WorkflowBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* WorkflowTestWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
