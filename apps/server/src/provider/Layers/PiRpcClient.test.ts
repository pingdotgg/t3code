import { describe, expect, it } from "@effect/vitest";
import type { AgentSessionEvent, ModelInfo, RpcResponse } from "@earendil-works/pi-coding-agent";

import {
  asPiThinkingLevel,
  buildPiTurnCommand,
  classifyPiStdoutMessage,
  extractAssistantTextDelta,
  extractAvailableModels,
  extractForkMessages,
  extractLastAssistantText,
  extractReasoningTextDelta,
  extractSessionFile,
  parsePiStdoutLine,
  PI_THINKING_LEVEL_VALUES,
  piForkSucceeded,
  piImageContentFromBytes,
  piModelCapabilities,
  piModelInfoToServerModel,
  piModelSlug,
  piResponseHasCommand,
  piResponseSucceeded,
  planPiModelSwitch,
  resolveForkTargetEntryId,
  resolvePiThinkingLevel,
  splitPiModelSlug,
  tryParsePiJsonObject,
} from "./PiRpcClient.ts";

const asEvent = (value: unknown): AgentSessionEvent => value as AgentSessionEvent;
const asResponse = (value: unknown): RpcResponse => value as RpcResponse;
const asModelInfo = (value: unknown): ModelInfo => value as ModelInfo;
const modelSelectionWithThinking = (value: string | undefined) =>
  ({
    instanceId: "pi",
    model: "openai/gpt-5",
    options: value === undefined ? [] : [{ id: "thinking", value }],
  }) as unknown as Parameters<typeof resolvePiThinkingLevel>[0];

describe("tryParsePiJsonObject", () => {
  it("parses a JSON object line", () => {
    expect(tryParsePiJsonObject('{"type":"response","id":"1"}')).toEqual({
      type: "response",
      id: "1",
    });
  });

  it("ignores blank, non-object, and malformed lines", () => {
    expect(tryParsePiJsonObject("")).toBeNull();
    expect(tryParsePiJsonObject("   ")).toBeNull();
    expect(tryParsePiJsonObject("plain log output")).toBeNull();
    expect(tryParsePiJsonObject("[1,2,3]")).toBeNull();
    expect(tryParsePiJsonObject("{ not json }")).toBeNull();
  });
});

describe("classifyPiStdoutMessage / parsePiStdoutLine", () => {
  it("discriminates a response frame and extracts its correlation id", () => {
    const message = classifyPiStdoutMessage({ type: "response", id: "req-1", success: true });
    expect(message).toMatchObject({ _tag: "response", id: "req-1" });
  });

  it("treats a response without a string id as undefined", () => {
    const message = classifyPiStdoutMessage({ type: "response", success: true });
    expect(message).toMatchObject({ _tag: "response", id: undefined });
  });

  it("discriminates an extension_ui_request frame", () => {
    const message = parsePiStdoutLine(
      '{"type":"extension_ui_request","id":"ui-1","method":"confirm","title":"bash"}',
    );
    expect(message).toMatchObject({ _tag: "extension-ui" });
  });

  it("treats any other typed frame as an agent event", () => {
    const message = parsePiStdoutLine('{"type":"agent_start"}');
    expect(message).toMatchObject({ _tag: "event" });
  });

  it("ignores frames without a usable type discriminator", () => {
    expect(classifyPiStdoutMessage({ id: "x" })).toBeNull();
    expect(classifyPiStdoutMessage({ type: "" })).toBeNull();
    expect(parsePiStdoutLine("not-json")).toBeNull();
  });
});

describe("extractAssistantTextDelta", () => {
  it("returns the delta for a text_delta assistant message", () => {
    expect(
      extractAssistantTextDelta(
        asEvent({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "hello" },
        }),
      ),
    ).toBe("hello");
  });

  it("hides thinking and non-message events", () => {
    expect(
      extractAssistantTextDelta(
        asEvent({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "secret" },
        }),
      ),
    ).toBeNull();
    expect(extractAssistantTextDelta(asEvent({ type: "agent_start" }))).toBeNull();
  });
});

describe("extractReasoningTextDelta", () => {
  it("returns the delta for a thinking_delta assistant message", () => {
    expect(
      extractReasoningTextDelta(
        asEvent({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" },
        }),
      ),
    ).toBe("reasoning");
  });

  it("returns null for text deltas and other events", () => {
    expect(
      extractReasoningTextDelta(
        asEvent({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "hi" },
        }),
      ),
    ).toBeNull();
    expect(extractReasoningTextDelta(asEvent({ type: "turn_start" }))).toBeNull();
  });
});

