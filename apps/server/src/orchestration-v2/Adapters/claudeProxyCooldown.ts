import type { SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- authenticating the proxy wire protocol requires HMAC and constant-time comparison.
import * as NodeCrypto from "node:crypto";
import { field } from "../unknownField.ts";

const ERROR_PREFIX = "API Error: Request rejected (429) · ";
const MARKER = /^\[\[CPA_PROXY_COOLDOWN_V1:([1-9][0-9]{0,11}):([0-9a-f]{64})\]\] /;

// The MAC authenticates a proxy reevaluation deadline, never a provider quota window.
// Keep these bytes in sync with CLIProxyAPI's authenticated cooldown response.
function verifyCooldown(text: string, token: string) {
  if (!token || !text.startsWith(ERROR_PREFIX)) return undefined;
  const match = MARKER.exec(text.slice(ERROR_PREFIX.length));
  if (!match || Number(match[1]) > 253402300799) return undefined;
  const expected = NodeCrypto.createHmac("sha256", token)
    .update(`CLIProxyAPI/T3/proxy_cooldown/v1\nnext_reevaluation_at=${match[1]}\n`)
    .digest();
  if (!NodeCrypto.timingSafeEqual(expected, Buffer.from(match[2]!, "hex"))) return undefined;
  return {
    epoch: Number(match[1]),
    clean: ERROR_PREFIX + text.slice(ERROR_PREFIX.length + match[0].length),
  };
}

/** Request signed metadata only when the same resolved key is available for verification. */
export function claudeProxyCooldownEnvironment(environment: NodeJS.ProcessEnv | undefined) {
  if (!environment?.ANTHROPIC_AUTH_TOKEN) return environment;
  const headers = environment.ANTHROPIC_CUSTOM_HEADERS ?? "";
  // Preserve explicit header choices and every unrelated custom header byte.
  if (headers.split("\n").some((line) => /^\s*x-cliproxyapi-cooldown-metadata\s*:/i.test(line))) {
    return environment;
  }
  return {
    ...environment,
    ANTHROPIC_CUSTOM_HEADERS: `${headers}${headers && !headers.endsWith("\n") ? "\n" : ""}X-CLIProxyAPI-Cooldown-Metadata: signed-v1`,
  };
}

/** Query-local translation; only the matching root terminal error can arm recovery. */
export function makeClaudeProxyCooldownBridge(
  token: string,
  now: () => number,
  randomUUID: () => `${string}-${string}-${string}-${string}-${string}` = NodeCrypto.randomUUID,
) {
  let pending: { epoch: number; original: string; sessionId: string } | undefined;
  const cleanTexts = new Map<string, string>();
  return (message: SDKMessage): ReadonlyArray<SDKMessage> => {
    if (
      field(message, "parent_tool_use_id") != null ||
      field(message, "isSidechain") ||
      field(message, "is_sidechain")
    ) {
      return [message];
    }
    if (message.type === "assistant") {
      pending = undefined;
      const content = message.message.content;
      if (message.error === "rate_limit" && content.length === 1 && content[0]?.type === "text") {
        const original = content[0].text;
        const verified = verifyCooldown(original, token);
        if (verified) {
          cleanTexts.set(original, verified.clean);
          if (
            verified.epoch * 1000 > now() &&
            typeof message.session_id === "string" &&
            message.session_id.length > 0
          ) {
            pending = { epoch: verified.epoch, original, sessionId: message.session_id };
          }
          return [
            {
              ...message,
              message: { ...message.message, content: [{ ...content[0], text: verified.clean }] },
            },
          ];
        }
      }
    }
    if (message.type !== "result") return [message];
    const output: SDKMessage[] = [];
    const result = field(message, "result");
    if (
      pending &&
      pending.epoch * 1000 > now() &&
      message.is_error === true &&
      message.session_id === pending.sessionId &&
      result === pending.original
    ) {
      output.push({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: pending.epoch,
          // T3 tracks extension window names; the SDK only types native subscription windows.
          rateLimitType: "proxy_cooldown" as NonNullable<SDKRateLimitInfo["rateLimitType"]>,
        },
        uuid: randomUUID(),
        session_id: message.session_id,
      });
    }
    let cleaned = message;
    if (typeof result === "string" && cleanTexts.has(result)) {
      const cleanedResult = { result: cleanTexts.get(result)! };
      cleaned = { ...cleaned, ...cleanedResult };
    }
    if ("errors" in cleaned) {
      cleaned = { ...cleaned, errors: cleaned.errors.map((text) => cleanTexts.get(text) ?? text) };
    }
    output.push(cleaned);
    pending = undefined;
    cleanTexts.clear();
    return output;
  };
}
