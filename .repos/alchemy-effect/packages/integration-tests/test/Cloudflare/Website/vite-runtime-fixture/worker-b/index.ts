// `worker-b` of `@cloudflare/vite-plugin`'s `external-durable-objects` and
// `external-workflows` playgrounds: the Durable Object and Workflow another
// Worker binds by script name.
import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

export class Counter extends DurableObject {
  async getCounterValue() {
    return ((await this.ctx.storage.get("value")) as number) || 0;
  }

  async increment(amount = 1) {
    const value = (((await this.ctx.storage.get("value")) as number) || 0) + amount;
    await this.ctx.storage.put("value", value);
    return value;
  }
}

export class MyWorkflow extends WorkflowEntrypoint {
  override async run(_: WorkflowEvent<unknown>, step: WorkflowStep) {
    await step.do("first step", async () => ({ output: "First step result" }));
    await step.sleep("sleep", "1 second");
    await step.do("second step", async () => ({ output: "Second step result" }));
    return "Workflow output";
  }
}

export default {
  fetch() {
    return new Response("ok");
  },
};
