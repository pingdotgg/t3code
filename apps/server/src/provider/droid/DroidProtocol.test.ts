import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  DroidExecuteRewindResult,
  DroidInitializeSessionResult,
  DroidLoadSessionResult,
  DroidModelInfo,
  DroidPermissionRequest,
  DroidSessionNotification,
  DroidSkillInfo,
  knownDroidSessionNotificationTypes,
} from "./DroidProtocol.ts";

const decodeNotification = Schema.decodeUnknownSync(DroidSessionNotification);
const decodePermissionRequest = Schema.decodeUnknownSync(DroidPermissionRequest);
const decodeInitialize = Schema.decodeUnknownSync(DroidInitializeSessionResult);
const decodeLoad = Schema.decodeUnknownSync(DroidLoadSessionResult);
const decodeRewind = Schema.decodeUnknownSync(DroidExecuteRewindResult);
const usage = JSON.parse(
  `{"inputTokens":10,"outputTokens":5,"cacheCreationTokens":1,"cacheReadTokens":2,"thinkingTokens":3}`,
) as Record<string, number>;
const fixtureJson = [
  `{"type":"assistant_text_delta","messageId":"m1","blockIndex":0,"textDelta":"hello"}`,
  `{"type":"assistant_text_complete","messageId":"m1","blockIndex":0}`,
  `{"type":"thinking_text_delta","messageId":"m1","blockIndex":0,"textDelta":"hmm"}`,
  `{"type":"thinking_text_complete","messageId":"m1","blockIndex":0,"durationMs":12}`,
  `{"type":"tool_call","toolUse":{"type":"tool_use","id":"tool-1","input":{"path":"README.md"},"name":"Read"}}`,
  `{"type":"tool_result","messageId":"m1","toolUseId":"tool-1","content":[{"type":"text","text":"contents"}]}`,
  `{"type":"create_message","message":{"id":"m1","role":"assistant"}}`,
  `{"type":"agent_turn_completed","reason":"completed","turnId":"turn-1"}`,
  `{"type":"session_token_usage_changed","sessionId":"s1","lastCallTokenUsage":{"inputTokens":8,"cacheReadTokens":2,"outputTokens":4}}`,
  `{"type":"session_compacted","summaryId":"summary-1","removedCount":12,"visibleBoundaryMessageId":"message-4"}`,
  `{"type":"error","message":"bad","errorType":"SessionError","timestamp":"2026-08-23T00:00:00.000Z"}`,
  `{"type":"llm_retry","attempt":2,"reason":"rate_limited"}`,
  `{"type":"session_title_updated","title":"A useful title","updateType":"llm_generated"}`,
  `{"type":"child_session_available","childSessionId":"child-1","timestamp":123}`,
  `{"type":"structured_output","messageId":"m1","structuredOutput":{"answer":42}}`,
] as const;
const fixtures: ReadonlyArray<readonly [string, Record<string, unknown>]> = fixtureJson.map(
  (json) => {
    const fixture = JSON.parse(json) as Record<string, unknown>;
    if (fixture.type === "agent_turn_completed" || fixture.type === "session_token_usage_changed") {
      fixture.tokenUsage = usage;
    }
    return [String(fixture.type), fixture];
  },
);

