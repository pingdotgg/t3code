import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { derivePendingRequests } from "./pendingRequests.ts";

let nextActivityId = 0;

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(overrides.id ?? `activity-${nextActivityId++}`),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ? TurnId.make(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("pending approvals", () => {
  it.each([{}, { requestType: "unknown" }])(
    "exposes legacy OpenCode approvals without a known request kind: %j",
    (legacyPayload) => {
      const requested = makeActivity({
        kind: "approval.requested",
        payload: { requestId: "per-legacy", detail: "*", ...legacyPayload },
      });

      expect(derivePendingRequests([requested]).approvals).toEqual([
        {
          requestId: "per-legacy",
          requestKind: "command",
          createdAt: requested.createdAt,
          detail: "*",
        },
      ]);
    },
  );

  it.each(["tool_user_input", "auth_tokens_refresh"])(
    "does not turn %s into an approval",
    (requestType) => {
      const activity = makeActivity({
        kind: "approval.requested",
        payload: { requestId: "not-an-approval", requestType },
      });

      expect(derivePendingRequests([activity]).approvals).toEqual([]);
    },
  );

  it("tracks open approvals and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          detail: "bun run lint",
        },
      }),
      makeActivity({
        id: "approval-close",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: { requestId: "req-2" },
      }),
      makeActivity({
        id: "approval-closed-request",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "approval.requested",
        summary: "File-change approval requested",
        tone: "approval",
        payload: { requestId: "req-2", requestType: "unknown" },
      }),
    ];

    expect(derivePendingRequests(activities).approvals).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
      },
    ]);
  });

  it("maps canonical requestType payloads into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-request-type",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-request-type",
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      }),
    ];

    expect(derivePendingRequests(activities).approvals).toEqual([
      {
        requestId: "req-request-type",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "pwd",
      },
    ]);
  });

  it("keeps app access approvals and persistence choices from remote activities", () => {
    const options = [
      { decision: "decline", label: "Decline" },
      { decision: "acceptAlways", label: "Always allow Safari" },
      { decision: "accept", label: "Approve" },
    ];
    const activities = [
      makeActivity({
        kind: "approval.requested",
        summary: "App access approval requested",
        tone: "approval",
        payload: {
          requestId: "req-safari",
          requestType: "mcp_elicitation_approval",
          detail: "Allow ChatGPT to use Safari?",
          appName: "Safari",
          options,
        },
      }),
    ];

    expect(derivePendingRequests(activities).approvals).toEqual([
      {
        requestId: "req-safari",
        requestKind: "mcp-elicitation",
        createdAt: "2026-02-23T00:00:00.000Z",
        detail: "Allow ChatGPT to use Safari?",
        appName: "Safari",
        options,
      },
    ]);
  });

  it("derives dynamic tool requests as actionable generic approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-dynamic-tool",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Approval requested",
        tone: "approval",
        payload: {
          requestId: "req-dynamic-tool",
          requestType: "dynamic_tool_call",
          detail: "Search the web",
        },
      }),
    ];

    expect(derivePendingRequests(activities).approvals).toEqual([
      {
        requestId: "req-dynamic-tool",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "Search the web",
      },
    ]);
  });

  it("clears stale pending approvals when provider reports unknown pending request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-1",
          requestType: "unknown",
        },
      }),
      makeActivity({
        id: "approval-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-1",
          detail: "Unknown pending permission request: req-stale-1",
        },
      }),
    ];

    expect(derivePendingRequests(activities).approvals).toEqual([]);
  });

  it("clears stale pending approvals when the backend marks them stale after restart", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale-restart",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-restart-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale-restart",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-restart-1",
          detail:
            "Stale pending approval request: req-stale-restart-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingRequests(activities).approvals).toEqual([]);
  });
});

