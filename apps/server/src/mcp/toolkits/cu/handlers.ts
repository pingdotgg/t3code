import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as CuaDriver from "./cuaDriver.ts";
import { CuToolkit } from "./tools.ts";

const requireMacOs = Effect.gen(function* () {
  const driver = yield* CuaDriver.CuaDriver;
  if (driver.platform !== "darwin") {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Desktop computer use (cu_call / cu_request_fill) is supported only on macOS.",
    });
  }
  return driver;
});

const handlers = {
  cu_call: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const driver = yield* requireMacOs;
      const args = input.args ?? {};
      const saveScreenshot = args["include_screenshot"] === true;
      return yield* driver.call(input.tool, args, {
        timeoutMs: input.timeoutMs,
        saveScreenshot,
      });
    }),
  ),
  cu_request_fill: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const driver = yield* requireMacOs;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const hasToken = input.element_token !== undefined;
      const hasCoords = input.x !== undefined && input.y !== undefined;
      if (!hasToken && !hasCoords) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Provide either element_token or both x and y coordinates to target the field before asking the user.",
        });
      }
      if (input.mode === "set_value" && !hasToken) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "mode='set_value' requires element_token from get_window_state.",
        });
      }
      const reason =
        input.appName !== undefined ? `${input.appName}: ${input.reason}` : input.reason;
      const answer = yield* service.requestBrowserValue(scope, {
        label: input.label,
        reason,
        toolName: "cu_request_fill",
        timeoutMs: input.timeoutMs,
        clientRequestId: input.clientRequestId,
      });
      if (answer.status !== "saved") {
        return { status: answer.status, note: answer.note };
      }

      const mode = input.mode ?? "type_text";
      const targetPayload: Record<string, unknown> = {
        pid: input.pid,
        ...(input.window_id === undefined ? {} : { window_id: input.window_id }),
        ...(input.element_token === undefined ? {} : { element_token: input.element_token }),
        ...(input.x === undefined ? {} : { x: input.x }),
        ...(input.y === undefined ? {} : { y: input.y }),
        ...(input.delivery_mode === undefined ? {} : { delivery_mode: input.delivery_mode }),
        ...(input.session === undefined ? {} : { session: input.session }),
        ...(mode === "set_value"
          ? { value: Redacted.value(answer.value) }
          : { text: Redacted.value(answer.value) }),
      };

      // The secret flows only into cua-driver stdin; never echo it in failures.
      const filled = yield* driver.call(mode, targetPayload).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      return filled
        ? { status: "filled" as const }
        : {
            status: "fill_failed" as const,
            note: "Cua Driver could not fill the targeted field (it may have changed or rejected synthetic input), and the value was dropped. Re-read the window state before retrying with a new clientRequestId.",
          };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof CuToolkit.tools>;

export const layer = McpToolAccess.toLayer(CuToolkit, handlers);
