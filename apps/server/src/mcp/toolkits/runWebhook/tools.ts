import { OrchestratorMcpFailure, RunWebhookInput, RunWebhookResult } from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as RunWebhookService from "../../../runWebhooks/RunWebhookService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";

export const RunWebhookToolkit = Toolkit.make(
  Tool.make("t3_run_webhook", {
    description:
      "Outside clients: subscribe a threadId/runId from launch or send to a host-configured endpointId. Signed callbacks report waiting and terminal run states; no wait polling needed. Read, cancel, or retry a failed subscription by subscriptionId. Registration is idempotent, lasts 7 days, and catches an already finished run. Watches this run only, not later turns or delegates. Never pass a URL or secret.",
    parameters: RunWebhookInput,
    success: RunWebhookResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      RunWebhookService.RunWebhookService,
      ThreadManagement.ThreadManagementService,
    ],
  })
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, true)
    .annotate(McpSchema.EnabledWhen, () => {
      const fiber = Fiber.getCurrent();
      const scope =
        fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
      return (
        scope?.client !== undefined &&
        !scope.client.linked &&
        scope.thread === undefined &&
        scope.client.access !== "read-only" &&
        scope.capabilities.has("orchestration")
      );
    }),
);