describe("splitPiModelSlug / piModelSlug", () => {
  it("splits a provider/id slug keeping extra segments in the id", () => {
    expect(splitPiModelSlug("openai/gpt-4o")).toEqual({ provider: "openai", id: "gpt-4o" });
    expect(splitPiModelSlug("openrouter/openai/gpt-4o")).toEqual({
      provider: "openrouter",
      id: "openai/gpt-4o",
    });
  });

  it("returns null when there is no interior separator", () => {
    expect(splitPiModelSlug("gpt-4o")).toBeNull();
    expect(splitPiModelSlug("/gpt-4o")).toBeNull();
    expect(splitPiModelSlug("openai/")).toBeNull();
  });

  it("round-trips a model into its canonical slug", () => {
    expect(piModelSlug({ provider: "anthropic", id: "claude-sonnet-4-6" })).toBe(
      "anthropic/claude-sonnet-4-6",
    );
  });
});

describe("piModelCapabilities", () => {
  it("exposes a thinking descriptor for reasoning models", () => {
    const capabilities = piModelCapabilities(true);
    expect((capabilities.optionDescriptors ?? []).map((descriptor) => descriptor.id)).toContain(
      "thinking",
    );
  });

  it("exposes no option descriptors for non-reasoning models", () => {
    expect(piModelCapabilities(false).optionDescriptors ?? []).toEqual([]);
  });
});

describe("piModelInfoToServerModel", () => {
  it("maps a ModelInfo to a ServerProviderModel with a canonical slug", () => {
    const model = piModelInfoToServerModel(
      asModelInfo({
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        reasoning: true,
      }),
    );
    expect(model.slug).toBe("anthropic/claude-sonnet-4-6");
    expect(model.name).toBe("Claude Sonnet 4.6");
    expect(model.isCustom).toBe(false);
    expect(
      (model.capabilities?.optionDescriptors ?? []).map((descriptor) => descriptor.id),
    ).toContain("thinking");
  });

  it("falls back to the model id when no display name is provided", () => {
    const model = piModelInfoToServerModel(asModelInfo({ provider: "openai", id: "gpt-4o-mini" }));
    expect(model.name).toBe("gpt-4o-mini");
    expect(model.capabilities?.optionDescriptors ?? []).toEqual([]);
  });
});

describe("extractSessionFile", () => {
  it("reads the sessionFile path from a successful get_state response", () => {
    expect(
      extractSessionFile(
        asResponse({ type: "response", success: true, data: { sessionFile: " /tmp/s.json " } }),
      ),
    ).toBe("/tmp/s.json");
  });

  it("returns undefined for missing / unsuccessful / empty responses", () => {
    expect(extractSessionFile(undefined)).toBeUndefined();
    expect(
      extractSessionFile(asResponse({ type: "response", success: false, data: {} })),
    ).toBeUndefined();
    expect(
      extractSessionFile(
        asResponse({ type: "response", success: true, data: { sessionFile: "" } }),
      ),
    ).toBeUndefined();
  });
});

describe("extractAvailableModels", () => {
  it("reads the models array from a successful get_available_models response", () => {
    const models = extractAvailableModels(
      asResponse({
        type: "response",
        success: true,
        data: { models: [{ provider: "openai", id: "gpt-4o" }] },
      }),
    );
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ provider: "openai", id: "gpt-4o" });
  });

  it("returns an empty array for missing / unsuccessful / malformed responses", () => {
    expect(extractAvailableModels(undefined)).toEqual([]);
    expect(extractAvailableModels(asResponse({ type: "response", success: false }))).toEqual([]);
    expect(
      extractAvailableModels(
        asResponse({ type: "response", success: true, data: { models: "nope" } }),
      ),
    ).toEqual([]);
  });
});

describe("piResponseHasCommand", () => {
  const commandsResponse = (names: ReadonlyArray<string>) =>
    asResponse({
      type: "response",
      command: "get_commands",
      success: true,
      data: { commands: names.map((name) => ({ name, source: "extension" })) },
    });

  it("detects a registered command by name", () => {
    expect(
      piResponseHasCommand(commandsResponse(["t3-approval-gate", "other"]), "t3-approval-gate"),
    ).toBe(true);
  });

  it("returns false when the command is absent", () => {
    expect(piResponseHasCommand(commandsResponse(["other"]), "t3-approval-gate")).toBe(false);
  });

  it("returns false for undefined, failed, or non-get_commands responses", () => {
    expect(piResponseHasCommand(undefined, "t3-approval-gate")).toBe(false);
    expect(
      piResponseHasCommand(
        asResponse({ type: "response", command: "get_commands", success: false, error: "boom" }),
        "t3-approval-gate",
      ),
    ).toBe(false);
    expect(
      piResponseHasCommand(
        asResponse({ type: "response", command: "get_state", success: true, data: {} }),
        "t3-approval-gate",
      ),
    ).toBe(false);
  });
});

