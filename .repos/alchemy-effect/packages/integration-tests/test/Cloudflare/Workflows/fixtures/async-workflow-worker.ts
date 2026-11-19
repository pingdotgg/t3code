import type { Workflow } from "@cloudflare/workers-types";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

interface Env {
  EXISTING_WORKFLOW: Workflow<{ value: string }>;
  WORKFLOW_NAME?: string;
}

export class ExistingWorkflow extends WorkflowEntrypoint<Env, { value: string }> {
  async run(event: Readonly<WorkflowEvent<{ value: string }>>, step: WorkflowStep) {
    return step.do("greet", async () => ({
      greeting: `Hello, ${event.payload.value}!`,
      workflowName: event.workflowName,
      instanceId: event.instanceId,
    }));
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    if (path === "/workflow/name") {
      return new Response(env.WORKFLOW_NAME);
    }
    if (path.startsWith("/workflow/start/")) {
      const instance = await env.EXISTING_WORKFLOW.create({
        params: { value: "world" },
      });
      return Response.json({ instanceId: instance.id });
    }
    if (path.startsWith("/workflow/status/")) {
      const instance = await env.EXISTING_WORKFLOW.get(path.split("/").pop()!);
      return Response.json(await instance.status());
    }
    return new Response("ok");
  },
};
