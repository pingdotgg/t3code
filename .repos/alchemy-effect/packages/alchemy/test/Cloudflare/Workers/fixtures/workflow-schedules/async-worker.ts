import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

/**
 * File-based fixture for the #1473 native Workflow schedules regression on
 * the async (props-only) binding form. The Worker source is stable; the
 * test supplies `schedules` on the `env` Workflow ref so create → update →
 * clear can reuse this file. Inline `script` is not a fixture and is
 * unsupported under `alchemy dev`.
 */
export class HourlyWorkflow extends WorkflowEntrypoint {
  async run(_event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep) {
    return await step.do("noop", async () => "ok");
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("ok");
  },
};
