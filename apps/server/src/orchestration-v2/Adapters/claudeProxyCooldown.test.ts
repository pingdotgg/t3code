import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- deterministic protocol fixtures sign synthetic credentials.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  claudeProxyCooldownEnvironment,
  makeClaudeProxyCooldownBridge,
} from "./claudeProxyCooldown.ts";

const TOKEN = "synthetic-downstream-key";
const NOW = 1_800_000_000;
const PREFIX = "API Error: Request rejected (429) · ";
const CLEAN = `${PREFIX}next proxy reevaluation; capacity not guaranteed`;
const sign = (epoch = String(NOW + 60), token = TOKEN) => {
  const mac = NodeCrypto.createHmac("sha256", token)
    .update(`CLIProxyAPI/T3/proxy_cooldown/v1\nnext_reevaluation_at=${epoch}\n`)
    .digest("hex");
  return `${PREFIX}[[CPA_PROXY_COOLDOWN_V1:${epoch}:${mac}]] ${CLEAN.slice(PREFIX.length)}`;
};
// Fixtures include the CLI's terminal error fields, which are wider than the SDK declarations.
const frame = (value: object) => value as SDKMessage;
const assistant = (text = sign(), extras = {}) =>
  frame({
    type: "assistant",
    error: "rate_limit",
    session_id: "root",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text }] },
    ...extras,
  });
const result = (text = sign(), extras = {}) =>
  frame({
    type: "result",
    subtype: "success",
    is_error: true,
    session_id: "root",
    result: text,
    ...extras,
  });
const bridge = (token = TOKEN, now = () => NOW * 1000) =>
  makeClaudeProxyCooldownBridge(token, now, () => NodeCrypto.randomUUID());

