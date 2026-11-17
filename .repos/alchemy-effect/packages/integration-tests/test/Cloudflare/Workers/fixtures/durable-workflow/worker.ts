import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { app } from "../../../../Workflows/conformance/app.ts";
import { WorkflowsLive } from "../../../../Workflows/conformance/workflows.ts";
import { JournalLive } from "./journal.ts";

/** The conformance workflows on Durable Objects. */
export default class DurableWorkflowWorker extends Cloudflare.Worker<DurableWorkflowWorker>()(
  "DurableWorkflowWorker",
  { main: import.meta.url },
  app.pipe(
    Effect.provide(
      WorkflowsLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(Cloudflare.Workflows.layerDurableObjectEngine(), JournalLive),
        ),
      ),
    ),
  ),
) {}
