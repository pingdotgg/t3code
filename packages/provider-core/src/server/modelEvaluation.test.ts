import { expect, it } from "vite-plus/test";
import {
  ComposerContextId,
  MessageId,
  type ModelEvaluationVerdict,
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationMessageContext,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
  type BlindModelEvaluationPacket,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  buildModelEvaluationEvidence,
  buildModelEvaluationPrompt,
  validateModelEvaluationVerdict,
} from "./modelEvaluation.ts";

const threadId = ThreadId.make("private-thread-id");
const runId = RunId.make("private-run-id");
const run = {
  id: runId,
  threadId,
  userMessageId: MessageId.make("request"),
  modelSelection: {
    instanceId: ProviderInstanceId.make("private-provider"),
    model: "DeepSeek/solver.v2+local",
  },
  providerInstanceId: ProviderInstanceId.make("private-provider"),
  status: "completed" as const,
};
const now = DateTime.makeUnsafe("2026-01-02T00:00:00Z");

function message(
  role: "user" | "assistant",
  id: string,
  text: string,
): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(id),
    threadId,
    runId,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
    createdBy: "user",
    creationSource: "web",
  };
}

function itemBase(id: string, ordinal: number) {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: NodeId.make("private-node-id"),
    providerThreadId: ProviderThreadId.make("private-provider-thread-id"),
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: "DeepSeek provider label",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
}

function fixture() {
  const messages = [
    message("user", "request", "DeepSeek, use solver.v2+local to repair the parser and verify it."),
    message(
      "assistant",
      "result",
      "I am DeepSeek/solver.v2+local in private-thread-id/private-run-id, session private-provider-thread-id. The parser is repaired. All tests passed. Previously I used Claude Sonnet, Haiku, and Opus.",
    ),
  ];
  const turnItems: OrchestrationV2TurnItem[] = [
    {
      ...itemBase("request", 1),
      type: "user_message",
      messageId: messages[0]!.id,
      text: "",
      textOmitted: true,
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "web",
    },
    {
      ...itemBase("command", 2),
      type: "command_execution",
      input: "run tests",
      output: "2 tests failed",
      exitCode: 1,
      outputIndicatesFailure: true,
    },
    {
      ...itemBase("tool", 3),
      type: "dynamic_tool",
      toolName: "private-provider-tool",
      input: { model: "DeepSeek", query: "inspect parser" },
      output: {
        provider: "hidden-provider",
        usage: { tokens: 999 },
        sessionValid: false,
        totalCost: 12,
        durationMs: 40,
        result: "solver.v2+LOCAL reported failure",
      },
    },
    {
      ...itemBase("thought", 4),
      type: "reasoning",
      text: "hidden chain of thought",
      streaming: false,
    },
    {
      ...itemBase("final", 5),
      type: "assistant_message",
      messageId: messages[1]!.id,
      text: "",
      textOmitted: true,
      streaming: false,
    },
  ];
  return {
    run,
    messages,
    turnItems,
    identityAliases: ["solver.v2+local", "hidden-provider", "private-provider"],
  };
}

function verdict(): ModelEvaluationVerdict {
  return {
    outcome: "scored",
    taskCategory: "debugging",
    confidence: "medium",
    scores: { taskCompletion: 2, correctness: null, instructionFollowing: 2, verification: 0 },
    rationale: { text: "Tests failed despite the final claim.", citations: ["E1", "E3"] },
    strengths: [],
    weaknesses: [{ text: "Misreported the test result.", citations: ["E1", "E3"] }],
    promptAdvice: [],
  };
}

