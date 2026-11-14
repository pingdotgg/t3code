import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { app } from "../../../../Workflows/conformance/app.ts";
import { WorkflowsLive } from "../../../../Workflows/conformance/workflows.ts";
import { JournalLive } from "./journal.ts";

/** The conformance workflows on Cloudflare Workflows, through NativeEngine. */
export default class NativeEngineWorker extends Cloudflare.Worker<NativeEngineWorker>()(
  "NativeEngineWorker",
  { main: import.meta.url },
  app.pipe(
    Effect.provide(
      WorkflowsLive.pipe(
        Layer.provideMerge(Layer.mergeAll(Cloudflare.Workflows.NativeEngine, JournalLive)),
      ),
    ),
  ),
) {}
