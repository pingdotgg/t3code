import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import ScheduledWorkflow from "./scheduled-workflow.ts";

export default class ScheduledWorkflowWorker extends Cloudflare.Worker<ScheduledWorkflowWorker>()(
  "ScheduledWorkflowWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    // Registering the workflow is what drives `putWorkflow` with schedules.
    yield* ScheduledWorkflow;

    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}