it("separates identities from evidence and preserves tool outcomes and task data", () => {
  const result = buildModelEvaluationEvidence(fixture())!;
  const prompt = buildModelEvaluationPrompt(result.packet).prompt;
  for (const identity of [
    "DeepSeek",
    "solver.v2",
    "private-provider",
    "private-thread",
    "private-run",
    "private-node",
    "hidden-provider",
    "hidden chain of thought",
    "Sonnet",
    "Haiku",
    "Opus",
  ]) {
    expect(prompt.toLowerCase()).not.toContain(identity.toLowerCase());
  }
  expect(prompt).toContain('"taskCategory"');
  expect(prompt).toContain('"scores"');
  expect(prompt).toContain('"additionalProperties":false');
  expect(prompt).toContain("2 tests failed");
  expect(prompt).toContain('\\"exitCode\\":1');
  expect(result.packet.evidence.map((entry) => entry.ref)).toEqual(["E1", "E2", "E3"]);
  expect(result.sourceMessageIds).toEqual([MessageId.make("request"), MessageId.make("result")]);
  expect(validateModelEvaluationVerdict(verdict(), result.packet)).toBe(true);
  expect(JSON.parse(result.packet.evidence[1]!.text)).toMatchObject({
    status: "completed",
    output: {
      provider: "[identity removed]",
      usage: { tokens: 999 },
      sessionValid: false,
      totalCost: 12,
      durationMs: 40,
    },
  });
  const glued = fixture();
  const gluedEvidence = buildModelEvaluationEvidence({
    ...glued,
    turnItems: [
      ...glued.turnItems,
      {
        ...itemBase("glued", 4),
        type: "command_execution",
        input: "cat notes.txt",
        output: "done\nClaude wrote this\r\n\tOpus too\nQwen3, Llama3.1, gpt-oss and GPT answered",
        exitCode: 0,
      },
      {
        ...itemBase("patch", 4),
        type: "file_change",
        fileName: "notes.txt",
        diffStr: "+first\n+Gemini and Grok4 wrote this\n+Google and Kimi built me",
      },
    ],
  })!;
  const family = fixture();
  const familyEvidence = buildModelEvaluationEvidence({
    ...family,
    run: { ...run, modelSelection: { ...run.modelSelection, model: "vexel-9/zorn-pro" } },
    messages: [
      family.messages[0]!,
      {
        ...family.messages[1]!,
        text: "Zorn from Vexel Labs fixed it.\nagentId: a1b2 (use SendMessage with to: 'a1b2' to continue this agent)\n<usage>subagent_tokens: 28485\nduration_ms: 1824</usage>",
      },
    ],
  })!;
  expect(JSON.stringify(familyEvidence.packet).toLowerCase()).not.toMatch(
    /zorn|vexel|sendmessage|28485|subagent_tokens/,
  );
  const gluedPrompt = buildModelEvaluationPrompt(gluedEvidence.packet).prompt.toLowerCase();
  for (const name of ["claude", "opus", "qwen", "llama", "gpt", "gemini", "grok", "google", "kimi"])
    expect(gluedPrompt).not.toContain(name);
  expect(gluedPrompt).toContain("wrote this");
  const input = fixture();
  const failedEdit = buildModelEvaluationEvidence({
    ...input,
    turnItems: [
      ...input.turnItems,
      {
        ...itemBase("failed-edit", 4),
        type: "file_change",
        status: "failed",
        fileName: "parser.ts",
        oldStr: "return null;",
        newStr: "return parse(value);",
      },
    ],
  })!;
  expect(
    JSON.parse(failedEdit.packet.evidence.find((entry) => entry.kind === "file_change")!.text),
  ).toMatchObject({ status: "failed", before: "return null;", after: "return parse(value);" });
});

it("keeps canonical requests without a run id and bounded prior context for followups", () => {
  const input = fixture();
  input.messages[0] = { ...input.messages[0]!, runId: null, text: "Fix those." };
  const earlier = {
    ...message("user", "prior", "Please repair the DeepSeek parser integration."),
    runId: RunId.make("prior-run"),
    createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
  };
  const later = {
    ...message("user", "later", "Future private instruction"),
    runId: RunId.make("later-run"),
    createdAt: DateTime.makeUnsafe("2026-01-03T00:00:00Z"),
  };
  const result = buildModelEvaluationEvidence({
    ...input,
    messages: [...input.messages, later, earlier],
  })!;
  expect(result.packet.request.text).toBe("Fix those.");
  expect(result.packet.context).toEqual([
    { ref: "C1", kind: "user", text: "Please repair the [identity removed] parser integration." },
  ]);
  expect(result.sourceMessageIds).toContain(MessageId.make("prior"));
  expect(JSON.stringify(result.packet)).not.toContain("Future private");
});

it("bounds the entire evidence packet, retains the final result, and labels truncation", () => {
  const input = fixture();
  input.messages[0] = { ...input.messages[0]!, text: "😀".repeat(8_000) };
  input.messages[1] = { ...input.messages[1]!, text: "😀".repeat(8_000) + "FINAL RESULT" };
  const turnItems = Array.from({ length: 100 }, (_, index): OrchestrationV2TurnItem => ({
    ...itemBase(`tool-${index}`, index + 2),
    type: "command_execution",
    input: "check",
    output: index === 99 ? "2 tests passed. FINAL COMMAND RESULT" : "x".repeat(10_000),
    exitCode: 0,
  }));
  const result = buildModelEvaluationEvidence({ ...input, turnItems })!;
  expect(result.metrics.evidenceChars).toBeLessThanOrEqual(24_000);
  expect(result.packet.truncated).toBe(true);
  expect(result.packet.omittedItems).toBeGreaterThan(0);
  expect(result.packet.evidence.at(-2)?.text).toContain("FINAL COMMAND RESULT");
  expect(result.packet.evidence.at(-1)?.text).toContain("FINAL RESULT");
  expect(result.packet.request.text.isWellFormed()).toBe(true);
  expect(result.packet.evidence.at(-1)?.text.isWellFormed()).toBe(true);
  expect(validateModelEvaluationVerdict({ ...verdict(), confidence: "high" }, result.packet)).toBe(
    false,
  );
});