describe("DroidSessionNotification", () => {
  it("keeps the known-type guard in parity with every schema member", () => {
    assert.deepStrictEqual(
      [...knownDroidSessionNotificationTypes].sort(),
      [...new Set([...fixtures.map(([type]) => type), "tool_progress_update"])].sort(),
    );
  });

  for (const [type, fixture] of fixtures) {
    it(`decodes ${type}`, () => assert.equal(decodeNotification(fixture).type, type));
  }

  for (const reason of ["future_terminal_reason", "spec_handoff"]) {
    it(`preserves terminal reason ${reason}`, () => {
      const decoded = decodeNotification({
        type: "agent_turn_completed",
        reason,
        turnId: "turn-1",
        tokenUsage: usage,
      });
      assert.equal(decoded.type, "agent_turn_completed");
      if (decoded.type === "agent_turn_completed") assert.equal(decoded.reason, reason);
    });
  }

  it("strips extra fields from known notifications", () => {
    const decoded = decodeNotification({
      type: "assistant_text_delta",
      messageId: "m1",
      blockIndex: 0,
      textDelta: "hello",
      addedByNewerCli: true,
    });
    assert.equal(decoded.type, "assistant_text_delta");
    assert.notProperty(decoded, "addedByNewerCli");
  });

  for (const [name, inputJson, expectedJson, absent] of [
    [
      "attributed",
      `{"type":"tool_progress_update","toolUseId":"tool-1","toolName":"Task","update":{"type":"status","status":"running","text":"Inspecting the repository","subagentSessionId":"child-1","addedByNewerCli":true}}`,
      `{"status":"running","text":"Inspecting the repository","subagentSessionId":"child-1"}`,
      "addedByNewerCli",
    ],
    [
      "unattributed",
      `{"type":"tool_progress_update","toolUseId":"tool-2","toolName":"Execute","update":{"type":"message","details":"Still running","valueSnippet":"line 42"}}`,
      `{"details":"Still running","valueSnippet":"line 42"}`,
      "subagentSessionId",
    ],
  ] as const) {
    it(`decodes ${name} tool progress`, () => {
      const decoded = decodeNotification(JSON.parse(inputJson));
      assert.equal(decoded.type, "tool_progress_update");
      if (decoded.type === "tool_progress_update") {
        assert.deepStrictEqual(decoded.update, JSON.parse(expectedJson));
        assert.notProperty(decoded.update, absent);
      }
    });
  }

  it("decodes valid last-call usage and rejects malformed usage", () => {
    const decoded = decodeNotification(
      fixtures.find(([type]) => type === "session_token_usage_changed")?.[1],
    );
    assert.equal(decoded.type, "session_token_usage_changed");
    if (decoded.type === "session_token_usage_changed") {
      assert.deepStrictEqual(decoded.lastCallTokenUsage, {
        inputTokens: 8,
        cacheReadTokens: 2,
        outputTokens: 4,
      });
    }
    assert.throws(() =>
      decodeNotification({
        type: "session_token_usage_changed",
        sessionId: "s1",
        tokenUsage: usage,
        lastCallTokenUsage: { inputTokens: "invalid", cacheReadTokens: 2 },
      }),
    );
  });
});

it("keeps only adapter-consumed result fields", () => {
  assert.deepStrictEqual(
    decodeInitialize({
      sessionId: "session-1",
      session: "reshaped",
      settings: null,
    }),
    { sessionId: "session-1" },
  );
  assert.deepStrictEqual(
    decodeLoad({
      session: "reshaped",
      settings: null,
      lastCallTokenUsage: { inputTokens: 21, cacheReadTokens: 5, outputTokens: 3 },
    }).lastCallTokenUsage,
    { inputTokens: 21, cacheReadTokens: 5, outputTokens: 3 },
  );
  assert.deepStrictEqual(
    decodeRewind({
      newSessionId: "session-rewound",
      restoredCount: "reshaped",
    }),
    { newSessionId: "session-rewound" },
  );
});

describe("DroidPermissionRequest", () => {
  it("rejects requests with no tool to classify or render", () => {
    assert.throws(() =>
      decodePermissionRequest({
        toolUses: [],
        options: [{ label: "Allow once", value: "proceed_once" }],
      }),
    );
  });

  it("decodes canonical options and only consumed permission details", () => {
    const decoded = decodePermissionRequest({
      toolUses: [
        {
          toolUse: {
            type: "tool_use",
            id: "tool-exec",
            input: { command: "echo hello" },
            name: "Execute",
          },
          confirmationType: "exec",
          details: {
            type: "exec",
            fullCommand: "echo hello",
            command: "echo",
            extractedCommands: "reshaped",
            impactLevel: { future: true },
          },
        },
      ],
      options: [{ label: "Allow once", value: "proceed_once" }],
      associatedSessionIds: "reshaped",
    });
    assert.deepStrictEqual(
      { toolUses: decoded.toolUses, options: decoded.options },
      {
        toolUses: [
          {
            toolUse: { id: "tool-exec", input: { command: "echo hello" }, name: "Execute" },
            details: { type: "exec", fullCommand: "echo hello", command: "echo" },
          },
        ],
        options: [{ label: "Allow once", outcome: "proceed_once" }],
      },
    );
  });
});

for (const [name, schema, fixture] of [
  ["model metadata", DroidModelInfo, { id: "mock-fast", displayName: "Mock Fast" }],
  ["skill location", DroidSkillInfo, { name: "verify", filePath: "/skills/verify/SKILL.md" }],
] as const) {
  it(`requires ${name}`, () => {
    assert.throws(() => Schema.decodeUnknownSync(schema)(fixture));
  });
}
