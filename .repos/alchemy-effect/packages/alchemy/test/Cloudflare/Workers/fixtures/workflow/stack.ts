import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
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
