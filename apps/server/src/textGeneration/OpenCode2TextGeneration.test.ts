import * as NodeAssert from "node:assert/strict";

import { ProviderInstanceId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { beforeEach, expect, it as viteIt } from "vite-plus/test";

import {
  joinAssistantText,
  makeOpenCode2TextGeneration,
  type OpenCode2ConnectionProvider,
  type OpenCode2TextGenerationClient,
} from "./OpenCode2TextGeneration.ts";

interface FakeState {
  readonly createCalls: Array<unknown>;
  readonly switchModelCalls: Array<unknown>;
  readonly switchAgentCalls: Array<unknown>;
  readonly removeCalls: Array<unknown>;
  readonly promptCalls: Array<unknown>;
  readonly waitCalls: Array<unknown>;
  sessionResult: { readonly id: string };
  createError: unknown;
  promptError: unknown;
  waitError: unknown;
  contextError: unknown;
  removeError: unknown;
  contextMessages: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly error?: { readonly message?: string };
  }>;
}

const state: FakeState = {
  createCalls: [],
  switchModelCalls: [],
  switchAgentCalls: [],
  removeCalls: [],
  promptCalls: [],
  waitCalls: [],
  sessionResult: { id: "ses_1" },
  createError: undefined,
  promptError: undefined,
  waitError: undefined,
  contextError: undefined,
  removeError: undefined,
  contextMessages: [],
};

function resetState() {
  state.createCalls.length = 0;
  state.switchModelCalls.length = 0;
  state.switchAgentCalls.length = 0;
  state.removeCalls.length = 0;
  state.promptCalls.length = 0;
  state.waitCalls.length = 0;
  state.sessionResult = { id: "ses_1" };
  state.createError = undefined;
  state.promptError = undefined;
  state.waitError = undefined;
  state.contextError = undefined;
  state.removeError = undefined;
  state.contextMessages = [
    {
      id: "msg_a",
      type: "assistant",
      content: [
        {
          type: "text",
          text: encodeJson({ subject: "Tighten parsing", body: "Handle JSON locally." }),
        },
      ],
    },
  ];
}

const fakeClient: OpenCode2TextGenerationClient = {
  session: {
    create: async (input) => {
      state.createCalls.push(input);
      if (state.createError !== undefined) {
        throw state.createError;
      }
      return state.sessionResult;
    },
    switchModel: async (input) => {
      state.switchModelCalls.push(input);
    },
    switchAgent: async (input) => {
      state.switchAgentCalls.push(input);
    },
    remove: async (input) => {
      state.removeCalls.push(input);
      if (state.removeError !== undefined) {
        throw state.removeError;
      }
    },
    prompt: async (input) => {
      state.promptCalls.push(input);
      if (state.promptError !== undefined) {
        throw state.promptError;
      }
    },
    wait: async (input) => {
      state.waitCalls.push(input);
      if (state.waitError !== undefined) {
        throw state.waitError;
      }
    },
    context: async () => {
      if (state.contextError !== undefined) {
        throw state.contextError;
      }
      return state.contextMessages;
    },
  },
};

const withFakeConnection: OpenCode2ConnectionProvider = (use) => use(fakeClient);

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const DEFAULT_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("opencode2"),
  model: "openai/gpt-5",
};

beforeEach(() => {
  resetState();
});

it.effect("creates a deny-all session and switches model+agent before prompting", () =>
  Effect.gen(function* () {
    const textGeneration = makeOpenCode2TextGeneration(withFakeConnection);

    const result = yield* textGeneration.generateCommitMessage({
      cwd: "/workspace",
      branch: "feature/oc2",
      stagedSummary: "M README.md",
      stagedPatch: "diff",
      modelSelection: {
        ...DEFAULT_MODEL_SELECTION,
        options: [
          { id: "variant", value: "high" },
          { id: "agent", value: "plan" },
        ],
      },
    });

    NodeAssert.deepEqual(state.createCalls, [
      {
        title: "T3 Code generateCommitMessage",
        directory: "/workspace",
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      },
    ]);
    NodeAssert.deepEqual(state.switchModelCalls, [
      {
        sessionID: "ses_1",
        model: { id: "gpt-5", providerID: "openai", variant: "high" },
      },
    ]);
    NodeAssert.deepEqual(state.switchAgentCalls, [{ sessionID: "ses_1", agent: "plan" }]);
    NodeAssert.equal(state.promptCalls.length, 1);
    NodeAssert.equal(state.waitCalls.length, 1);
    expect(result).toEqual({ subject: "Tighten parsing", body: "Handle JSON locally." });
  }),
);

it.effect("parses JSON returned as plain text output", () =>
  Effect.gen(function* () {
    state.contextMessages = [
      {
        id: "msg_a",
        type: "assistant",
        content: [
          {
            type: "text",
            text: 'Here is the result:\n{"title":"Tighten parsing","body":"Handle text output."}',
          },
        ],
      },
    ];
    const textGeneration = makeOpenCode2TextGeneration(withFakeConnection);

    const result = yield* textGeneration.generatePrContent({
      cwd: "/workspace",
      baseBranch: "main",
      headBranch: "feature/oc2",
      commitSummary: "commits",
      diffSummary: "diff summary",
      diffPatch: "diff",
      modelSelection: DEFAULT_MODEL_SELECTION,
    });

    expect(result).toEqual({ title: "Tighten parsing", body: "Handle text output." });
    NodeAssert.deepEqual(state.createCalls, [
      {
        title: "T3 Code generatePrContent",
        directory: "/workspace",
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      },
    ]);
  }),
);

