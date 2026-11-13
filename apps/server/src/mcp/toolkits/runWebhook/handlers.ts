import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as RunWebhookService from "../../../runWebhooks/RunWebhookService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { RunWebhookToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(RunWebhookToolkit, {
  t3_run_webhook: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("orchestration").pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "Orchestration access is required.",
            }),
        ),
      );
      if (!scope.client || scope.client.linked || scope.thread)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Run webhooks require an outside MCP client on this environment.",
        });
      const service = yield* RunWebhookService.RunWebhookService;
      return yield* service
        .manage(
          scope.client.sessionId,
          input,
          input.action === "subscribe"
            ? McpInvocationContext.threadLinkFor(scope, input.threadId)
            : undefined,
        )
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: error.reason === "forbidden" ? "capability_denied" : "invalid_request",
                message: error.message,
              }),
          ),
        );
    }),
  ),
});
