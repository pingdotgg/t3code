import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import * as path from "pathe";

export type AsyncWorkflowEnv = Cloudflare.InferEnv<typeof AsyncWorkflowWorker>;

// Async (non-Effect) Worker that hosts a `WorkflowEntrypoint` class and binds
// it through `env` using the props-only `Cloudflare.Workflow` reference form.
export const AsyncWorkflowWorker = Cloudflare.Worker("AsyncWorkflowWorker", {
  main: path.resolve(import.meta.dirname, "worker.ts"),
  url: true,
  env: {
    MY_WORKFLOW: Cloudflare.Workflow<{ value: string }>("MyWorkflow", {
      className: "MyWorkflow",
    }),
  },
});

export default Alchemy.Stack(
  "AsyncWorkflowBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* AsyncWorkflowWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