describe("pending questions", () => {
  it("preserves native answer keys while ignoring malformed options", () => {
    const question = {
      id: "  Which path?\n",
      header: " Path ",
      question: "  Which path?\n",
      options: [{ label: " Keep spaces ", description: "", value: " native\t" }],
      multiSelect: false,
    };
    const requested = makeActivity({
      kind: "user-input.requested",
      payload: {
        requestId: "native-question",
        questions: [null, { ...question, options: [...question.options, { label: 42 }] }],
      },
    });

    expect(derivePendingRequests([requested]).userInputs[0]?.questions).toEqual([question]);
  });

  it("keeps free-text questions without suggested answers", () => {
    const question = {
      id: "0",
      header: "Question",
      question: "What should it be named?",
      options: [],
      allowCustomAnswer: true,
      multiSelect: false,
    };
    const activities = [
      makeActivity({
        id: "async-question",
        kind: "user-input.requested",
        summary: "User input requested",
        payload: { requestId: "async-1", responseMode: "message", questions: [question] },
      }),
    ];
    expect(derivePendingRequests(activities).userInputs[0]?.questions).toEqual([question]);
  });

  it("preserves native choice values and the custom-answer restriction", () => {
    const question = {
      id: "interaction-result",
      header: "Result",
      question: "Which result should be used?",
      options: [
        { value: " first\t", label: "Result", description: "First result" },
        { value: "second", label: "Result", description: "Second result" },
      ],
      allowCustomAnswer: false,
      multiSelect: false,
    };
    const activities = [
      makeActivity({
        id: "native-user-input",
        kind: "user-input.requested",
        summary: "User input requested",
        payload: { requestId: "req-native-choice", questions: [question] },
      }),
    ];

    expect(derivePendingRequests(activities).userInputs[0]?.questions).toEqual([question]);
  });

  it("tracks open structured prompts and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
              multiSelect: true,
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-resolved",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          answers: {
            sandbox_mode: "workspace-write",
          },
        },
      }),
      makeActivity({
        id: "user-input-open-2",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          questions: [
            {
              id: "approval",
              header: "Approval",
              question: "Continue?",
              options: [
                {
                  label: "yes",
                  description: "Continue execution",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
    ];

    expect(derivePendingRequests(activities).userInputs).toEqual([
      {
        requestId: "req-user-input-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
            multiSelect: true,
          },
        ],
      },
    ]);
  });

  it("clears stale pending user-input prompts when the provider reports an orphaned request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-stale-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        tone: "error",
        payload: {
          requestId: "req-user-input-stale-1",
          detail:
            "Provider adapter request failed (codex) for item/tool/requestUserInput: Unknown pending Codex user input request: req-user-input-stale-1",
        },
      }),
    ];

    expect(derivePendingRequests(activities).userInputs).toEqual([]);
  });
});

describe.each(["approval", "user-input"])("%s request completion", (requestKind) => {
  const requested = makeActivity({
    id: `${requestKind}-requested`,
    kind: `${requestKind}.requested`,
    sequence: 42,
    payload: {
      requestId: "request-1",
      requestKind: "command",
      questions: [{ id: "answer", header: "Answer", question: "Continue?", options: [] }],
    },
  });

  it.each([`${requestKind}.resolved`, `provider.${requestKind}.respond.failed`])(
    "keeps %s final across reordered and repeated activities",
    (kind) => {
      const closed = makeActivity({
        id: `${requestKind}-closed`,
        kind,
        createdAt: "2026-02-23T00:00:01.000Z",
        payload: {
          requestId: "request-1",
          detail: `Unknown pending ${requestKind} request: request-1`,
        },
      });
      const replayedRequest = { ...requested, id: EventId.make("replayed-request"), sequence: 43 };

      for (const activities of [
        [requested, closed, replayedRequest],
        [closed, requested, replayedRequest],
      ]) {
        expect(derivePendingRequests(activities)).toEqual({ approvals: [], userInputs: [] });
      }
    },
  );

  it("keeps a failed reply retryable unless the text names a stale request", () => {
    const failed = makeActivity({
      kind: `provider.${requestKind}.respond.failed`,
      payload: { requestId: "request-1", detail: "Provider adapter request failed: timeout" },
    });
    const pending = derivePendingRequests([requested, failed]);
    expect(
      [...pending.approvals, ...pending.userInputs].map((request) => request.requestId),
    ).toEqual(["request-1"]);

    const retried = makeActivity({
      kind: `${requestKind}.resolved`,
      payload: { requestId: "request-1" },
    });
    expect(derivePendingRequests([requested, failed, retried, failed])).toEqual({
      approvals: [],
      userInputs: [],
    });
  });
});
