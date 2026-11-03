import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as CodexSchema from "./schema.ts";

const isGetAccountResponse = Schema.is(CodexSchema.V2GetAccountResponse);
const isThreadReadResponse = Schema.is(CodexSchema.V2ThreadReadResponse);
const isThreadResumeResponse = Schema.is(CodexSchema.V2ThreadResumeResponse);
const isThreadForkResponse = Schema.is(CodexSchema.V2ThreadForkResponse);
const isTurnCompletedNotification = Schema.is(CodexSchema.V2TurnCompletedNotification);
const decodeThreadResumeResponse = Schema.decodeUnknownSync(CodexSchema.V2ThreadResumeResponse);

it("keeps async questions in live notifications and thread history", () => {
  const item = {
    type: "agentMessage",
    id: "question-1",
    text: "Which package?\n- pnpm\n- npm\n\nWhat should it be named?",
    phase: "final_answer",
    delivery: "async",
    questions: [
      { title: "Which package manager?", options: ["pnpm", "npm"] },
      { title: "What should it be named?" },
    ],
  } as const;
  for (const schema of [
    CodexSchema.ServerNotification__ThreadItem,
    CodexSchema.V2ItemStartedNotification__ThreadItem,
    CodexSchema.V2ItemCompletedNotification__ThreadItem,
    CodexSchema.V2ThreadReadResponse__ThreadItem,
    CodexSchema.V2ThreadResumeResponse__ThreadItem,
  ]) {
    assert.deepEqual(Schema.decodeSync(schema)(item), item);
  }
});

it("keeps partial answers in notifications and persisted thread histories", () => {
  const item = {
    type: "agentMessage",
    id: "partial-1",
    text: "A stable answer before more tool work.",
    phase: "partial_answer",
  } as const;
  for (const schema of [
    CodexSchema.ServerNotification__ThreadItem,
    CodexSchema.V2ItemStartedNotification__ThreadItem,
    CodexSchema.V2ItemCompletedNotification__ThreadItem,
    CodexSchema.V2ThreadReadResponse__ThreadItem,
    CodexSchema.V2ThreadResumeResponse__ThreadItem,
    CodexSchema.V2ThreadForkResponse__ThreadItem,
    CodexSchema.V2TurnCompletedNotification__ThreadItem,
  ]) {
    assert.deepEqual(Schema.decodeSync(schema)(item), item);
  }
  const response = {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "/tmp/project",
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      cliVersion: "0.162.0",
      createdAt: 0,
      updatedAt: 0,
      cwd: "/tmp/project",
      ephemeral: false,
      id: "thread-1",
      modelProvider: "openai",
      preview: "",
      projectId: null,
      sessionId: "session-1",
      source: "cli",
      status: { type: "idle" },
      turns: [{ id: "turn-1", status: "completed", items: [item] }],
    },
  };
  assert.equal(isThreadForkResponse(response), true);
  assert.equal(isThreadResumeResponse(response), true);
  assert.equal(isThreadReadResponse({ thread: response.thread }), true);
});

it("accepts Codex 0.150 multi-agent values", () => {
  const schemas = [
    CodexSchema.ServerNotification__SubAgentActivityKind,
    CodexSchema.V2ItemStartedNotification__SubAgentActivityKind,
    CodexSchema.V2ItemCompletedNotification__SubAgentActivityKind,
    CodexSchema.V2ThreadReadResponse__SubAgentActivityKind,
    CodexSchema.V2ThreadResumeResponse__SubAgentActivityKind,
  ];

  for (const schema of schemas) {
    assert.equal(Schema.is(schema)("completed"), true);
  }
  const isServerNotificationCollabAgentTool = Schema.is(
    CodexSchema.ServerNotification__CollabAgentTool,
  );

  const isV2ThreadResumeResponseCollabAgentTool = Schema.is(
    CodexSchema.V2ThreadResumeResponse__CollabAgentTool,
  );

  for (const tool of ["sendMessage", "followupTask", "interruptAgent", "listAgents"]) {
    assert.equal(isServerNotificationCollabAgentTool(tool), true);
    assert.equal(isV2ThreadResumeResponseCollabAgentTool(tool), true);
  }
  const isServerNotificationCollabAgentToolCallStatus = Schema.is(
    CodexSchema.ServerNotification__CollabAgentToolCallStatus,
  );

  assert.equal(isServerNotificationCollabAgentToolCallStatus("interrupted"), true);
  const isV2ThreadResumeResponseCollabAgentToolCallStatus = Schema.is(
    CodexSchema.V2ThreadResumeResponse__CollabAgentToolCallStatus,
  );

  assert.equal(isV2ThreadResumeResponseCollabAgentToolCallStatus("interrupted"), true);

  const resumeResponse = {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "/tmp/project",
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      cliVersion: "0.150.0",
      createdAt: 0,
      cwd: "/tmp/project",
      ephemeral: false,
      id: "root-thread",
      modelProvider: "openai",
      preview: "",
      projectId: null,
      sessionId: "session-1",
      source: "cli",
      status: { type: "idle" },
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            {
              agentsStates: {},
              id: "item-1",
              receiverThreadIds: ["child-thread"],
              senderThreadId: "root-thread",
              status: "interrupted",
              tool: "followupTask",
              type: "collabAgentToolCall",
            },
          ],
        },
      ],
      updatedAt: 0,
    },
  };
  const isV2ThreadResumeResponse = Schema.is(CodexSchema.V2ThreadResumeResponse);

  assert.equal(isV2ThreadResumeResponse(resumeResponse), true);
});

it("accepts Codex misalignment policy errors for thread responses", () => {
  const failedThread = {
    cliVersion: "0.150.0",
    createdAt: 0,
    cwd: "/tmp/project",
    ephemeral: false,
    id: "thread-1",
    modelProvider: "openai",
    preview: "",
    projectId: null,
    sessionId: "session-1",
    source: "cli",
    status: { type: "idle" },
    turns: [
      {
        error: {
          codexErrorInfo: "misalignmentPolicyViolation",
          message: "Misalignment policy violation",
        },
        id: "turn-1",
        items: [],
        status: "failed",
      },
    ],
    updatedAt: 0,
  };
  const resumeLikeResponse = {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "/tmp/project",
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: failedThread,
  };
  assert.equal(isThreadReadResponse({ thread: failedThread }), true);
  assert.equal(isThreadResumeResponse(resumeLikeResponse), true);
  assert.equal(isThreadForkResponse(resumeLikeResponse), true);
  const decodedResume = decodeThreadResumeResponse(resumeLikeResponse);
  assert.equal(decodedResume.thread.turns[0]?.error?.codexErrorInfo, "misalignmentPolicyViolation");
  assert.equal(
    isTurnCompletedNotification({
      threadId: "thread-1",
      turn: {
        error: {
          codexErrorInfo: "misalignmentPolicyViolation",
          message: "Misalignment policy violation",
        },
        id: "turn-1",
        items: [],
        status: "failed",
      },
    }),
    true,
  );
});

it("accepts account plan slugs newer than the pinned protocol", () => {
  const planTypes = [
    "self_serve_business_prolite",
    "ent26",
    "enterprise_cbp_automation",
    "edu_plus",
    "edu_pro",
    "promax",
    "some_future_plan",
  ];

  for (const planType of planTypes) {
    const accountResponse = {
      account: {
        email: "user@example.com",
        planType,
        type: "chatgpt",
      },
      requiresOpenaiAuth: true,
    };

    assert.equal(isGetAccountResponse(accountResponse), true);
  }
});
