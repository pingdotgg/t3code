import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as CodexSchema from "./schema.ts";
import { deduplicateGeneratedSchemas } from "../../../scripts/lib/deduplicateGeneratedSchemas.ts";

const isGetAccountResponse = Schema.is(CodexSchema.V2GetAccountResponse);
const isThreadReadResponse = Schema.is(CodexSchema.V2ThreadReadResponse);
const isThreadResumeResponse = Schema.is(CodexSchema.V2ThreadResumeResponse);
const isThreadRollbackResponse = Schema.is(CodexSchema.V2ThreadRollbackResponse);

it("deduplicates schema declarations and references without changing a second pass", () => {
  const source = `
export type A = { readonly value: string };
export const A = Schema.Struct({ value: Schema.String });
export type B = { readonly value: string };
export const B = Schema.Struct({ value: Schema.String });
export type ParentA = { readonly child: A };
export const ParentA = Schema.Struct({ child: A });
export type ParentB = { readonly child: B };
export const ParentB = Schema.Struct({ child: B });
`;
  const output = deduplicateGeneratedSchemas(source);

  assert.include(output, "export type B = A;\nexport const B = A;");
  assert.include(output, "export type ParentB = ParentA;\nexport const ParentB = ParentA;");
  assert.equal(deduplicateGeneratedSchemas(output), output);
});

it("does not rename property keys, descriptions or defaults that match schema names", () => {
  const source = `
export type A = string;
export const A = Schema.String;
export type B = string;
export const B = Schema.String;
export type KeyA = { A: string };
export const KeyA = Schema.Struct({ A: Schema.String });
export type KeyB = { B: string };
export const KeyB = Schema.Struct({ B: Schema.String });
export type NoteA = string;
export const NoteA = Schema.String.annotate({ description: "A", default: "A" });
export type NoteB = string;
export const NoteB = Schema.String.annotate({ description: "B", default: "B" });
`;

  assert.equal(
    deduplicateGeneratedSchemas(source),
    source.replace(
      "export type B = string;\nexport const B = Schema.String;",
      "export type B = A;\nexport const B = A;",
    ),
  );
});

it("preserves each alias's root identifier and the shared annotations", () => {
  const source = `
export type A = string;
export const A = Schema.String.annotate({ identifier: "A", title: "Value", description: "A", default: "A" });
export type B = string;
export const B = Schema.String.annotate({ identifier: "B", title: "Value", description: "A", default: "A" });
export type Literal = string;
export const Literal = Schema.String.annotate({ identifier: "<schema identifier>", title: "Value", description: "A", default: "A" });
export type ParentA = { child: A };
export const ParentA = Schema.Struct({ child: A });
export type ParentB = { child: B };
export const ParentB = Schema.Struct({ child: B });
`;
  const output = deduplicateGeneratedSchemas(source);

  assert.include(output, 'export const B = A.annotate({ identifier: "B" });');
  assert.include(output, 'identifier: "A", title: "Value", description: "A", default: "A"');
  assert.include(
    output,
    'export const Literal = Schema.String.annotate({ identifier: "<schema identifier>"',
  );
  assert.include(output, "export const ParentB = Schema.Struct({ child: B });");
  assert.equal(deduplicateGeneratedSchemas(output), output);
});

it("leaves recursive declarations and local bindings separate", () => {
  const source = `
export type A = { next: A };
export const A = Schema.suspend((): Schema.Codec<A> => Schema.Struct({ next: A }));
export type B = { next: B };
export const B = Schema.suspend((): Schema.Codec<B> => Schema.Struct({ next: B }));
export type Value = string;
export const Value = Schema.String;
export type OtherValue = string;
export const OtherValue = Schema.String;
export type ShadowA = string;
export const ShadowA = ((Value) => Value)(Schema.String);
export type ShadowB = string;
export const ShadowB = ((OtherValue) => OtherValue)(Schema.String);
`;

  assert.equal(
    deduplicateGeneratedSchemas(source),
    source.replace(
      "export type OtherValue = string;\nexport const OtherValue = Schema.String;",
      "export type OtherValue = Value;\nexport const OtherValue = Value;",
    ),
  );
});

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
    assert.deepEqual(Schema.decodeUnknownSync(schema)(item), item);
  }
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

it("accepts Codex rate limit errors for thread responses", () => {
  const failedThread = {
    cliVersion: "0.150.0",
    createdAt: 0,
    cwd: "/tmp/project",
    ephemeral: false,
    id: "thread-1",
    modelProvider: "openai",
    preview: "",
    sessionId: "session-1",
    source: "cli",
    status: { type: "idle" },
    turns: [
      {
        error: {
          codexErrorInfo: "rateLimitExceeded",
          message: "Rate limit exceeded",
        },
        id: "turn-1",
        items: [],
        status: "failed",
      },
    ],
    updatedAt: 0,
  };
  assert.equal(isThreadReadResponse({ thread: failedThread }), true);
  assert.equal(
    isThreadResumeResponse({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      cwd: "/tmp/project",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      sandbox: { type: "dangerFullAccess" },
      thread: failedThread,
    }),
    true,
  );
  assert.equal(isThreadRollbackResponse({ thread: failedThread }), true);
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