it.effect("rejects model selections without a provider/model slug", () =>
  Effect.gen(function* () {
    const textGeneration = makeOpenCode2TextGeneration(withFakeConnection);

    const error = yield* textGeneration
      .generateBranchName({
        cwd: "/workspace",
        message: "add feature",
        modelSelection: { ...DEFAULT_MODEL_SELECTION, model: "gpt-5" },
      })
      .pipe(Effect.flip);

    NodeAssert.ok(Predicate.isTagged(error, "TextGenerationError"));
    NodeAssert.equal(state.createCalls.length, 0);
  }),
);

it.effect("preserves the SDK cause when session creation fails", () =>
  Effect.gen(function* () {
    const sdkCause = new Error("session endpoint unavailable");
    state.createError = sdkCause;
    const textGeneration = makeOpenCode2TextGeneration(withFakeConnection);

    const error = yield* textGeneration
      .generateCommitMessage({
        cwd: "/workspace",
        branch: "feature/oc2",
        stagedSummary: "M README.md",
        stagedPatch: "diff",
        modelSelection: DEFAULT_MODEL_SELECTION,
      })
      .pipe(Effect.flip);

    NodeAssert.ok(Predicate.isTagged(error, "TextGenerationError"));
    expect(error.message).toContain("OpenCode 2 session.create request failed.");
    expect(error.cause).toMatchObject({
      _tag: "OpenCode2TextGenerationSessionRequestError",
      operation: "generateCommitMessage",
    });
  }),
);

it.effect("returns a typed empty-output error for blank assistant text", () =>
  Effect.gen(function* () {
    state.contextMessages = [
      { id: "msg_a", type: "assistant", content: [{ type: "text", text: "   " }] },
    ];
    const textGeneration = makeOpenCode2TextGeneration(withFakeConnection);

    const error = yield* textGeneration
      .generateCommitMessage({
        cwd: "/workspace",
        branch: "feature/oc2",
        stagedSummary: "M README.md",
        stagedPatch: "diff",
        modelSelection: DEFAULT_MODEL_SELECTION,
      })
      .pipe(Effect.flip);

    expect(error.message).toContain("OpenCode 2 returned empty output.");
    expect(error.cause).toMatchObject({
      _tag: "OpenCode2TextGenerationEmptyOutputError",
      operation: "generateCommitMessage",
      messageCount: 1,
      textPartCount: 1,
    });
  }),
);

it.effect("surfaces assistant error messages as provider failures", () =>
  Effect.gen(function* () {
    state.contextMessages = [
      {
        id: "msg_a",
        type: "assistant",
        content: [],
        error: { message: "Model did not produce structured output" },
      },
    ];
    const textGeneration = makeOpenCode2TextGeneration(withFakeConnection);

    const error = yield* textGeneration
      .generateCommitMessage({
        cwd: "/workspace",
        branch: "feature/oc2",
        stagedSummary: "M README.md",
        stagedPatch: "diff",
        modelSelection: DEFAULT_MODEL_SELECTION,
      })
      .pipe(Effect.flip);

    expect(error.message).toContain("Model did not produce structured output");
    expect(error.cause).toMatchObject({
      _tag: "OpenCode2TextGenerationPromptResponseError",
      operation: "generateCommitMessage",
    });
  }),
);

viteIt("joinAssistantText joins assistant text entries in order", () => {
  const joined = joinAssistantText([
    { type: "user", content: [{ type: "text", text: "skip" }] },
    {
      type: "assistant",
      content: [
        { type: "text", text: "Hello " },
        { type: "tool", text: "skip" },
      ],
    },
    { type: "assistant", content: [{ type: "text", text: "World" }] },
  ]);
  NodeAssert.deepEqual(joined, { rawText: "Hello World", messageCount: 2, textPartCount: 2 });
});

viteIt("joinAssistantText skips malformed server entries instead of throwing", () => {
  const joined = joinAssistantText([
    null,
    42,
    { type: "assistant", content: "not-an-array" },
    { type: "assistant", content: [null, { type: "text" }, { type: "text", text: 7 }] },
    { type: "assistant", content: [{ type: "text", text: "ok" }] },
  ]);
  NodeAssert.deepEqual(joined, { rawText: "ok", messageCount: 2, textPartCount: 1 });
});

