import type { PermissionRuleset } from "@opencode-ai/sdk/v2";

export {
  OPENCODE_DEFAULT_INSTANCE_ID,
  OPENCODE_PROVIDER,
  OPENCODE_SDK_PROTOCOL,
} from "./server/adapter.ts";
export { OPENCODE_2_STILL_STOPPING, t3McpServerName } from "./server/v2/adapter.ts";

// OpenCode 1.19.4's own rules: a tool whose last rule denies "*" is never
// offered to the model (session/llm/request.ts), and a call to an offered tool
// takes the last match across the session's rules and the server's "always"
// grants (permission/index.ts, util/wildcard.ts).
function openCodeWildcard(input: string, pattern: string) {
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s").test(input);
}

export function openCodeToolDecision(
  rules: PermissionRuleset,
  approved: PermissionRuleset,
  tool: string,
  pattern: string,
) {
  const permission = ["edit", "write", "apply_patch"].includes(tool) ? "edit" : tool;
  const offered = rules.findLast((rule) => openCodeWildcard(permission, rule.permission));
  if (offered?.pattern === "*" && offered.action === "deny") return "hidden";
  return (
    [...rules, ...approved].findLast(
      (rule) =>
        openCodeWildcard(permission, rule.permission) && openCodeWildcard(pattern, rule.pattern),
    )?.action ?? "ask"
  );
}
