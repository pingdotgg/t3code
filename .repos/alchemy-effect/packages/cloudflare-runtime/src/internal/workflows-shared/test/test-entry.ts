// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

// Test entry point — re-exports everything from src/index.ts and adds
// a TestWorkflow class that can be bound as USER_WORKFLOW via serviceBindings.
// This allows the workflow entrypoint to survive DO aborts (unlike the old
// setWorkflowEntrypoint pattern which manually mutated instance.env).
//
// NOTE: We extend WorkerEntrypoint (not WorkflowEntrypoint) because workerd
// only recognises WorkerEntrypoint subclasses for service-binding RPC.
// WorkflowEntrypoint is a higher-level abstraction used by the Workflows
// platform; for our test harness the engine just needs a target with a
// callable run() method.

export * from "../index.ts";

type WorkflowCallback = (
  event: unknown,
  step: WorkflowStep,
) => Promise<unknown>;

let __testWorkflowCallback: WorkflowCallback | undefined;

/**
 * Set the workflow callback that TestWorkflow.run() will delegate to.
 * Call this before creating or restarting a workflow instance in tests.
 */
export function setTestWorkflowCallback(
  cb: WorkflowCallback | undefined,
): void {
  __testWorkflowCallback = cb;
}

/**
 * A WorkerEntrypoint subclass for tests that delegates run() to a
 * module-level callback. Configured as the USER_WORKFLOW service binding
 * in vitest.config.ts so it survives DO aborts (unlike manual env injection).
 */
export class TestWorkflow extends WorkerEntrypoint {
  async run(
    event: Readonly<WorkflowEvent<unknown>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    if (!__testWorkflowCallback) {
      throw new Error(
        "TestWorkflow callback not set — call setTestWorkflowCallback() before running the workflow",
      );
    }
    return await __testWorkflowCallback(event, step);
  }
}