it.effect("maps an empty session id to a typed payload failure", () =>
  Effect.gen(function* () {
    state.sessionResult = { id: "   " };
    const textGeneration = makeOpenCode2TextGeneration(withFakeConnection);

    const error = yield* textGeneration
      .generateCommitMessage({
        cwd: "/workspace",
        branch: "feature/oc2",
        stagedSummary: "M README.md",
        stagedPatch: "diff",
        modelSelection: DEFAULT_MODEL_SELECTION,
      })
      .pipe(Effect.flip);

    NodeAssert.ok(Predicate.isTagged(error, "TextGenerationError"));
    expect(error.message).toContain("OpenCode 2 session.create returned no session payload.");
    expect(error.cause).toMatchObject({
      _tag: "OpenCode2TextGenerationSessionPayloadError",
      operation: "generateCommitMessage",
    });
  }),
);

it.effect("maps a non-array session.context payload to empty output", () =>
  Effect.gen(function* () {
    state.contextMessages = { wat: true } as never;
    const textGeneration = makeOpenCode2TextGeneration(withFakeConnection);

    const error = yield* textGeneration
      .generateCommitMessage({
        cwd: "/workspace",
        branch: "feature/oc2",
        stagedSummary: "M README.md",
        stagedPatch: "diff",
        modelSelection: DEFAULT_MODEL_SELECTION,
      })
      .pipe(Effect.flip);

    expect(error.message).toContain("OpenCode 2 returned empty output.");
    expect(error.cause).toMatchObject({
      _tag: "OpenCode2TextGenerationEmptyOutputError",
      messageCount: 0,
      textPartCount: 0,
    });
  }),
);

it.effect("ignores a non-string assistant error message and reads the text", () =>
  Effect.gen(function* () {
    state.contextMessages = [
      {
        id: "msg_a",
        type: "assistant",
        content: [
          {
            type: "text",
            text: encodeJson({ subject: "Tighten parsing", body: "Handle JSON locally." }),
          },
        ],
        error: { message: 42 },
      },
    ] as never;
    const textGeneration = makeOpenCode2TextGeneration(withFakeConnection);

    const result = yield* textGeneration.generateCommitMessage({
      cwd: "/workspace",
      branch: "feature/oc2",
      stagedSummary: "M README.md",
      stagedPatch: "diff",
      modelSelection: DEFAULT_MODEL_SELECTION,
    });

    expect(result).toEqual({ subject: "Tighten parsing", body: "Handle JSON locally." });
  }),
);

it.effect("applies a plain model selection with no options before prompting", () =>
  Effect.gen(function* () {
    state.contextMessages = [
      {
        id: "msg_a",
        type: "assistant",
        content: [{ type: "text", text: encodeJson({ title: "Tighten parsing" }) }],
      },
    ];
    const textGeneration = makeOpenCode2TextGeneration(withFakeConnection);

    yield* textGeneration.generateThreadTitle({
      cwd: "/workspace",
      message: "hello",
      modelSelection: DEFAULT_MODEL_SELECTION,
    });

    // No variant/agent options, but the plain `provider/model` choice must
    // still reach the server — otherwise the turn runs on its default.
    NodeAssert.deepEqual(state.switchModelCalls, [
      {
        sessionID: "ses_1",
        model: { id: "gpt-5", providerID: "openai" },
      },
    ]);
    NodeAssert.deepEqual(state.switchAgentCalls, []);
    NodeAssert.equal(state.promptCalls.length, 1);
  }),
);

it.effect("removes the ephemeral session after a successful operation", () =>
  Effect.gen(function* () {
    state.contextMessages = [
      {
        id: "msg_a",
        type: "assistant",
        content: [{ type: "text", text: encodeJson({ title: "Tighten parsing" }) }],
      },
    ];
    const textGeneration = makeOpenCode2TextGeneration(withFakeConnection);

    yield* textGeneration.generateThreadTitle({
      cwd: "/workspace",
      message: "hello",
      modelSelection: DEFAULT_MODEL_SELECTION,
    });

    NodeAssert.deepEqual(state.removeCalls, [{ sessionID: "ses_1" }]);
  }),
);

it.effect("still removes the ephemeral session when prompting fails", () =>
  Effect.gen(function* () {
    state.promptError = new Error("prompt transport down");
    const textGeneration = makeOpenCode2TextGeneration(withFakeConnection);

    const error = yield* textGeneration
      .generateThreadTitle({
        cwd: "/workspace",
        message: "hello",
        modelSelection: DEFAULT_MODEL_SELECTION,
      })
      .pipe(Effect.flip);

    NodeAssert.ok(Predicate.isTagged(error, "TextGenerationError"));
    NodeAssert.deepEqual(state.removeCalls, [{ sessionID: "ses_1" }]);
  }),
);

it.effect("a failing session removal never masks the operation result", () =>
  Effect.gen(function* () {
    state.removeError = new Error("remove transport down");
    state.contextMessages = [
      {
        id: "msg_a",
        type: "assistant",
        content: [{ type: "text", text: encodeJson({ title: "Tighten parsing" }) }],
      },
    ];
    const textGeneration = makeOpenCode2TextGeneration(withFakeConnection);

    const result = yield* textGeneration.generateThreadTitle({
      cwd: "/workspace",
      message: "hello",
      modelSelection: DEFAULT_MODEL_SELECTION,
    });

    NodeAssert.deepEqual(state.removeCalls, [{ sessionID: "ses_1" }]);
    expect(result).toEqual({ title: "Tighten parsing" });
  }),
);
