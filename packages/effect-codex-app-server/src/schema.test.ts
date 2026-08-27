import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as CodexSchema from "./schema.ts";

const isGetAccountResponse = Schema.is(CodexSchema.V2GetAccountResponse);

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

  for (const tool of ["sendMessage", "followupTask", "interruptAgent", "listAgents"]) {
    assert.equal(Schema.is(CodexSchema.ServerNotification__CollabAgentTool)(tool), true);
    assert.equal(Schema.is(CodexSchema.V2ThreadResumeResponse__CollabAgentTool)(tool), true);
  }

  assert.equal(
    Schema.is(CodexSchema.ServerNotification__CollabAgentToolCallStatus)("interrupted"),
    true,
  );
  assert.equal(
    Schema.is(CodexSchema.V2ThreadResumeResponse__CollabAgentToolCallStatus)("interrupted"),
    true,
  );

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

  assert.equal(Schema.is(CodexSchema.V2ThreadResumeResponse)(resumeResponse), true);
});

it("accepts Codex 0.150 account plan values", () => {
  const planTypes = [
    "self_serve_business_prolite",
    "ent26",
    "enterprise_cbp_automation",
    "edu_plus",
    "edu_pro",
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