describe("extractLastAssistantText", () => {
  it("reads the text field from a successful response", () => {
    expect(
      extractLastAssistantText(
        asResponse({
          type: "response",
          command: "get_last_assistant_text",
          success: true,
          data: { text: "hello" },
        }),
      ),
    ).toBe("hello");
  });

  it("returns null for null text, failed, or undefined responses", () => {
    expect(
      extractLastAssistantText(
        asResponse({
          type: "response",
          command: "get_last_assistant_text",
          success: true,
          data: { text: null },
        }),
      ),
    ).toBeNull();
    expect(extractLastAssistantText(undefined)).toBeNull();
    expect(
      extractLastAssistantText(
        asResponse({
          type: "response",
          command: "get_last_assistant_text",
          success: false,
          error: "x",
        }),
      ),
    ).toBeNull();
  });
});

describe("piImageContentFromBytes", () => {
  it("encodes bytes as raw base64 with the given mime type", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(piImageContentFromBytes({ mimeType: "image/png", bytes })).toEqual({
      type: "image",
      data: Buffer.from(bytes).toString("base64"),
      mimeType: "image/png",
    });
  });

  it("produces raw base64, not a data: URL", () => {
    const result = piImageContentFromBytes({
      mimeType: "image/webp",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(result.data.startsWith("data:")).toBe(false);
  });
});

describe("buildPiTurnCommand", () => {
  it("uses steer mid-turn so Pi folds the message into the running turn", () => {
    expect(buildPiTurnCommand({ isMidTurn: true, message: "keep it short" })).toEqual({
      type: "steer",
      message: "keep it short",
    });
  });

  it("uses prompt for a fresh turn", () => {
    expect(buildPiTurnCommand({ isMidTurn: false, message: "start work" })).toEqual({
      type: "prompt",
      message: "start work",
    });
  });

  it("preserves empty messages without switching command type", () => {
    expect(buildPiTurnCommand({ isMidTurn: true, message: "" })).toEqual({
      type: "steer",
      message: "",
    });
  });

  it("attaches images only when the array is non-empty", () => {
    const images = [{ type: "image" as const, data: "AQ==", mimeType: "image/png" }];
    expect(buildPiTurnCommand({ isMidTurn: false, message: "hi", images })).toEqual({
      type: "prompt",
      message: "hi",
      images,
    });
    expect(buildPiTurnCommand({ isMidTurn: false, message: "hi", images: [] })).toEqual({
      type: "prompt",
      message: "hi",
    });
  });
});

describe("asPiThinkingLevel / resolvePiThinkingLevel", () => {
  it("keeps descriptor option ids in sync with the ThinkingLevel set", () => {
    const descriptorIds = (piModelCapabilities(true).optionDescriptors ?? []).flatMap(
      (descriptor) => (descriptor.type === "select" ? descriptor.options.map((o) => o.id) : []),
    );
    expect(descriptorIds).toEqual([...PI_THINKING_LEVEL_VALUES]);
  });

  it("resolves each valid thinking level from a model selection", () => {
    for (const level of PI_THINKING_LEVEL_VALUES) {
      expect(resolvePiThinkingLevel(modelSelectionWithThinking(level))).toBe(level);
      expect(asPiThinkingLevel(level)).toBe(level);
    }
  });

  it("returns undefined when the thinking option is absent or unknown", () => {
    expect(resolvePiThinkingLevel(modelSelectionWithThinking(undefined))).toBeUndefined();
    expect(resolvePiThinkingLevel(undefined)).toBeUndefined();
    expect(resolvePiThinkingLevel(modelSelectionWithThinking("turbo"))).toBeUndefined();
    expect(asPiThinkingLevel(undefined)).toBeUndefined();
    expect(asPiThinkingLevel("")).toBeUndefined();
  });
});

describe("planPiModelSwitch", () => {
  it("is a noop when no model is requested or it matches the current model", () => {
    expect(planPiModelSwitch("openai/gpt-4o", undefined)).toEqual({ kind: "noop" });
    expect(planPiModelSwitch("openai/gpt-4o", "openai/gpt-4o")).toEqual({ kind: "noop" });
  });

  it("plans a switch with split provider/id for a changed slug", () => {
    expect(planPiModelSwitch("openai/gpt-4o", "anthropic/claude-sonnet-4-6")).toEqual({
      kind: "switch",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      slug: "anthropic/claude-sonnet-4-6",
    });
    expect(planPiModelSwitch(undefined, "openrouter/openai/gpt-4o")).toEqual({
      kind: "switch",
      provider: "openrouter",
      modelId: "openai/gpt-4o",
      slug: "openrouter/openai/gpt-4o",
    });
  });

  it("flags a malformed slug as invalid", () => {
    expect(planPiModelSwitch("openai/gpt-4o", "gpt-4o")).toEqual({
      kind: "invalid",
      slug: "gpt-4o",
    });
  });
});

describe("piResponseSucceeded", () => {
  it("is true only for a matching successful response", () => {
    expect(
      piResponseSucceeded(
        asResponse({ type: "response", command: "set_model", success: true, data: {} }),
        "set_model",
      ),
    ).toBe(true);
  });

  it("is false for failed, mismatched-command, non-response, or undefined values", () => {
    expect(
      piResponseSucceeded(
        asResponse({ type: "response", command: "set_model", success: false, error: "no" }),
        "set_model",
      ),
    ).toBe(false);
    expect(
      piResponseSucceeded(
        asResponse({ type: "response", command: "set_thinking_level", success: true }),
        "set_model",
      ),
    ).toBe(false);
    expect(piResponseSucceeded(undefined, "set_model")).toBe(false);
  });
});

describe("extractForkMessages", () => {
  const forkResponse = (messages: unknown) =>
    asResponse({
      type: "response",
      command: "get_fork_messages",
      success: true,
      data: { messages },
    });

  it("reads ordered user fork entries", () => {
    const result = extractForkMessages(
      forkResponse([
        { entryId: "e1", text: "first" },
        { entryId: "e2", text: "second" },
      ]),
    );
    expect(result).toEqual([
      { entryId: "e1", text: "first" },
      { entryId: "e2", text: "second" },
    ]);
  });

  it("defaults missing text to empty string and drops entries without a string entryId", () => {
    const result = extractForkMessages(
      forkResponse([{ entryId: "e1" }, { text: "no id" }, { entryId: 42 }]),
    );
    expect(result).toEqual([{ entryId: "e1", text: "" }]);
  });

  it("distinguishes valid empty history from failed or malformed responses", () => {
    expect(extractForkMessages(forkResponse([]))).toEqual([]);
    expect(extractForkMessages(undefined)).toBeUndefined();
    expect(
      extractForkMessages(
        asResponse({ type: "response", command: "get_fork_messages", success: false, error: "x" }),
      ),
    ).toBeUndefined();
    expect(extractForkMessages(forkResponse("nope"))).toBeUndefined();
  });
});

describe("piForkSucceeded", () => {
  it("is true for success with no cancellation", () => {
    expect(
      piForkSucceeded(
        asResponse({
          type: "response",
          command: "fork",
          success: true,
          data: { text: "x", cancelled: false },
        }),
      ),
    ).toBe(true);
    expect(
      piForkSucceeded(
        asResponse({
          type: "response",
          command: "new_session",
          success: true,
          data: { cancelled: false },
        }),
      ),
    ).toBe(true);
  });

  it("is false when cancelled, failed, or undefined", () => {
    expect(
      piForkSucceeded(
        asResponse({
          type: "response",
          command: "fork",
          success: true,
          data: { text: "", cancelled: true },
        }),
      ),
    ).toBe(false);
    expect(
      piForkSucceeded(
        asResponse({ type: "response", command: "fork", success: false, error: "invalid entry" }),
      ),
    ).toBe(false);
    expect(piForkSucceeded(undefined)).toBe(false);
  });
});

describe("resolveForkTargetEntryId", () => {
  const msgs = (...ids: string[]) => ids.map((entryId) => ({ entryId }));

  it("returns null when there is nothing to roll back", () => {
    expect(resolveForkTargetEntryId([], 3)).toBeNull();
    expect(resolveForkTargetEntryId(msgs("a", "b"), 0)).toBeNull();
    expect(resolveForkTargetEntryId(msgs("a", "b"), -1)).toBeNull();
  });

  it("forks before the (len-numTurns)th user message", () => {
    expect(resolveForkTargetEntryId(msgs("a", "b", "c", "d", "e"), 2)).toEqual({
      kind: "fork",
      entryId: "d",
    });
    expect(resolveForkTargetEntryId(msgs("a", "b", "c", "d"), 1)).toEqual({
      kind: "fork",
      entryId: "d",
    });
  });

  it("resets to an empty session when rolling back to or past the first message", () => {
    expect(resolveForkTargetEntryId(msgs("a", "b", "c"), 3)).toEqual({ kind: "reset" });
    expect(resolveForkTargetEntryId(msgs("a", "b", "c"), 5)).toEqual({ kind: "reset" });
  });
});
