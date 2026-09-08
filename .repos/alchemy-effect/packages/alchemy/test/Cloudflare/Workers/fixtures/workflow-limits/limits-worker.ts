import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import LimitsWorkflow from "./limits-workflow.ts";

export default class LimitsWorkflowWorker extends Cloudflare.Worker<LimitsWorkflowWorker>()(
  "LimitsWorkflowWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    // Registering the workflow is what drives `putWorkflow` with the limit.
    yield* LimitsWorkflow;

    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}
