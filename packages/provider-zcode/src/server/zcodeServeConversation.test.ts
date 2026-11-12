import { assert, describe, it } from "@effect/vitest";

import {
  applyConversationPayload,
  initialConversationState,
  interactionAnswer,
  type ZcodeConversationState,
} from "./zcodeServeConversation.ts";

const deltas = (state: ZcodeConversationState, entries: ReadonlyArray<unknown>) =>
  applyConversationPayload(state, { kind: "deltas", deltas: entries });

describe("applyConversationPayload", () => {
  it("seeds config, rows, and streamed text from a snapshot", () => {
    const state = initialConversationState();
    const events = applyConversationPayload(state, {
      kind: "snapshot",
      snapshot: {
        revision: 3,
        config: {
          modelSelection: {
            providerId: "account:zai-individual-coding-plan",
            modelId: "GLM-5.3",
          },
          thought: "max",
          thoughtLevels: ["low", "high", "max"],
        },
        control: {
          phase: "draft",
          activeWorks: [{ kind: "primaryTurn", foregroundExecutionId: "runtime_command_1" }],
        },
        rows: {
          window: [
            { rowId: 1, kind: "turnHeader", state: "running" },
            {
              rowId: 2,
              kind: "assistantText",
              assistantResponseId: "msg_a",
              text: "earlier",
              state: "complete",
            },
          ],
          totalCount: 2,
          firstRowId: 1,
        },
        pendingInteractions: [],
      },
    });

    assert.equal(state.revision, 3);
    assert.deepEqual(state.modelSelection, {
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-5.3",
    });
    assert.deepEqual(state.thoughtLevels, ["low", "high", "max"]);
    assert.equal(state.thoughtLevel, "max");
    assert.equal(state.phase, "draft");
    assert.equal(state.foregroundExecutionId, "runtime_command_1");
    assert.equal(state.lastAssistantText, "earlier");
    assert.deepEqual(events, [
      {
        type: "model.streaming",
        payload: {
          assistantMessageId: "msg_a",
          delta: "earlier",
          kind: "text_delta",
          done: true,
        },
      },
    ]);
  });

  it("replays snapshot rows silently when subscribed for history", () => {
    const state = initialConversationState();
    const events = applyConversationPayload(
      state,
      {
        kind: "snapshot",
        snapshot: {
          revision: 1,
          rows: {
            window: [
              { rowId: 1, kind: "assistantText", assistantResponseId: "msg_a", text: "old" },
            ],
          },
        },
      },
      { seedRows: true },
    );
    assert.deepEqual(events, []);
    assert.equal(state.lastAssistantText, "old");
  });

  it("streams text deltas and completes the turn with the last assistant text", () => {
    const state = initialConversationState();

    assert.deepEqual(
      deltas(state, [
        {
          op: "state.updated",
          patch: {
            revision: 1,
            control: {
              phase: "running",
              activeWorks: [{ kind: "primaryTurn", foregroundExecutionId: "runtime_command_4" }],
            },
          },
        },
      ]),
      [{ type: "turn.started", payload: {} }],
    );
    assert.equal(state.foregroundExecutionId, "runtime_command_4");

    assert.deepEqual(
      deltas(state, [
        {
          op: "row.appended",
          row: {
            rowId: 6,
            kind: "assistantText",
            assistantResponseId: "msg_b",
            text: "",
            state: "streaming",
          },
        },
      ]),
      [],
    );

    assert.deepEqual(deltas(state, [{ op: "row.delta", rowId: 6, append: "do" }]), [
      {
        type: "model.streaming",
        payload: { assistantMessageId: "msg_b", delta: "do", kind: "text_delta" },
      },
    ]);

    // The finishing upsert carries the whole text; only the suffix is new.
    assert.deepEqual(
      deltas(state, [
        {
          op: "row.upserted",
          row: {
            rowId: 6,
            kind: "assistantText",
            assistantResponseId: "msg_b",
            text: "done",
            state: "complete",
          },
        },
        { op: "row.upserted", row: { rowId: 1, kind: "turnHeader", outputTokens: 31 } },
      ]),
      [
        {
          type: "model.streaming",
          payload: {
            assistantMessageId: "msg_b",
            delta: "ne",
            kind: "text_delta",
            done: true,
          },
        },
      ],
    );

    assert.deepEqual(
      deltas(state, [{ op: "state.updated", patch: { control: { phase: "completedSuccess" } } }]),
      [
        {
          type: "turn.completed",
          payload: { resultType: "success", response: "done", tokenCount: 31 },
        },
      ],
    );
    assert.equal(state.lastAssistantText, "done");
  });

  it("reports interruption and failure as their own terminal kinds", () => {
    const interrupted = initialConversationState();
    deltas(interrupted, [{ op: "state.updated", patch: { control: { phase: "running" } } }]);
    assert.deepEqual(
      deltas(interrupted, [
        { op: "state.updated", patch: { control: { phase: "completedInterrupted" } } },
      ]),
      [{ type: "turn.completed", payload: { resultType: "cancelled" } }],
    );

    const failed = initialConversationState();
    deltas(failed, [{ op: "state.updated", patch: { control: { phase: "running" } } }]);
    assert.deepEqual(
      deltas(failed, [
        {
          op: "state.updated",
          patch: { control: { phase: "error", lastError: { message: "model exploded" } } },
        },
      ]),
      [{ type: "turn.failed", payload: { error: { message: "model exploded" } } }],
    );
  });

  it("follows a tool call from started through streamed output to its result", () => {
    const state = initialConversationState();
    const toolRow = {
      rowId: 4,
      kind: "toolCall",
      toolCallId: "call_1",
      toolName: "Bash",
      status: "inputStreaming",
      input: { command: "echo hello-t3" },
    };

    assert.deepEqual(deltas(state, [{ op: "row.appended", row: toolRow }]), [
      {
        type: "tool.updated",
        payload: {
          toolCallId: "call_1",
          toolName: "Bash",
          input: { command: "echo hello-t3" },
          kind: "started",
        },
      },
    ]);

    assert.deepEqual(
      deltas(state, [
        { op: "row.upserted", row: { ...toolRow, status: "running" } },
        { op: "row.delta", rowId: 4, path: "output.text", append: "hel" },
      ]),
      [
        {
          type: "tool.updated",
          payload: {
            toolCallId: "call_1",
            toolName: "Bash",
            input: { command: "echo hello-t3" },
            kind: "started",
          },
        },
        {
          type: "tool.updated",
          payload: {
            toolCallId: "call_1",
            toolName: "Bash",
            input: { command: "echo hello-t3" },
            kind: "progress",
            outputPreview: { text: "hel" },
          },
        },
      ],
    );

    assert.deepEqual(
      deltas(state, [
        {
          op: "row.upserted",
          row: { ...toolRow, status: "success", output: { text: "hello-t3" } },
        },
      ]),
      [
        {
          type: "tool.updated",
          payload: {
            toolCallId: "call_1",
            toolName: "Bash",
            input: { command: "echo hello-t3" },
            kind: "result",
            result: { output: "hello-t3" },
          },
        },
      ],
    );

    assert.deepEqual(
      deltas(state, [
        {
          op: "row.appended",
          row: {
            rowId: 5,
            kind: "toolCall",
            toolCallId: "call_2",
            toolName: "Bash",
            status: "error",
            error: { message: "permission denied" },
          },
        },
      ]),
      [
        {
          type: "tool.updated",
          payload: {
            toolCallId: "call_2",
            toolName: "Bash",
            input: undefined,
            kind: "error",
            error: { message: "permission denied" },
          },
        },
      ],
    );
  });

  it("announces a permission interaction once and resolves it when the daemon drops it", () => {
    const state = initialConversationState();
    const interaction = {
      interactionId: "int_1",
      kind: "permission",
      payload: {
        toolCallId: "call_1",
        toolName: "Bash",
        summary: "Needs approval",
        options: [
          { optionId: "o1", kind: "allowOnce", label: "Allow once" },
          { optionId: "o2", kind: "deny", label: "Deny" },
        ],
        fullAccessOption: { optionId: "o3", kind: "custom", label: "Full access" },
      },
    };
    const patch = { op: "state.updated", patch: { pendingInteractions: [interaction] } };

    assert.deepEqual(deltas(state, [patch]), [
      {
        type: "permission.requested",
        payload: {
          requestId: "int_1",
          toolCallId: "call_1",
          toolName: "Bash",
          reason: "Needs approval",
          options: [
            {
              optionId: "o1",
              kind: "allow_once",
              name: "Allow once",
              response: { optionId: "o1", decision: "allow" },
            },
            {
              optionId: "o2",
              kind: "deny",
              name: "Deny",
              response: { optionId: "o2", decision: "deny" },
            },
            {
              optionId: "o3",
              kind: "custom",
              name: "Full access",
              response: { optionId: "o3", decision: "allow" },
            },
          ],
        },
      },
      {
        type: "server.request",
        payload: {
          method: "interaction/requestPermission",
          params: { requestId: "int_1", toolCallId: "call_1", toolName: "Bash" },
        },
      },
    ]);

    // A resubscribe replays the same pending interaction; it must not ask twice.
    assert.deepEqual(deltas(state, [patch]), []);

    assert.deepEqual(deltas(state, [{ op: "state.updated", patch: { pendingInteractions: [] } }]), [
      { type: "permission.resolved", payload: { requestId: "int_1" } },
    ]);
    assert.equal(state.pendingInteractions.size, 0);
  });

  it("surfaces an AskUserQuestion as choices and as free text", () => {
    const state = initialConversationState();
    assert.deepEqual(
      deltas(state, [
        {
          op: "state.updated",
          patch: {
            pendingInteractions: [
              {
                interactionId: "int_2",
                kind: "userInput",
                payload: {
                  questions: [
                    {
                      question: "Proceed with the migration?",
                      header: "Confirm",
                      options: [
                        { value: "yes", label: "Yes" },
                        { value: "no", label: "No" },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        },
      ]),
      [
        {
          type: "userInput.requested",
          payload: {
            requestId: "int_2",
            questions: [
              {
                header: "Confirm",
                prompt: "Proceed with the migration?",
                inputType: "choice",
                choices: ["Yes", "No"],
              },
            ],
          },
        },
        {
          type: "server.request",
          payload: {
            method: "interaction/requestUserInput",
            params: { requestId: "int_2" },
          },
        },
      ],
    );

    const freeText = initialConversationState();
    assert.deepEqual(
      deltas(freeText, [
        {
          op: "state.updated",
          patch: {
            pendingInteractions: [
              {
                interactionId: "int_3",
                kind: "userInput",
                payload: { prompt: "Explain the change", freeText: true },
              },
            ],
          },
        },
      ]),
      [
        {
          type: "userInput.requested",
          payload: {
            requestId: "int_3",
            questions: [
              {
                header: "Question 1",
                prompt: "Explain the change",
                inputType: "text",
                choices: [],
              },
            ],
          },
        },
        {
          type: "server.request",
          payload: {
            method: "interaction/requestUserInput",
            params: { requestId: "int_3" },
          },
        },
      ],
    );
  });

  it("keeps every question in a multi-question user input request", () => {
    const state = initialConversationState();
    const events = deltas(state, [
      {
        op: "state.updated",
        patch: {
          pendingInteractions: [
            {
              interactionId: "int_4",
              kind: "userInput",
              payload: {
                questions: [
                  {
                    header: "Confirm",
                    question: "Proceed with the migration?",
                    options: [{ label: "Yes" }, { label: "No" }],
                  },
                  {
                    header: "Details",
                    question: "Which database?",
                    options: [{ label: "SQLite" }, { label: "Postgres" }],
                  },
                ],
              },
            },
          ],
        },
      },
    ]);

    assert.deepEqual(events[0], {
      type: "userInput.requested",
      payload: {
        requestId: "int_4",
        questions: [
          {
            header: "Confirm",
            prompt: "Proceed with the migration?",
            inputType: "choice",
            choices: ["Yes", "No"],
          },
          {
            header: "Details",
            prompt: "Which database?",
            inputType: "choice",
            choices: ["SQLite", "Postgres"],
          },
        ],
      },
    });
    assert.deepEqual(interactionAnswer(undefined, { answers: { "Which database?": "SQLite" } }), {
      action: "accept",
      content: { answers: { "Which database?": "SQLite" } },
    });
  });

  it("does not reuse an older turn header's token count", () => {
    const state = initialConversationState();
    deltas(state, [{ op: "state.updated", patch: { control: { phase: "running" } } }]);
    deltas(state, [
      { op: "row.upserted", row: { rowId: 1, kind: "turnHeader", outputTokens: 31 } },
      { op: "row.upserted", row: { rowId: 4, kind: "turnHeader" } },
    ]);

    assert.deepEqual(
      deltas(state, [{ op: "state.updated", patch: { control: { phase: "completedSuccess" } } }]),
      [{ type: "turn.completed", payload: { resultType: "success" } }],
    );
  });
});
