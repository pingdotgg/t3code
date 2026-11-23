import { OrchestratorMcpFailure, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as CuaDriver from "./cuaDriver.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  CuaDriver.CuaDriver,
];

export const CuCallInput = Schema.Struct({
  tool: TrimmedNonEmptyString.check(Schema.isMaxLength(128)).annotate({
    description:
      "Cua Driver tool name: permissions_status, describe (pass args.tool), list_apps, list_windows, get_window_state, run_steps, click, set_value, type_text, press_key, hotkey, invoke_menu, scroll, drag, launch_app, verify_state, start_session, end_session, etc.",
  }),
  args: Schema.optional(
    Schema.Record(Schema.String, Schema.Unknown).annotate({
      description: "JSON arguments object piped to cua-driver on stdin.",
    }),
  ),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(120_000)).annotate({
      description: "Default 30000, max 120000.",
    }),
  ),
});
export type CuCallInput = typeof CuCallInput.Type;

export const CuCallResult = Schema.Struct({
  result: Schema.Unknown,
  screenshotPath: Schema.optional(Schema.String),
});

export const CuRequestFillInput = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
    description: "What the user types, e.g. '1Password master password'.",
  }),
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(500)).annotate({
    description: "Why it is needed, shown on the card.",
  }),
  appName: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  mode: Schema.optional(
    Schema.Literals(["type_text", "set_value"]).annotate({
      description: "Default 'type_text'; use 'set_value' for native AX fields that support it.",
    }),
  ),
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  window_id: Schema.optional(Schema.Int),
  element_token: Schema.optional(TrimmedNonEmptyString),
  x: Schema.optional(Schema.Finite),
  y: Schema.optional(Schema.Finite),
  delivery_mode: Schema.optional(Schema.Literals(["background", "foreground"])),
  session: Schema.optional(TrimmedNonEmptyString),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0))
      .check(Schema.isLessThanOrEqualTo(3_600_000))
      .annotate({
        description: "How long to wait for the user. Default 10 minutes.",
      }),
  ),
  clientRequestId: Schema.optional(TrimmedNonEmptyString),
});
export type CuRequestFillInput = typeof CuRequestFillInput.Type;

export const CuRequestFillResult = Schema.Struct({
  status: Schema.Literals(["filled", "declined", "cancelled", "timed_out", "fill_failed"]),
  note: Schema.optional(Schema.NullOr(Schema.String)),
});

const CuCallTool = Tool.make("cu_call", {
  description:
    "Drive native macOS desktop apps via Cua Driver when shell, files, and preview_* are insufficient. Prefer background delivery (default), reuse one unique session label across calls, and call end_session when done. For passwords, usernames, or 2FA codes, use cu_request_fill instead of type_text/set_value. For web pages, use preview_*.",
  parameters: CuCallInput,
  success: CuCallResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Control macOS desktop app")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const CuRequestFillTool = Tool.make("cu_request_fill", {
  description:
    "Ask the user to type one field value (password, username, or 2FA code) in a secure T3 card; T3 pipes it straight into the targeted macOS app field via Cua Driver stdin without the agent seeing it or writing it to disk. Target the field from get_window_state (pid + element_token, or pid + window_id + x/y). Fill one field per call; submit afterwards.",
  parameters: CuRequestFillInput,
  success: CuRequestFillResult,
  failure: OrchestratorMcpFailure,
  dependencies: [...dependencies, OrchestratorMcpService.OrchestratorMcpService],
})
  .annotate(Tool.Title, "Ask the user to fill a desktop app field")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const CuToolkit = Toolkit.make(CuCallTool, CuRequestFillTool);