describe("authenticated Claude proxy cooldown", () => {
  it("cleans the authenticated error and emits one adjacent standard event at the terminal result", () => {
    const transform = bridge();
    expect(transform(assistant())).toEqual([assistant(CLEAN)]);
    const output = transform(result(sign(), { errors: [sign(), "unchanged"] }));
    expect(output).toHaveLength(2);
    expect(output[0]).toMatchObject({
      type: "rate_limit_event",
      session_id: "root",
      rate_limit_info: { status: "rejected", resetsAt: NOW + 60, rateLimitType: "proxy_cooldown" },
    });
    expect(Reflect.get(output[0]!, "uuid")).toMatch(/^[0-9a-f-]{36}$/);
    expect(output[1]).toEqual(result(CLEAN, { errors: [CLEAN, "unchanged"] }));
    expect(transform(result())).toEqual([result()]);
  });

  it("accepts the independently generated Python HMAC vector", () => {
    const text = `${PREFIX}[[CPA_PROXY_COOLDOWN_V1:1800000060:f80e36a6ed8a13164e5126bb944f82d86102f807c4f01d98e3a353f7d0167fc2]] ${CLEAN.slice(PREFIX.length)}`;
    const transform = bridge();
    transform(assistant(text));
    expect(transform(result(text))).toHaveLength(2);
  });

  it.each(["", "other-token"])("refuses missing or mismatched authentication (%s)", (token) => {
    const transform = bridge(token);
    const message = assistant();
    expect(transform(message)).toEqual([message]);
    expect(transform(result())).toHaveLength(1);
  });

  it.each(["01800000060", "+1800000060", "1.8e9", "0", "253402300800", "9999999999999"])(
    "refuses a signed noncanonical or unrepresentable epoch %s",
    (epoch) => {
      const transform = bridge();
      const text = sign(epoch);
      expect(transform(assistant(text))).toEqual([assistant(text)]);
      expect(transform(result(text))).toEqual([result(text)]);
    },
  );

  it.each([
    CLEAN,
    `quoted ${sign()}`,
    sign().replace("(429)", "(500)"),
    sign().replace("CPA_PROXY_COOLDOWN_V1", "CPA_PROXY_COOLDOWN_V2"),
    sign().replace(/:[0-9a-f]{64}/, `:${"0".repeat(64)}`),
  ])("leaves generic and forged upstream text unchanged", (text) => {
    const transform = bridge();
    expect(transform(assistant(text))).toEqual([assistant(text)]);
    expect(transform(result(text))).toEqual([result(text)]);
  });

  it("cleans stale authenticated metadata without arming a reset", () => {
    const transform = bridge();
    const text = sign(String(NOW));
    expect(transform(assistant(text))).toEqual([assistant(CLEAN)]);
    expect(transform(result(text))).toEqual([result(CLEAN)]);
  });

  it("rechecks expiration at terminal completion", () => {
    let clock = NOW * 1000;
    const transform = bridge(TOKEN, () => clock);
    transform(assistant());
    clock += 60_000;
    expect(transform(result())).toEqual([result(CLEAN)]);
  });

  it.each([{ parent_tool_use_id: "nested" }, { isSidechain: true }, { is_sidechain: true }])(
    "keeps nested frames out of root state (%j)",
    (extras) => {
      const transform = bridge();
      expect(transform(assistant(sign(), extras))).toEqual([assistant(sign(), extras)]);
      expect(transform(result())).toHaveLength(1);
      transform(assistant());
      expect(transform(result(sign(), extras))).toEqual([result(sign(), extras)]);
      expect(transform(result())).toHaveLength(2);
    },
  );

  it.each([
    { session_id: "other" },
    { session_id: "" },
    { is_error: false },
    { result: "other error" },
  ])("requires the matching terminal error and clears state on refusal (%j)", (extras) => {
    const transform = bridge();
    transform(assistant());
    expect(transform(result(sign(), extras))).toHaveLength(1);
    expect(transform(result())).toHaveLength(1);
  });

  it.each([
    assistant(CLEAN),
    assistant(sign("1800000060", "forged")),
    assistant(sign(String(NOW))),
  ])("lets every new root assistant invalidate pending recovery", (message) => {
    const transform = bridge();
    transform(assistant());
    transform(message);
    expect(transform(result())).toHaveLength(1);
  });

  it("requires a nonempty root session and a single error text block", () => {
    for (const message of [
      assistant(sign(), { session_id: "" }),
      assistant(sign(), { session_id: undefined }),
      assistant(sign(), { session_id: 7 }),
      assistant(sign(), { error: undefined }),
      assistant(sign(), {
        message: {
          content: [
            { type: "text", text: sign() },
            { type: "text", text: "extra" },
          ],
        },
      }),
    ]) {
      const transform = bridge();
      transform(message);
      expect(transform(result())).toHaveLength(1);
    }
  });

  it("preserves native events and isolates repeated terminal turns", () => {
    const transform = bridge();
    const native = frame({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
    });
    expect(transform(native)[0]).toBe(native);
    for (const epoch of [NOW + 60, NOW + 120]) {
      const text = sign(String(epoch));
      transform(assistant(text));
      expect(transform(result(text))[0]).toMatchObject({ rate_limit_info: { resetsAt: epoch } });
    }
    expect(transform(result())).toEqual([result()]);
    expect(bridge()(result())).toEqual([result()]);
  });
});

describe("Claude proxy metadata opt-in", () => {
  it("does not discover credentials or opt in without a resolved bearer token", () => {
    expect(claudeProxyCooldownEnvironment(undefined)).toBeUndefined();
    const env = { ANTHROPIC_API_KEY: "synthetic-key", ANTHROPIC_AUTH_TOKEN: "" };
    expect(claudeProxyCooldownEnvironment(env)).toBe(env);
  });

  it.each(["", "X-Unrelated: synthetic", "X-One: a\r\nX-Two: b\r\n"])(
    "preserves existing headers while adding the signed-v1 opt-in (%j)",
    (headers) => {
      const env = { ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_CUSTOM_HEADERS: headers, OTHER: "keep" };
      const output = claudeProxyCooldownEnvironment(env)!;
      expect(output.ANTHROPIC_CUSTOM_HEADERS).toBe(
        `${headers}${headers && !headers.endsWith("\n") ? "\n" : ""}X-CLIProxyAPI-Cooldown-Metadata: signed-v1`,
      );
      expect(output.OTHER).toBe("keep");
      expect(output.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN);
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(headers);
    },
  );

  it.each(["signed-v1", "disabled"])(
    "respects an explicit existing opt-in header (%s)",
    (value) => {
      const env = {
        ANTHROPIC_AUTH_TOKEN: TOKEN,
        ANTHROPIC_CUSTOM_HEADERS: `x-cliproxyapi-cooldown-metadata: ${value}`,
      };
      expect(claudeProxyCooldownEnvironment(env)).toBe(env);
    },
  );
});
