import * as Cloudflare from "@/Cloudflare";
import * as Output from "@/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type { WorkflowEvents } from "./worker.ts";

export type AsyncWorkflowEnv = Cloudflare.InferEnv<typeof AsyncWorkflowWorker>;

export class AsyncWorkflowWorker extends Cloudflare.Worker<AsyncWorkflowWorker>()(
  "AsyncWorkflowWorker",
  {
    main: `${import.meta.dirname}/worker.ts`,
    workersDev: true,
    assets: {
      directory: `${import.meta.dirname}/assets`,
      runWorkerFirst: true,
    },
    env: {
      MY_WORKFLOW: Effect.succeed(
        Cloudflare.Workflow<{ value: string }>("Greeting", {
          className: "MyWorkflow",
        }),
      ),
      EVENTS: Cloudflare.DurableObject<WorkflowEvents>("WorkflowEvents"),
      GREETING: "hello",
      CONFIG: Config.succeed("configured"),
      EFFECT: Effect.succeed("effect"),
      OUTPUT: Output.literal("output"),
    },
  },
) {}