it("abstains when there is no finalized outcome and rejects fabricated citations or invalid scores", () => {
  const input = fixture();
  expect(
    buildModelEvaluationEvidence({
      ...input,
      messages: [input.messages[0]!],
      turnItems: input.turnItems.filter((item) => item.type !== "assistant_message"),
      run: { ...run, status: "interrupted" },
    }),
  ).toBeNull();
  expect(
    buildModelEvaluationEvidence({
      ...input,
      turnItems: input.turnItems.filter((item) => item.type !== "assistant_message"),
      run: { ...run, status: "failed" },
    }),
  ).toBeNull();
  expect(
    buildModelEvaluationEvidence({ ...input, run: { ...run, status: "rolled_back" } }),
  ).toBeNull();
  const packet: BlindModelEvaluationPacket = buildModelEvaluationEvidence(input)!.packet;
  expect(
    validateModelEvaluationVerdict(
      { ...verdict(), rationale: { text: "Made up evidence", citations: ["E999"] } },
      packet,
    ),
  ).toBe(false);
  expect(
    validateModelEvaluationVerdict({ ...verdict(), outcome: "insufficient_evidence" }, packet),
  ).toBe(false);
  for (const invalid of [
    null,
    {},
    {
      ...verdict(),
      scores: { ...verdict().scores, correctness: 4.5 },
    },
  ]) {
    expect(validateModelEvaluationVerdict(invalid, packet)).toBe(false);
  }
  const extraTopLevelField = { ...verdict(), model: "Invented attribution" };
  expect(validateModelEvaluationVerdict(extraTopLevelField, packet)).toBe(false);
  const extraNestedField = {
    ...verdict(),
    rationale: { ...verdict().rationale, command: "Change orchestration settings" },
  };
  expect(validateModelEvaluationVerdict(extraNestedField, packet)).toBe(false);
  expect(
    validateModelEvaluationVerdict(
      {
        ...verdict(),
        outcome: "insufficient_evidence",
        confidence: "low",
        scores: {
          taskCompletion: null,
          correctness: null,
          instructionFollowing: null,
          verification: null,
        },
        rationale: { text: "The evidence does not establish an outcome.", citations: [] },
        weaknesses: [],
      },
      packet,
    ),
  ).toBe(true);
});

it.each([
  "request",
  "request-item",
  "earlier-context",
  "interleaved-user",
  "empty-context",
] as const)("marks omitted composer artifacts from %s", (scenario) => {
  const source = fixture();
  const context: OrchestrationMessageContext = {
    version: 1,
    records:
      scenario === "empty-context"
        ? []
        : [
            {
              version: 1,
              contextId: ComposerContextId.make("terminal-log"),
              label: "Test output",
              kind: "terminal",
              terminalId: "terminal",
              terminalLabel: "Tests",
              lineStart: 1,
              lineEnd: 2,
              text: "Error: expected success but got failure",
            },
          ],
  };
  const request = source.messages[0]!;
  const requestItem = source.turnItems[0]!;
  if (requestItem.type !== "user_message") throw new Error("Expected request item");
  if (scenario === "request-item") {
    source.messages.shift();
    const { textOmitted: _textOmitted, ...inlineItem } = requestItem;
    source.turnItems[0] = { ...inlineItem, text: request.text, context };
  } else if (scenario === "earlier-context") {
    source.messages.unshift({
      ...request,
      id: MessageId.make("earlier-request"),
      runId: null,
      createdAt: DateTime.makeUnsafe("2026-01-01T23:59:59Z"),
      context,
    });
  } else if (scenario === "interleaved-user") {
    const followup = { ...request, id: MessageId.make("followup"), context };
    source.messages.push(followup);
    source.turnItems[3] = {
      ...requestItem,
      id: TurnItemId.make("followup-item"),
      messageId: followup.id,
      ordinal: 4,
    };
  } else {
    source.messages[0] = { ...request, context };
  }
  const packet = buildModelEvaluationEvidence(source)!.packet;
  expect(packet.missingArtifacts).toBe(scenario !== "empty-context");
  expect(validateModelEvaluationVerdict({ ...verdict(), confidence: "high" }, packet)).toBe(
    scenario === "empty-context",
  );
});
