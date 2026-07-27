import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { AsyncWorkflowEnv } from "./stack.ts";

interface Params {
  value: string;
}

// Plain (non-Effect) Workflow class hosted by an async Worker. Bound to the
// Worker via `env.MY_WORKFLOW` using the props-only `Cloudflare.Workflow`
// reference form — the analogue of binding a class-based Durable Object.
export class MyWorkflow extends WorkflowEntrypoint<AsyncWorkflowEnv, Params> {
  async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep) {
    const greeting = await step.do(
      "greet",
      async () => `Hello, ${event.payload.value}!`,
    );

    await step.sleep("cooldown", "1 second");

    return await step.do("finalize", async () => ({ greeting }));
  }
}

export default {
  async fetch(request: Request, env: AsyncWorkflowEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/workflow/start/")) {
      const value = url.pathname.split("/workflow/start/")[1] ?? "world";
      const instance = await env.MY_WORKFLOW.create({ params: { value } });
      return Response.json({ instanceId: instance.id });
    }

    if (url.pathname.startsWith("/workflow/status/")) {
      const id = url.pathname.split("/workflow/status/")[1] ?? "";
      const instance = await env.MY_WORKFLOW.get(id);
      return Response.json(await instance.status());
    }

    return new Response("ok");
  },
};
