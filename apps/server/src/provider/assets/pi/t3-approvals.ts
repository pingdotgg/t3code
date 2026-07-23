// Default-deny tool-approval gate, loaded into `pi --mode rpc` via `--extension`.
// Runs in the user's `pi` runtime (types-only import).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "glob"]);
const EDIT_TOOLS = ["write", "edit", "multi_edit", "apply_patch"];

function autoApprovedTools(approvalMode: string | undefined): ReadonlySet<string> {
  const allowed = new Set(READ_ONLY_TOOLS);
  if (approvalMode === "auto-accept-edits") {
    for (const tool of EDIT_TOOLS) allowed.add(tool);
  }
  return allowed;
}

function gateDecision(opts: {
  readonly hasUI: boolean;
  readonly confirmed: boolean;
}): { readonly block: true; readonly reason: string } | undefined {
  if (!opts.hasUI || !opts.confirmed) return { block: true, reason: DENIED_REASON };
  return undefined;
}

// keep in sync with PI_APPROVAL_SENTINEL_COMMAND in PiAdapter.ts
const SENTINEL_COMMAND = "t3-approval-gate";

const DENIED_REASON = "Denied in T3 Code";

function describeToolCall(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) return toolName;
  const command = input["command"] ?? input["cmd"];
  if (typeof command === "string" && command.trim().length > 0) {
    return command.trim().slice(0, 500);
  }
  const filePath = input["file_path"] ?? input["path"] ?? input["filePath"];
  if (typeof filePath === "string" && filePath.trim().length > 0) {
    return filePath.trim().slice(0, 500);
  }
  try {
    return JSON.stringify(input).slice(0, 500);
  } catch {
    return toolName;
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand(SENTINEL_COMMAND, {
    description: "T3 Code approval gate (active)",
    handler: async () => {},
  });

  const allowed = autoApprovedTools(process.env["T3_PI_APPROVAL_MODE"]);

  pi.on("tool_call", async (event, ctx) => {
    if (allowed.has(event.toolName)) {
      return undefined;
    }

    const input = (event as { input?: Record<string, unknown> }).input;
    const detail = describeToolCall(event.toolName, input);
    const confirmed = ctx.hasUI ? await ctx.ui.confirm(`Run ${event.toolName}?`, detail) : false;

    return gateDecision({ hasUI: ctx.hasUI, confirmed });
  });
}

export { autoApprovedTools, describeToolCall, gateDecision };
