// @effect-diagnostics nodeBuiltinImport:off -- workflow fixtures use files and the fake Claude CLI uses Node streams
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";

import type {
  Query as ClaudeQuery,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AskUserQuestionInput,
  TaskCreateInput,
  TaskCreateOutput,
  TaskListOutput,
  TaskUpdateInput,
  TaskUpdateOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  type ChatAttachment,
  ChatFileAttachment,
  ChatImageAttachment,
  CheckpointId,
  ClaudeSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  type ProviderInstanceEnvironment,
  ProviderDriverKind,
  type ProviderReplayTranscript,
  type ProviderApprovalDecision,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Tool } from "effect/ai";
import { formatClaudeResumeCompactionQuestion } from "@t3tools/shared/claudeCompaction";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { WorkflowAgentTranscriptReadObserver } from "../workflowAgentTranscript.ts";
import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { PreviewControlsToolkit } from "../../mcp/toolkits/previewControls/tools.ts";
import { HtmlToolkit } from "../../mcp/toolkits/html/tools.ts";
import { EnvironmentToolkit } from "../../mcp/toolkits/environment/tools.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import { WorktreeToolkit } from "../../mcp/toolkits/worktree/tools.ts";
import { ThreadToolkit } from "../../mcp/toolkits/thread/tools.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import { ClaudeExecutableFileCheck } from "../../provider/Drivers/ClaudeExecutable.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ClaudeOrchestratorReplayHarness } from "./ClaudeAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "../testkit/DeterministicRuntime.ts";
import { runOrchestratorV2Scenario } from "../testkit/OrchestratorScenario.ts";
import { layerProviderReplay } from "../testkit/ProviderReplayHarness.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  CLAUDE_MODEL_SELECTION,
  materializeFixtureInput,
  projectionFor,
} from "../testkit/fixtures/shared.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(ClaudeSdk.resolveSettings).mockReset().mockResolvedValue({
    effective: {},
    provenance: {},
    sources: [],
  });
});

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const AUTO_COMPACT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({
  autoCompactWindow: "300000",
});
const CUSTOM_MODEL_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({
  customModels: [
    "opus",
    {
      slug: "claude-custom-tuned",
      name: "Tuned",
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "gentle", label: "Gentle", isDefault: true },
              { id: "brutal", label: "Brutal" },
            ],
          },
        ],
      },
    },
  ],
});
const CLAUDE_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "ultrathink" }],
} satisfies ModelSelection;
const CLAUDE_TEST_RESTART_MODEL_SELECTION = {
  ...CLAUDE_TEST_MODEL_SELECTION,
  model: "claude-haiku-4-5-20251001",
  options: [{ id: "thinking", value: false }],
} satisfies ModelSelection;
const CLAUDE_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeClaudeTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Claude attachment test",
    providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeClaudeTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
  readonly attachments: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["attachments"];
  readonly providerTurnOrdinal?: number;
  readonly nativeThreadHasTurns?: boolean;
  readonly messageCreatedBy?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["createdBy"];
  readonly messageCreationSource?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["creationSource"];
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeClaudeTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: input.providerTurnOrdinal ?? 1,
    ...(input.nativeThreadHasTurns === undefined
      ? {}
      : { nativeThreadHasTurns: input.nativeThreadHasTurns }),
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: input.attachments,
    },
    modelSelection: input.modelSelection ?? CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: input.runtimePolicy ?? CLAUDE_TEST_RUNTIME_POLICY,
  };
}

describe("ClaudeAdapterV2 runtime query policy", () => {
  it.each([
    ["--permission-mode acceptEdits", "acceptEdits"],
    ["--dangerously-skip-permissions", "bypassPermissions"],
    ["--dangerously-skip-permissions --permission-mode plan", "plan"],
  ])("folds %s into the SDK permission mode", (launchArgs, expected) => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "native-permission-override",
      resume: false,
      cwd: "/workspace",
      permissionMode: "default",
      settings: { ...AUTO_COMPACT_CLAUDE_SETTINGS, launchArgs },
    });
    assert.equal(options.permissionMode, expected);
    assert.isUndefined(options.extraArgs?.["permission-mode"]);
    assert.isUndefined(options.extraArgs?.["dangerously-skip-permissions"]);
  });

  it("gives delegated children Claude's subagent prompt cache TTL", () => {
    const lineage = (relationshipToParent: "fork" | "subagent" | null) => ({
      lineage: {
        parentThreadId: null,
        relationshipToParent,
        rootThreadId: ThreadId.make("thread-root"),
      },
    });
    const env = { PATH: "/bin" };
    const ttl = (environment: NodeJS.ProcessEnv, ...args: Parameters<typeof lineage>) =>
      ClaudeAdapterV2.claudeQueryEnvironment(environment, lineage(...args), "5m")
        .CLAUDE_CODE_PROMPT_CACHE_TTL;
    assert.equal(ttl(env, "subagent"), "5m");
    assert.isUndefined(ttl(env, null));
    assert.isUndefined(ttl(env, "fork"));
    assert.equal(ttl({ ...env, CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }, "subagent"), "1h");
    assert.strictEqual(
      ClaudeAdapterV2.claudeQueryEnvironment(env, lineage("subagent"), undefined),
      env,
    );
  });

  it("pins Claude's auto tool search on through flag settings", () => {
    const override = ClaudeAdapterV2.claudeToolSearchOverride;
    for (const value of ["auto", "auto:10", "auto:99.5", "auto:x", "auto:Infinity"]) {
      assert.equal(override(value), "true", value);
    }
    for (const value of [
      undefined,
      "true",
      "false",
      "auto:0",
      "auto:-5",
      "auto:100",
      "auto:1e2",
      "auto:1_000",
      "auto:1,000",
      "AUTO",
    ]) {
      assert.isUndefined(override(value), String(value));
    }

    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "native-tool-search",
      resume: false,
      cwd: "/workspace",
      sdkSettings: { env: { OTHER: "kept" } },
      toolSearchOverride: "true",
    });
    assert.deepEqual((options.settings as { env?: Record<string, string> }).env, {
      OTHER: "kept",
      ENABLE_TOOL_SEARCH: "true",
    });
  });

  it("projects AskUserQuestion input with question text as the answer key", () => {
    const preview = "\n  **Proposed change**\n\n```ts\n\tconst enabled = true;\n```\n  ";
    assert.deepEqual(
      ClaudeAdapterV2.claudeUserInputQuestions({
        questions: [
          {
            header: "Approach",
            question: "Which approach?",
            options: [
              { label: "Simple", description: "Use fewer moving parts", preview },
              { label: "Safe", description: "Keep the current setup" },
            ],
            multiSelect: true,
          },
        ],
      }),
      [
        {
          id: "Which approach?",
          header: "Approach",
          question: "Which approach?",
          options: [
            { label: "Simple", description: "Use fewer moving parts", preview },
            { label: "Safe", description: "Keep the current setup" },
          ],
          multiSelect: true,
        },
      ],
    );
    const sdkAnswers: NonNullable<AskUserQuestionInput["answers"]> =
      ClaudeAdapterV2.claudeSdkUserInputAnswers({
        "Which approach?": ["Simple", "Safe"],
        "Deploy now?": "Yes",
      });
    assert.deepEqual(sdkAnswers, {
      "Which approach?": "Simple, Safe",
      "Deploy now?": "Yes",
    });
    assert.isTrue(
      ClaudeAdapterV2.ClaudeProviderCapabilitiesV2.planning.supportsStructuredQuestions,
    );
  });

  it("maps canonical read-only never policy to Claude dontAsk with read-only tools", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "dontAsk",
      tools: ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      allowedTools: ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      installPermissionCallback: false,
    });
  });

  it("does not auto-allow reads for canonical restricted read-only never policy", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: {
            type: "restricted",
            includePlatformDefaults: false,
            readableRoots: [],
          },
          networkAccess: false,
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "dontAsk",
      tools: ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      installPermissionCallback: false,
    });
  });

  it("maps default full-access policy to Claude bypass permissions", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      installPermissionCallback: false,
    });
  });

  it("keeps approval checks when Full access must fall back to an allowed Claude mode", () => {
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/workspace",
      approvalPolicy: "never",
    });

    assert.deepEqual(
      ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(runtimePolicy, {
        bypassDisabled: true,
        autoDisabled: false,
      }),
      { permissionMode: "auto", installPermissionCallback: true },
    );
    assert.deepEqual(
      ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(runtimePolicy, {
        bypassDisabled: true,
        autoDisabled: true,
      }),
      { permissionMode: "default", installPermissionCallback: true },
    );
  });

  it("keeps approval-required mode interactive with danger-full-access sandboxing", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
        sandboxPolicy: {
          type: "dangerFullAccess",
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "default",
      installPermissionCallback: true,
    });
  });
});

describe("ClaudeAdapterV2 MCP query overrides", () => {
  const T3_MCP_SERVERS = {
    "t3-code": {
      type: "http",
      url: "http://127.0.0.1:43123/mcp",
      headers: {
        Authorization: "Bearer secret-claude-token",
      },
      timeout: ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
    },
  } as const;

  const mcpSessionFor = (
    threadId: ThreadId,
    authorizationHeader = "Bearer secret-claude-token",
  ): McpProviderSession.McpProviderSessionConfig => ({
    environmentId: EnvironmentId.make(`environment-${threadId}`),
    threadId,
    providerSessionId: `mcp-session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader,
    browserToolsAvailable: true,
  });

  it("pre-approves only read-only t3-code tools in a read-only sandbox", () => {
    const threadId = ThreadId.make("thread-claude-mcp-read-only");
    const mcpSession = mcpSessionFor(threadId);
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: true,
      allowedTools: [...ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS],
    });

    assert.deepEqual(overrides, {
      allowedTools: [
        ...ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
        ...ClaudeAdapterV2.CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS,
      ],
      mcpServers: T3_MCP_SERVERS,
    });
    assert.isFalse(overrides.allowedTools?.includes(ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_WILDCARD));
  });

  it("invalidates live-query reuse when MCP credentials rotate", () => {
    const threadId = ThreadId.make("thread-claude-mcp-credential-rotation");
    const mcpSession = mcpSessionFor(threadId);
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
      }),
    );
    const initialKey = ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(
      queryPolicy,
      ClaudeAdapterV2.claudeMcpQueryOverrides({ mcpSession, readOnlySandbox: false }),
    );

    const rotatedKey = ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(
      queryPolicy,
      ClaudeAdapterV2.claudeMcpQueryOverrides({
        mcpSession: mcpSessionFor(threadId, "Bearer rotated-claude-token"),
        readOnlySandbox: false,
      }),
    );
    assert.notEqual(rotatedKey, initialKey);
  });

  it("matches the read-only allowlist to the orchestrator toolkit annotations", () => {
    const readOnlyToolNames = [
      ...Object.values(OrchestratorToolkit.tools),
      ...Object.values(ThreadToolkit.tools),
      ...Object.values(WorktreeToolkit.tools),
      ...Object.values(ProjectToolkit.tools),
      ...Object.values(EnvironmentToolkit.tools),
      ...Object.values(PreviewControlsToolkit.tools),
      ...Object.values(HtmlToolkit.tools),
    ]
      .filter((tool) => Context.get(tool.annotations, Tool.Readonly))
      .map((tool) => `mcp__t3-code__${tool.name}`)
      .sort();

    assert.deepEqual(
      [...ClaudeAdapterV2.CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS].sort(),
      readOnlyToolNames,
    );
  });
});

describe("ClaudeAdapterV2 native protocol logging", () => {
  it("injects thread-scoped MCP configuration without logging the credential", () => {
    const threadId = ThreadId.make("thread-claude-mcp");
    const mcpSession = {
      environmentId: EnvironmentId.make("environment-claude-mcp"),
      threadId,
      providerSessionId: "mcp-session-claude",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-claude-token",
      browserToolsAvailable: true,
    };

    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: false,
      allowedTools: ["Read"],
    });
    assert.deepEqual(overrides, {
      allowedTools: ["Read", "mcp__t3-code__*"],
      mcpServers: {
        "t3-code": {
          type: "http",
          url: "http://127.0.0.1:43123/mcp",
          headers: {
            Authorization: "Bearer secret-claude-token",
          },
          timeout: ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
        },
      },
    });

    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      nativeThreadId: "native-thread-claude-mcp",
      resume: false,
      cwd: "/workspace",
      allowedTools: overrides.allowedTools ?? [],
      mcpServers: overrides.mcpServers ?? {},
      environment: {},
    });
    assert.isObject(options.systemPrompt);
    const systemPrompt = options.systemPrompt as {
      readonly type: string;
      readonly preset: string;
      readonly append?: string;
    };
    assert.equal(systemPrompt.type, "preset");
    assert.equal(systemPrompt.preset, "claude_code");
    assert.include(systemPrompt.append ?? "", "Use `delegate_task`");
    assert.include(systemPrompt.append ?? "", "call `t3_background_wait`");
    const logged = ClaudeAdapterV2.loggedClaudeQueryOptions(options);
    assert.equal(logged.hasMcpServers, true);
    assert.notInclude(JSON.stringify(logged), "secret-claude-token");
  });
});

describe("ClaudeAdapterV2 context usage", () => {
  it("dates cache expiry from the request start, not the response end", () => {
    const usage = ClaudeAdapterV2.claudeProviderTurnTokenUsage(
      {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 300 },
      },
      CLAUDE_TEST_MODEL_SELECTION,
      "2026-08-29T00:03:00.000Z",
      "",
      DateTime.makeUnsafe("2026-08-29T00:00:00.000Z"),
    );
    assert.strictEqual(usage.promptCacheExpiresAt, "2026-08-29T00:05:00.000Z");
  });
});

describe("ClaudeAdapterV2 approval presentation", () => {
  it("marks asks that full access could not auto-allow and keeps the CLI's reason", () => {
    const presentation = ClaudeAdapterV2.claudeApprovalPresentation({
      permissionMode: "bypassPermissions",
      prompt: 'Claude wants to run rm -r -- "$rr/$h"',
      callbackOptions: {
        decisionReason: "\u001b[33mDangerous rm on a path built from a variable\u001b[39m",
        suppressAlwaysAllowRule: true,
      },
    });
    assert.deepEqual(presentation, {
      reason: "Dangerous rm on a path built from a variable",
      fullAccessOverride: "provider_check",
      options: [
        { decision: "decline", label: "Decline" },
        { decision: "accept", label: "Approve" },
      ],
    });
  });

  it("attributes a bypass ask to the user's ask rule when one matched", () => {
    const presentation = ClaudeAdapterV2.claudeApprovalPresentation({
      permissionMode: "bypassPermissions",
      prompt: "Claude wants to run git push",
      callbackOptions: {
        matchedAskRule: { source: "userSettings", toolName: "Bash", ruleContent: "git push:*" },
      },
    });
    assert.deepEqual(presentation, { fullAccessOverride: "ask_rule" });
  });

  it("adds nothing to ordinary approvals outside full access", () => {
    const presentation = ClaudeAdapterV2.claudeApprovalPresentation({
      permissionMode: "default",
      prompt: "Run make?",
      callbackOptions: { decisionReason: "Run make?" },
    });
    assert.deepEqual(presentation, {});
  });
});

describe("ClaudeAdapterV2 session permissions", () => {
  // regression: #15892 an explicit user refusal must stay user_reject, not a tool failure
  it("keeps explicit user refusals classified as user_reject", () => {
    const result = ClaudeAdapterV2.permissionResultFromDecision({
      toolName: "Bash",
      decision: "decline",
      toolInput: { command: "make" },
      toolUseID: "denied-build",
    });
    assert.equal(result.behavior, "deny");
    if (result.behavior !== "deny") return;
    assert.equal(result.decisionClassification, "user_reject");
    assert.equal(result.message, "User declined tool execution.");
    assert.equal(result.interrupt, undefined);
  });

  it("forces suggested permission updates to session scope", () => {
    const result = ClaudeAdapterV2.permissionResultFromDecision({
      toolName: "Bash",
      decision: "acceptForSession",
      toolInput: { command: "git status" },
      toolUseID: "tool-1",
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "git status" }],
          behavior: "allow",
          destination: "localSettings",
        },
      ],
    });

    assert.equal(result.behavior, "allow");
    if (result.behavior !== "allow") {
      return;
    }
    assert.deepEqual(result.updatedPermissions, [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "git status" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
  });

  it("adds a whole-tool session rule when Claude offers no suggestion", () => {
    const result = ClaudeAdapterV2.permissionResultFromDecision({
      toolName: "mcp__t3__custom_tool",
      decision: "acceptForSession",
      toolInput: {},
      toolUseID: "tool-2",
    });

    assert.equal(result.behavior, "allow");
    if (result.behavior !== "allow") {
      return;
    }
    assert.deepEqual(result.updatedPermissions, [
      {
        type: "addRules",
        rules: [{ toolName: "mcp__t3__custom_tool" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
  });
});

describe("ClaudeAdapterV2 Auto-accept edits", () => {
  it.effect("asks before a command instead of allowing it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-accept-edits-",
        });
        let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-claude-accept-edits"),
            open: (input) =>
              Effect.sync(() => {
                openedOptions = input.options;
                return {
                  messages: Stream.never,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const threadId = ThreadId.make("thread-claude-accept-edits");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-accept-edits"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-accept-edits"),
            text: "Run node.",
            attachments: [],
            runtimePolicy,
          }),
        );
        assert.equal(openedOptions?.permissionMode, "acceptEdits");
        const canUseTool = openedOptions?.canUseTool;
        assert.isFunction(canUseTool);

        const requestEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "runtime_request.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const command = { command: "node -e 'console.log(42)'" };
        const decision = yield* Effect.promise(() =>
          canUseTool!("Bash", command, {
            signal: new AbortController().signal,
            toolUseID: "tool-bash-accept-edits",
            requestId: "request-bash-accept-edits",
          }),
        ).pipe(Effect.forkScoped);
        const first = yield* Effect.raceFirst(
          Fiber.join(requestEvent).pipe(
            Effect.map((event) => ({ type: "request", event }) as const),
          ),
          Fiber.join(decision).pipe(
            Effect.map((result) => ({ type: "decision", result }) as const),
          ),
        );
        assert.equal(first.type, "request", "the command ran without asking");
        if (first.type !== "request") return;
        const event = first.event;
        if (Option.isNone(event) || event.value.type !== "runtime_request.updated") return;
        assert.equal(event.value.runtimeRequest.kind, "command");

        yield* runtime.respondToRuntimeRequest({
          requestId: event.value.runtimeRequest.id,
          decision: "accept",
        });
        assert.equal((yield* Fiber.join(decision))?.behavior, "allow");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 append-system-prompt-file launch argument", () => {
  const startTurnWithLaunchArgs = Effect.fnUntraced(function* (launchArgs: string, cwd: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = [];
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: { ...DEFAULT_CLAUDE_SETTINGS, launchArgs },
      environment: {},
      attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-append-" }),
      fileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: {
        allocateSessionId: Effect.succeed("native-thread-claude-append-file"),
        open: (input) =>
          Effect.sync(() => {
            opened.push(input.options);
            return {
              messages: Stream.never,
              offer: () => Effect.void,
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              setPermissionMode: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              stopTask: () => Effect.void,
              interrupt: Effect.void,
              close: Effect.void,
            };
          }),
        forkSession: () => Effect.die("unused"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd,
    });
    const threadId = ThreadId.make("thread-claude-append-file");
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-claude-append-file"),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy,
    });
    const exit = yield* runtime
      .startTurn(
        makeClaudeTestTurnInput({
          threadId,
          providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-claude-append-file"),
          text: "What is the sentinel?",
          attachments: [],
          runtimePolicy,
        }),
      )
      .pipe(Effect.exit);
    return { exit, opened };
  });

  const appendSystemPrompt = (options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined) =>
    (options?.systemPrompt as { readonly append?: string } | undefined)?.append;

  it.effect("sends append launch arguments to Claude after the T3 instructions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-append-cwd-" });
        yield* fileSystem.writeFileString(NodePath.join(cwd, "rules.md"), "File sentinel\n");
        const plain = yield* startTurnWithLaunchArgs("", cwd);
        const { exit, opened } = yield* startTurnWithLaunchArgs(
          '--append-system-prompt "Inline sentinel" --append-system-prompt-file rules.md --system-prompt Replacement',
          cwd,
        );
        assert.isTrue(Exit.isSuccess(exit));
        assert.lengthOf(opened, 1);
        assert.equal(
          appendSystemPrompt(opened[0]),
          `${appendSystemPrompt(plain.opened[0])}\n\nFile sentinel\n\nInline sentinel`,
        );
        assert.isUndefined(opened[0]!.extraArgs?.["append-system-prompt"]);
        assert.isUndefined(opened[0]!.extraArgs?.["append-system-prompt-file"]);
        assert.equal(opened[0]!.extraArgs?.["system-prompt"], "Replacement");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  // regression: #20413 malformed append-system-prompt launch args fail before a query opens
  it.effect.each([
    [
      "--append-system-prompt-file missing.md",
      (cwd: string) =>
        new ClaudeAdapterV2.ClaudeAppendSystemPromptFileError({
          path: NodePath.join(cwd, "missing.md"),
        }).message,
    ],
    [
      "--append-system-prompt-file",
      () =>
        new ClaudeAdapterV2.ClaudeAppendSystemPromptMissingValueError({
          flag: "--append-system-prompt-file",
        }).message,
    ],
    [
      "--append-system-prompt-file=",
      () =>
        new ClaudeAdapterV2.ClaudeAppendSystemPromptMissingValueError({
          flag: "--append-system-prompt-file",
        }).message,
    ],
    [
      "--append-system-prompt",
      () =>
        new ClaudeAdapterV2.ClaudeAppendSystemPromptMissingValueError({
          flag: "--append-system-prompt",
        }).message,
    ],
  ] as const)("fails the turn before opening Claude for %s", ([launchArgs, expectedMessage]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-append-cwd-" });
        const { exit, opened } = yield* startTurnWithLaunchArgs(launchArgs, cwd);
        assert.lengthOf(opened, 0);
        assert.isTrue(Exit.isFailure(exit));
        if (!Exit.isFailure(exit)) return;
        assert.equal(
          makeProviderFailure({ cause: exit.cause, class: "provider_error" }).message,
          expectedMessage(cwd),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 approval cancellation", () => {
  it.effect("observes an approval signal that was already aborted", () =>
    Effect.gen(function* () {
      const decision = yield* Deferred.make<{
        decision: ProviderApprovalDecision;
        feedback?: string;
      }>();
      const result = yield* ClaudeAdapterV2.awaitClaudeApprovalDecision(
        decision,
        AbortSignal.abort(),
      );

      assert.deepEqual(result, { decision: "cancel" });
    }),
  );
});

const captureSdkExecutablePaths = Effect.fn("captureSdkExecutablePaths")(function* (
  binaryPath: string,
  environment: ProviderInstanceEnvironment = [],
) {
  const executablePaths: Array<string | undefined> = [];
  const taskToolEnvironment: Array<string | undefined> = [];
  const adapter = yield* ClaudeAdapterV2.createClaudeAdapterV2(
    {
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      displayName: undefined,
      environment,
      enabled: true,
      config: { ...DEFAULT_CLAUDE_SETTINGS, binaryPath },
    },
    {},
  ).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-claude-binary-path-",
      }),
    ),
    Effect.provideService(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, {
      allocateSessionId: Effect.succeed("native-thread-claude-binary-path"),
      open: (input) =>
        Effect.sync(() => {
          executablePaths.push(input.options.pathToClaudeCodeExecutable);
          taskToolEnvironment.push(input.options.env?.CLAUDE_CODE_ENABLE_TODO_TOOLS);
          return {
            messages: Stream.never,
            offer: () => Effect.void,
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            stopTask: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.void,
          };
        }),
      forkSession: () => Effect.die("unused"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    }),
  );
  const threadId = ThreadId.make("thread-claude-binary-path");
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-claude-binary-path"),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
  });
  yield* runtime.startTurn(
    makeClaudeTestTurnInput({
      threadId,
      providerThread,
      now: yield* DateTime.now,
      attemptId: RunAttemptId.make("attempt-claude-binary-path"),
      text: "hello",
      attachments: [],
    }),
  );
  return { executablePaths, taskToolEnvironment };
});

describe("ClaudeAdapterV2 executable path", () => {
  it.effect("follows a bare claude on Windows to the npm package executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const npmDir = "C:\\Users\\dev\\AppData\\Roaming\\npm";
        const packageExe = `${npmDir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
        const { executablePaths } = yield* captureSdkExecutablePaths("claude").pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(SpawnExecutableResolution, () => `${npmDir}\\claude.cmd`),
          Effect.provideService(ClaudeExecutableFileCheck, (filePath) => filePath === packageExe),
        );

        assert.deepEqual(executablePaths, [packageExe]);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 resumeThread", () => {
  it.effect("fails for a transcript without messages so a fresh session replaces it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const configDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-empty-session-",
        });
        const projectDir = path.join(configDir, "projects", "-workspace");
        yield* fileSystem.makeDirectory(projectDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(projectDir, "native-thread-empty.jsonl"),
          [
            `{"type":"last-prompt","lastPrompt":"hello","sessionId":"native-thread-empty"}`,
            `{"type":"atis-latch","atis":"","sessionId":"native-thread-empty"}`,
            `{"type":"cost-state","sessionId":"native-thread-empty","totalCostUSD":0}`,
            "",
          ].join("\n"),
        );
        yield* fileSystem.writeFileString(
          path.join(projectDir, "native-thread-saved.jsonl"),
          `{"type":"user","message":{"role":"user","content":"hello"},"sessionId":"native-thread-saved"}\n`,
        );
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: { CLAUDE_CONFIG_DIR: configDir },
          attachmentsDir: configDir,
          fileSystem,
          path,
          crypto: yield* Crypto.Crypto,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-empty"),
            open: () => Effect.die("unused"),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-empty-session");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-empty-session"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });

        const error = yield* Effect.flip(runtime.resumeThread({ providerThread }));
        assert.equal(error._tag, "ProviderAdapterResumeThreadError");

        const saved = yield* runtime.resumeThread({
          providerThread: {
            ...providerThread,
            nativeThreadRef: {
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeId: "native-thread-saved",
              strength: "strong",
            },
          },
        });
        assert.equal(saved.nativeThreadRef?.nativeId, "native-thread-saved");

        const missing = yield* runtime.resumeThread({
          providerThread: {
            ...providerThread,
            nativeThreadRef: {
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeId: "native-thread-missing",
              strength: "strong",
            },
          },
        });
        assert.equal(missing.nativeThreadRef?.nativeId, "native-thread-missing");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 resume compaction", () => {
  it.effect("resolves and cancels the SDK resume dialog through structured runtime input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-resume-",
        });
        let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-claude-resume"),
            open: (input) =>
              Effect.sync(() => {
                openedOptions = input.options;
                return {
                  messages: Stream.never,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-resume");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-resume"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-resume"),
            text: "continue",
            attachments: [],
          }),
        );
        const callback = openedOptions?.onUserDialog;
        assert.isFunction(callback);
        const canUseTool = openedOptions?.canUseTool;
        assert.isFunction(canUseTool);
        const longQuestion = `Choose a deployment target: ${"region ".repeat(80)}`;
        const questionRequestEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "runtime_request.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const questionResult = yield* Effect.promise(() =>
          canUseTool!(
            "AskUserQuestion",
            {
              questions: [
                {
                  header: "Target",
                  question: longQuestion,
                  options: [
                    { label: "Production", description: "Deploy to production." },
                    { label: "Staging", description: "Deploy to staging." },
                  ],
                  multiSelect: true,
                },
              ],
            },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-question-full-access",
              requestId: "request-question-full-access",
            },
          ),
        ).pipe(Effect.forkScoped);
        const questionEvent = yield* Fiber.join(questionRequestEvent);
        assert.isTrue(Option.isSome(questionEvent));
        if (
          Option.isNone(questionEvent) ||
          questionEvent.value.type !== "runtime_request.updated"
        ) {
          return;
        }
        yield* runtime.respondToRuntimeRequest({
          requestId: questionEvent.value.runtimeRequest.id,
          answers: { [longQuestion]: ["Production", "Staging"] },
        });
        assert.deepEqual(yield* Fiber.join(questionResult), {
          behavior: "allow",
          updatedInput: {
            questions: [
              {
                header: "Target",
                question: longQuestion,
                options: [
                  { label: "Production", description: "Deploy to production." },
                  { label: "Staging", description: "Deploy to staging." },
                ],
                multiSelect: true,
              },
            ],
            answers: { [longQuestion]: "Production, Staging" },
          },
          toolUseID: "tool-question-full-access",
        });
        const longPlan = `# Deployment plan\n\n${"Validate every region before promotion.\n".repeat(120)}`;
        const proposedPlanEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "plan.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const exitPlanResult = yield* Effect.promise(() =>
          canUseTool!(
            "ExitPlanMode",
            { plan: longPlan },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-exit-plan-full-access",
              requestId: "request-exit-plan-full-access",
            },
          ),
        );
        assert.deepEqual(exitPlanResult, {
          behavior: "deny",
          message:
            "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
          toolUseID: "tool-exit-plan-full-access",
        });
        const planEvent = yield* Fiber.join(proposedPlanEvent);
        assert.isTrue(Option.isSome(planEvent));
        if (Option.isSome(planEvent) && planEvent.value.type === "plan.updated") {
          assert.equal(planEvent.value.plan.kind, "proposed_plan");
          if (planEvent.value.plan.kind === "proposed_plan") {
            assert.equal(planEvent.value.plan.markdown, longPlan.trim());
          }
        }
        const requestEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "runtime_request.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const signal = yield* Effect.abortSignal;
        const dialog = yield* Effect.promise(() =>
          callback!(
            {
              dialogKind: "resume_return",
              payload: { sessionAgeMinutes: 90, estimatedTokens: 120000 },
            },
            { signal, requestId: "dialog-resume-1" },
          ),
        ).pipe(Effect.forkScoped);
        const event = yield* Fiber.join(requestEvent);
        assert.isTrue(Option.isSome(event));
        if (Option.isNone(event) || event.value.type !== "runtime_request.updated") return;
        const question = formatClaudeResumeCompactionQuestion({
          ageMinutes: 90,
          estimatedTokens: 120000,
        });
        yield* runtime.respondToRuntimeRequest({
          requestId: event.value.runtimeRequest.id,
          answers: { [question]: "Compact and continue" },
        });
        assert.deepEqual(yield* Fiber.join(dialog), { behavior: "completed", result: "compact" });

        assert.deepEqual(
          yield* Effect.promise(() =>
            callback!(
              {
                dialogKind: "resume_return",
                payload: { sessionAgeMinutes: 90, estimatedTokens: 120000 },
              },
              { signal: AbortSignal.abort(), requestId: "dialog-resume-2" },
            ),
          ),
          { behavior: "cancelled" },
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 attachments", () => {
  it.effect.each([
    ...[
      "retained-images",
      "retained-text",
      "same-message-images",
      "retained-documents",
      "later-images",
      "partial-images",
      "cancelled-send",
      "cancelled-steer",
    ].map((budget) => ({
      name: budget,
      prompt: "Read this PDF.",
      expectedText: "Read this PDF.",
      command: undefined,
      ultrathink: false,
      resumed: false,
      budget,
    })),
    {
      name: "ordinary text",
      prompt: "What’s in this image?",
      expectedText: "Ultrathink:\nWhat’s in this image?",
      command: undefined,
      ultrathink: true,
      resumed: false,
      budget: "none",
    },
    {
      name: "mid-sentence skill",
      prompt: "please $implement fixes\n\nThen report the result",
      expectedText: "Ultrathink:\nplease /implement fixes\n\nThen report the result",
      command: "/implement fixes\n\nThen report the result",
      ultrathink: true,
      resumed: false,
      budget: "none",
    },
    {
      name: "prompt-leading skill",
      prompt: "$implement fixes",
      expectedText: "/implement fixes",
      command: undefined,
      ultrathink: false,
      resumed: false,
      budget: "none",
    },
    {
      name: "resumed history without persisted counters",
      prompt: "Inspect this file",
      expectedText: "Ultrathink:\nInspect this file",
      command: undefined,
      ultrathink: true,
      resumed: true,
      budget: "none",
    },
  ])(
    "preserves $name with native PDFs, images, and paths on sends and steering",
    ({ prompt, expectedText, command, ultrathink, resumed, budget }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const path = yield* Path.Path;
          const claudeHome = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-skills-home-",
          });
          yield* fileSystem.makeDirectory(path.join(claudeHome, "skills", "implement"), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(
            path.join(claudeHome, "skills", "implement", "SKILL.md"),
            "---\ndescription: Implement the requested change\n---\nImplement it.\n",
          );
          const modelSelection = {
            ...CLAUDE_TEST_MODEL_SELECTION,
            options: ultrathink ? CLAUDE_TEST_MODEL_SELECTION.options : [],
          };
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-attachments-",
          });
          const offeredMessages: Array<SDKUserMessage> = [];
          let failOpen = false;
          let failOffer = false;
          let cancelAfterQueue = false;
          const queued = yield* Deferred.make<void>();
          const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
            instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
            settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath: claudeHome },
            environment: {},
            attachmentsDir,
            fileSystem,
            path: yield* Path.Path,
            crypto: yield* Crypto.Crypto,
            idAllocator,
            queryRunner: {
              allocateSessionId: Effect.succeed("native-thread-claude-attachments"),
              open: () =>
                Effect.gen(function* () {
                  if (failOpen) {
                    failOpen = false;
                    return yield* new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                      method: "open",
                      cause: "rejected open",
                    });
                  }
                  const messages = yield* Queue.unbounded<SDKMessage>();
                  return {
                    messages: Stream.fromQueue(messages),
                    offer: (message, onQueued) =>
                      Effect.suspend(() => {
                        if (failOffer) {
                          failOffer = false;
                          return Effect.fail(
                            new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                              method: "offer",
                              cause: "rejected offer",
                            }),
                          );
                        }
                        return Effect.sync(() => {
                          offeredMessages.push(message);
                          onQueued?.();
                        }).pipe(
                          Effect.andThen(() =>
                            cancelAfterQueue
                              ? Deferred.succeed(queued, undefined).pipe(
                                  Effect.andThen(Effect.never),
                                )
                              : Effect.void,
                          ),
                        );
                      }),
                    setModel: () => Effect.void,
                    applyFlagSettings: () => Effect.void,
                    setPermissionMode: () => Effect.void,
                    backgroundTasks: () => Effect.succeed(false),
                    stopTask: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(messages),
                  };
                }),
              forkSession: () => Effect.die("unused forkSession"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          const threadId = ThreadId.make("thread-claude-attachments");
          const providerSessionId = ProviderSessionId.make("provider-session-claude-attachments");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const attachment = ChatImageAttachment.make({
            type: "image",
            id: ChatAttachmentId.make(
              "thread-claude-attachments-12345678-1234-1234-1234-123456789abc",
            ),
            name: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 4,
          });
          const document = ChatFileAttachment.make({
            type: "file",
            id: ChatAttachmentId.make(
              "thread-claude-attachments-abcdefab-1234-1234-1234-123456789abc",
            ),
            name: "requirements.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4,
          });
          yield* fileSystem.writeFile(
            path.join(attachmentsDir, attachmentRelativePath(attachment)!),
            Uint8Array.from([1, 2, 3, 4]),
          );
          const pdfBytes = Buffer.from(
            "%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF",
          );
          yield* fileSystem.writeFile(
            path.join(attachmentsDir, attachmentRelativePath(document)!),
            pdfBytes,
          );
          const attemptId = RunAttemptId.make("attempt-claude-attachments");
          const now = yield* DateTime.now;

          const turnInput = {
            ...makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId,
              modelSelection,
              text: prompt,
              attachments: resumed ? [attachment] : [attachment, document],
            }),
            nativeThreadHasTurns: resumed,
          };
          if (budget === "cancelled-send" || budget === "cancelled-steer") {
            const documentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
            const pages = Buffer.from(
              `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 60 >> endobj\n${Array.from({ length: 60 }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n")}\n`,
            );
            yield* fileSystem.writeFile(
              documentPath,
              Buffer.concat([
                pages,
                Buffer.alloc(19 * 1024 * 1024 - pages.length - 5, 32),
                Buffer.from("%%EOF"),
              ]),
            );
            const message = { ...turnInput.message, attachments: [document] };
            if (budget === "cancelled-steer") {
              yield* runtime.startTurn({ ...turnInput, message: { ...message, attachments: [] } });
            }
            const deliver =
              budget === "cancelled-send"
                ? runtime.startTurn({ ...turnInput, message })
                : runtime.steerTurn({
                    threadId,
                    runId: turnInput.runId,
                    providerThread,
                    providerTurnId: idAllocator.derive.providerTurn({
                      driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                      nativeTurnId: `turn:${attemptId}`,
                    }),
                    message,
                  });
            cancelAfterQueue = true;
            const delivering = yield* deliver.pipe(Effect.forkChild);
            yield* Deferred.await(queued);
            yield* Fiber.interrupt(delivering);
            const delivered = offeredMessages.at(-1)!.message.content;
            assert.include(JSON.stringify(delivered), '"type":"document"');
            cancelAfterQueue = false;
            if (budget === "cancelled-send") {
              yield* runtime.interruptTurn({
                providerThread,
                providerTurnId: idAllocator.derive.providerTurn({
                  driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                  nativeTurnId: `turn:${attemptId}`,
                }),
              });
            }
            yield* deliver;
            const retried = offeredMessages.at(-1)!.message.content;
            assert.notInclude(JSON.stringify(retried), '"type":"document"');
            assert.include(JSON.stringify(retried), documentPath);
            assert.isBelow(Buffer.byteLength(JSON.stringify(offeredMessages)), 32_000_000);
            return;
          }
          if (budget !== "none") {
            const providerTurnId = idAllocator.derive.providerTurn({
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeTurnId: `turn:${attemptId}`,
            });
            const imagePath = path.join(attachmentsDir, attachmentRelativePath(attachment)!);
            // The on-disk length deliberately disagrees with sizeBytes.
            yield* fileSystem.writeFile(imagePath, Buffer.alloc(4 * 1024 * 1024));
            if (["later-images", "partial-images"].includes(budget)) {
              const documentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
              yield* fileSystem.writeFile(
                documentPath,
                Buffer.concat([
                  pdfBytes.subarray(0, -5),
                  Buffer.alloc(
                    (budget === "later-images" ? 19 : 16) * 1024 * 1024 - pdfBytes.length,
                    32,
                  ),
                  Buffer.from("%%EOF"),
                ]),
              );
              yield* runtime.startTurn({
                ...turnInput,
                message: { ...turnInput.message, attachments: [document] },
              });
              assert.include(
                JSON.stringify(offeredMessages[0]!.message.content),
                '"type":"document"',
              );
              const message = { ...turnInput.message, attachments: [attachment, attachment] };
              yield* runtime.interruptTurn({ providerThread, providerTurnId });
              const laterAttemptId = RunAttemptId.make("attempt-claude-attachments-later");
              yield* runtime.startTurn({
                ...turnInput,
                attemptId: laterAttemptId,
                providerTurnOrdinal: 2,
                nativeThreadHasTurns: true,
                message,
              });
              const sent = offeredMessages.at(-1)!.message.content;
              assert.isArray(sent);
              assert.lengthOf(
                typeof sent === "string" ? [] : sent.filter((block) => block.type === "image"),
                budget === "partial-images" ? 1 : 0,
              );
              assert.include(JSON.stringify(sent), imagePath);
              yield* runtime.steerTurn({
                threadId,
                runId: RunId.make("run-claude-attachments"),
                providerThread,
                providerTurnId: idAllocator.derive.providerTurn({
                  driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                  nativeTurnId: `turn:${laterAttemptId}`,
                }),
                message,
              });
              const steered = offeredMessages.at(-1)!.message.content;
              assert.isArray(steered);
              assert.lengthOf(
                typeof steered === "string"
                  ? []
                  : steered.filter((block) => block.type === "image"),
                0,
              );
              assert.include(JSON.stringify(steered), imagePath);
              assert.isBelow(
                Buffer.byteLength(
                  JSON.stringify(offeredMessages.map((message) => message.message)),
                ),
                32_000_000,
              );
              return;
            }
            if (budget === "retained-documents") {
              yield* fileSystem.writeFile(
                path.join(attachmentsDir, attachmentRelativePath(document)!),
                Buffer.concat([
                  pdfBytes.subarray(0, pdfBytes.length - 5),
                  Buffer.alloc(10 * 1024 * 1024, 32),
                  Buffer.from("%%EOF"),
                ]),
              );
            }
            yield* runtime.startTurn({
              ...turnInput,
              message: {
                ...turnInput.message,
                text: budget === "retained-text" ? "x".repeat(10 * 1024 * 1024) : prompt,
                attachments:
                  budget === "retained-text"
                    ? []
                    : budget === "retained-documents"
                      ? [document]
                      : [attachment, attachment],
              },
            });
            const largePdf = Buffer.concat([
              pdfBytes.subarray(0, pdfBytes.length - 5),
              Buffer.alloc(
                (budget === "retained-documents" ? 20 : 19) * 1024 * 1024 - pdfBytes.length,
                32,
              ),
              Buffer.from("%%EOF"),
            ]);
            const documentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
            yield* fileSystem.writeFile(documentPath, largePdf);
            yield* runtime.steerTurn({
              threadId,
              runId: RunId.make("run-claude-attachments"),
              providerThread,
              providerTurnId,
              message: {
                ...turnInput.message,
                attachments:
                  budget === "same-message-images"
                    ? [document, attachment, attachment]
                    : [document],
              },
            });
            const sent = offeredMessages.at(-1)!.message.content;
            assert.isArray(sent);
            assert.lengthOf(
              typeof sent === "string" ? [] : sent.filter((block) => block.type === "document"),
              0,
              budget,
            );
            assert.include(JSON.stringify(sent), documentPath);
            return;
          }
          if (!resumed) {
            const undelivered = Buffer.from(
              `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 60 >> endobj\n${Array.from({ length: 60 }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n")}\n%%EOF`,
            );
            yield* fileSystem.writeFile(
              path.join(attachmentsDir, attachmentRelativePath(document)!),
              undelivered,
            );
            failOpen = true;
            assert.isTrue(Exit.isFailure(yield* runtime.startTurn(turnInput).pipe(Effect.exit)));
            assert.lengthOf(offeredMessages, 0);
            yield* fileSystem.writeFile(
              path.join(attachmentsDir, attachmentRelativePath(document)!),
              pdfBytes,
            );
          }
          yield* runtime.startTurn(turnInput);

          const expectedImageBlock = {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "AQIDBA==",
            },
          } as const;
          const expectedDocumentBlock = {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: Buffer.from(pdfBytes).toString("base64"),
            },
          } as const;
          const expectedAttachmentPath = path.join(
            attachmentsDir,
            attachmentRelativePath(attachment)!,
          );
          const expectedDocumentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
          const attachmentNotes = `\n\n[Attached image "diagram.png" is saved at: ${expectedAttachmentPath}]${resumed ? "" : `\n\n[Attached file "requirements.pdf" is saved at: ${expectedDocumentPath}]`}`;
          const requestBlock = { type: "text" as const, text: expectedText + attachmentNotes };
          const expectedContent = command
            ? [
                requestBlock,
                expectedImageBlock,
                ...(!resumed ? [expectedDocumentBlock] : []),
                { type: "text" as const, text: command + attachmentNotes },
              ]
            : [expectedImageBlock, ...(!resumed ? [expectedDocumentBlock] : []), requestBlock];
          assert.deepEqual(offeredMessages[0]?.message.content, expectedContent);

          const providerTurnId = idAllocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${attemptId}`,
          });
          yield* runtime.steerTurn({
            threadId,
            runId: RunId.make("run-claude-attachments"),
            providerThread,
            providerTurnId,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make("message-claude-attachments-steer"),
              text: prompt,
              attachments: resumed ? [attachment] : [attachment, document],
            },
          });

          assert.equal(offeredMessages[1]?.priority, "now");
          assert.deepEqual(offeredMessages[1]?.message.content, expectedContent);
          const documentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
          for (const scenario of [
            "pages",
            "bytes",
            "invalid",
            "invalid-page-tree",
            "object-stream",
            "encrypted",
            "cyclic-tree",
            "unterminated-string",
            "missing-eof",
            "escaped-name",
            "incremental",
            "compressed-bomb",
            "indirect-count",
            "indirect-type",
            "indirect-kids",
            "indirect-101-pages",
            "aggregate-pages",
            "retained-pages",
            "delivery-failure",
            "pasted-text",
            "text-only",
          ]) {
            let attachments: ReadonlyArray<ChatAttachment> = [document];
            if (
              ["pages", "aggregate-pages", "retained-pages", "delivery-failure"].includes(scenario)
            ) {
              const pages = scenario === "pages" ? 101 : scenario === "delivery-failure" ? 30 : 60;
              const large = Buffer.from(
                `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count ${pages} >> endobj\n${Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n")}\n%%EOF`,
              );
              yield* fileSystem.writeFile(documentPath, large);
              if (scenario === "aggregate-pages") {
                const second = {
                  ...document,
                  id: ChatAttachmentId.make("second-pdf"),
                  name: "second.pdf",
                };
                yield* fileSystem.copyFile(
                  documentPath,
                  path.join(attachmentsDir, attachmentRelativePath(second)!),
                );
                attachments = [document, second];
              }
            } else if (scenario.startsWith("indirect-")) {
              const raw =
                scenario === "indirect-count" || scenario === "indirect-101-pages"
                  ? `%PDF-1.7\n1 0 obj ${scenario === "indirect-count" ? 1 : 101} endobj\n2 0 obj << /Type /Catalog /Pages 3 0 R >> endobj\n3 0 obj << /Type /Pages /Count 1 0 R /Kids [${Array.from({ length: scenario === "indirect-count" ? 1 : 101 }, (_, i) => `${i + 4} 0 R`).join(" ")}] >> endobj\n4 0 obj << /Type /Page /Parent 3 0 R >> endobj\n${scenario === "indirect-count" ? "" : Array.from({ length: 100 }, (_, i) => `${i + 5} 0 obj << /Type 105 0 R /Parent 3 0 R >> endobj`).join("\n")}\n105 0 obj /Page endobj\n%%EOF`
                  : scenario === "indirect-type"
                    ? pdfBytes
                        .toString()
                        .replace(
                          "%%EOF",
                          "4 0 obj << /Type 5 0 R >> endobj\n5 0 obj /Annot endobj\n%%EOF",
                        )
                    : pdfBytes
                        .toString()
                        .replace("/Kids [3 0 R]", "/Kids 4 0 R")
                        .replace("%%EOF", "4 0 obj [3 0 R] endobj\n%%EOF");
              yield* fileSystem.writeFileString(documentPath, raw);
            } else if (scenario === "bytes") {
              yield* fileSystem.truncate(documentPath, 20 * 1024 * 1024 + 1);
            } else if (scenario === "invalid") {
              yield* fileSystem.writeFileString(documentPath, "This is not a PDF");
            } else if (scenario === "invalid-page-tree") {
              const malformedBytes = Buffer.from(
                "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 42 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF",
              );
              yield* fileSystem.writeFile(documentPath, malformedBytes);
            } else if (
              ["object-stream", "encrypted", "cyclic-tree", "compressed-bomb"].includes(scenario)
            ) {
              const suffix =
                scenario === "encrypted"
                  ? "/Encrypt 9 0 R"
                  : scenario === "cyclic-tree"
                    ? "/Count 0 /Kids [2 0 R]"
                    : "/Type /ObjStm /Filter /FlateDecode /Length 1000000000";
              yield* fileSystem.writeFile(
                documentPath,
                Buffer.concat([
                  pdfBytes.subarray(0, pdfBytes.length - 5),
                  Buffer.from(`\n4 0 obj << ${suffix} >> stream\nx\nendstream endobj\n%%EOF`),
                ]),
              );
            } else if (
              ["unterminated-string", "missing-eof", "escaped-name", "incremental"].includes(
                scenario,
              )
            ) {
              const raw = pdfBytes.toString();
              yield* fileSystem.writeFileString(
                documentPath,
                scenario === "missing-eof"
                  ? raw.slice(0, -5)
                  : scenario === "escaped-name"
                    ? raw.replace("/Type /Page ", "/Type /Pa#67e ")
                    : raw.replace(
                        "%%EOF",
                        scenario === "incremental" ? "/Prev 42\n%%EOF" : "(unfinished\n%%EOF",
                      ),
              );
            } else if (scenario === "pasted-text") {
              yield* fileSystem.writeFile(documentPath, pdfBytes);
              attachments = [{ ...document, source: { _tag: "pasted-text" } }];
            } else {
              attachments = [];
              yield* fileSystem.remove(documentPath);
            }
            const steering = {
              threadId,
              runId: RunId.make("run-claude-attachments"),
              providerThread,
              providerTurnId,
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: MessageId.make(`message-${scenario}`),
                text: "Continue.",
                attachments,
              },
            } satisfies ProviderAdapter.ProviderAdapterV2SteerInput;
            if (scenario === "delivery-failure") {
              failOffer = true;
              assert.isTrue(Exit.isFailure(yield* runtime.steerTurn(steering).pipe(Effect.exit)));
            }
            yield* runtime.steerTurn(steering);

            const sent = offeredMessages.at(-1)!.message.content;
            const documents =
              typeof sent === "string" ? [] : sent.filter((block) => block.type === "document");
            assert.lengthOf(
              documents,
              ["aggregate-pages", "delivery-failure"].includes(scenario) ? 1 : 0,
              scenario,
            );
            if (scenario === "text-only")
              assert.equal(sent, ultrathink ? "Ultrathink:\nContinue." : "Continue.");
            else assert.include(JSON.stringify(sent), documentPath);
          }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );
});

describe("ClaudeAdapterV2 native fork", () => {
  it.effect("forks at the source assistant cursor and resumes the forked session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-fork-attachments-",
        });
        const openedQueries: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
        const forkCalls: Array<ClaudeAdapterV2.ClaudeAgentSdkSessionForkInput> = [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: { CLAUDE_CONFIG_DIR: "/custom/claude-home" },
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("source-native-session"),
            open: (input) =>
              Effect.sync(() => {
                openedQueries.push(input);
                return {
                  messages: Stream.empty,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: (input) =>
              Effect.sync(() => {
                forkCalls.push(input);
                return { sessionId: "forked-native-session" };
              }),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const providerSessionId = ProviderSessionId.make("provider-session-claude-fork");
        const sourceThreadId = ThreadId.make("thread-claude-fork-source");
        const targetThreadId = ThreadId.make("thread-claude-fork-target");
        const runtime = yield* adapter.openSession({
          threadId: sourceThreadId,
          providerSessionId,
          modelSelection: {
            instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
            model: "claude-sonnet-4-6",
          },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        });
        const sourceProviderThread = yield* runtime.ensureThread({
          threadId: sourceThreadId,
          modelSelection: {
            instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
            model: "claude-sonnet-4-6",
          },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        });
        const now = yield* DateTime.now;
        const providerTurnId = ProviderTurnId.make("provider-turn-claude-source");
        const forkedProviderThread = yield* runtime.forkThread({
          sourceProviderThread,
          sourceProviderTurns: [
            {
              id: providerTurnId,
              providerThreadId: sourceProviderThread.id,
              nodeId: NodeId.make("node-claude-source"),
              runAttemptId: RunAttemptId.make("run-attempt-claude-source"),
              nativeTurnRef: {
                driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                nativeId: "assistant-message-cursor",
                strength: "weak",
              },
              ordinal: 1,
              status: "completed",
              startedAt: now,
              completedAt: now,
            },
          ],
          providerTurnId,
          targetThreadId,
        });

        assert.deepEqual(forkCalls, [
          {
            sessionId: "source-native-session",
            options: {
              dir: "/workspace",
              upToMessageId: "assistant-message-cursor",
            },
            environment: { CLAUDE_CONFIG_DIR: "/custom/claude-home" },
            threadId: targetThreadId,
            providerSessionId,
          },
        ]);
        assert.equal(forkedProviderThread.nativeThreadRef?.nativeId, "forked-native-session");
        assert.equal(forkedProviderThread.forkedFrom?.providerThreadId, sourceProviderThread.id);
        assert.equal(forkedProviderThread.forkedFrom?.providerTurnId, providerTurnId);

        yield* runtime.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: targetThreadId,
            projectId: ProjectId.make("project-claude-fork-target"),
            title: "Claude fork target",
            providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
            modelSelection: {
              instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
              model: "claude-sonnet-4-6",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: forkedProviderThread.id,
            lineage: {
              parentThreadId: sourceThreadId,
              relationshipToParent: "fork",
              rootThreadId: sourceThreadId,
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId: targetThreadId,
          runId: RunId.make("run-claude-fork-target"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("run-attempt-claude-fork-target"),
          rootNodeId: NodeId.make("node-claude-fork-target-root"),
          providerThread: forkedProviderThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-claude-fork-target"),
            text: "Respond with fork ok",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
            model: "claude-sonnet-4-6",
          },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        });

        assert.equal(openedQueries[0]?.options.resume, "forked-native-session");
        assert.equal(openedQueries[0]?.options.sessionId, undefined);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});

function makeFakeClaudeCli(answerSetServers = true) {
  const spawns: Array<SpawnOptions> = [];
  const controlRequests: Array<object> = [];
  const stdins: Array<NodeStream.PassThrough> = [];
  const spawn = (options: SpawnOptions): SpawnedProcess => {
    spawns.push(options);
    const stdin = new NodeStream.PassThrough();
    const stdout = new NodeStream.PassThrough();
    stdins.push(stdin);
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin,
      stdout,
      killed: false,
      exitCode: null as number | null,
      kill: () => {
        stdout.end();
        child.emit("exit", null, "SIGTERM");
        return true;
      },
    });
    let pending = "";
    stdin.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const frame = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (frame.type !== "control_request") continue;
        controlRequests.push(frame.request);
        const setServers = frame.request.subtype === "mcp_set_servers";
        if (setServers && !answerSetServers) continue;
        const response = {
          subtype: "success",
          request_id: frame.request_id,
          response: setServers ? { added: [], removed: [], errors: {} } : {},
        };
        stdout.write(`${JSON.stringify({ type: "control_response", response })}\n`);
      }
    });
    stdin.on("end", () => {
      stdout.end();
      child.emit("exit", 0, null);
    });
    return child;
  };
  const closed = () => stdins.length > 0 && stdins.every((stdin) => stdin.writableEnded);
  return { spawn, spawns, controlRequests, closed };
}

describe("ClaudeAdapterV2 MCP credential channel", () => {
  const t3McpServer = {
    type: "http" as const,
    url: "http://127.0.0.1:43123/mcp",
    headers: { Authorization: "Bearer dummy-mcp-credential" },
  };
  const openWith = (
    cli: ReturnType<typeof makeFakeClaudeCli>,
    native?: ProviderEventLoggers.EventNdjsonLogger,
  ) =>
    Effect.gen(function* () {
      const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
      return yield* runner.open({
        threadId: ThreadId.make("thread-claude-mcp-channel"),
        providerSessionId: ProviderSessionId.make("provider-session-claude-mcp-channel"),
        options: {
          ...ClaudeAdapterV2.makeClaudeQueryOptions({
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            nativeThreadId: "native-thread-claude-mcp-channel",
            resume: false,
            cwd: null,
            environment: { PATH: "/usr/bin" },
            mcpServers: { "t3-code": t3McpServer },
          }),
          pathToClaudeCodeExecutable: "/opt/claude/cli.js",
          spawnClaudeCodeProcess: cli.spawn,
        },
      });
    }).pipe(
      Effect.provide(ClaudeAdapterV2.layerQueryRunner),
      Effect.provideService(ProviderEventLoggers.ProviderEventLoggers, {
        ...ProviderEventLoggers.NoOpProviderEventLoggers,
        native,
      }),
      Effect.provide(NodeServices.layer),
    );

  it.effect("commits queued delivery before interruptible protocol logging", () =>
    Effect.gen(function* () {
      const logging = yield* Deferred.make<void>();
      let committed = false;
      const cli = makeFakeClaudeCli();
      const session = yield* openWith(cli, {
        filePath: "/tmp/claude-queued-delivery.log",
        write: () =>
          committed
            ? Deferred.succeed(logging, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
        close: () => Effect.void,
      });
      const offering = yield* session
        .offer(ClaudeAdapterV2.makeClaudeUserMessage({ text: "Inspect the attachment." }), () => {
          committed = true;
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(logging);
      yield* Fiber.interrupt(offering);
      assert.isTrue(committed);
      committed = false;
      yield* session.close;
    }),
  );

  it.effect("sends MCP servers over stdin, not argv or the environment", () =>
    Effect.gen(function* () {
      const cli = makeFakeClaudeCli();
      const session = yield* openWith(cli);
      yield* session.close;

      assert.deepInclude(cli.controlRequests, {
        subtype: "mcp_set_servers",
        servers: { "t3-code": t3McpServer },
      });
      const spawned = JSON.stringify(cli.spawns);
      assert.notInclude(spawned, "--mcp-config");
      assert.notInclude(spawned, "dummy-mcp-credential");
    }),
  );
});

describe("ClaudeAdapterV2 native session identity", () => {
  const openTurnWithOrdinal = (providerTurnOrdinal: number, nativeThreadHasTurns?: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-session-identity-",
        });
        const openedQueries: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-session-identity"),
            open: (input) =>
              Effect.sync(() => {
                openedQueries.push(input);
                return {
                  messages: Stream.empty,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-session-identity");
        const providerSessionId = ProviderSessionId.make("provider-session-claude-identity");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("run-attempt-claude-session-identity"),
            text: "Respond with identity ok",
            attachments: [],
            providerTurnOrdinal,
            ...(nativeThreadHasTurns === undefined ? {} : { nativeThreadHasTurns }),
          }),
        );
        return openedQueries;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

  it.effect(
    "resumes the native session on a fresh session instance when prior provider turns exist",
    () =>
      Effect.gen(function* () {
        const openedQueries = yield* openTurnWithOrdinal(2);
        assert.equal(openedQueries.length, 1);
        assert.equal(openedQueries[0]?.options.resume, "native-session-identity");
        assert.equal(openedQueries[0]?.options.sessionId, undefined);
      }),
  );

  it.effect("creates a fresh native session despite earlier provider-thread turns", () =>
    Effect.gen(function* () {
      const openedQueries = yield* openTurnWithOrdinal(4, false);
      assert.equal(openedQueries[0]?.options.sessionId, "native-session-identity");
      assert.equal(openedQueries[0]?.options.resume, undefined);
    }),
  );
});

const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const providerThreadJson = Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ProviderThread));
const encodeProviderThreadJson = Schema.encodeEffect(providerThreadJson);
const decodeProviderThreadJson = Schema.decodeUnknownEffect(providerThreadJson);

describe("ClaudeAdapterV2 background wake turns", () => {
  const WAKE_NATIVE_SESSION = "native-thread-claude-wake";
  const WAKE_TASK_ID = "bdqirlcyw";
  const WAKE_TOOL_USE_ID = "toolu_01Rs6JNNf5SqHRxpq5DeJHrW";
  const WAKE_TASK_DESCRIPTION = "Background sleep test";
  const WAKE_SUMMARY = 'Background command "Background sleep test" completed (exit code 0)';
  const WAKE_ASSISTANT_TEXT = "WAKE_DONE";
  const WAKE_RESULT_TEXT = "WAKE_DONE";

  function claudeSdkFrame(frame: unknown): SDKMessage {
    if (
      typeof frame !== "object" ||
      frame === null ||
      typeof Reflect.get(frame, "type") !== "string"
    ) {
      throw new Error("Frame is not a Claude Agent SDK message.");
    }
    return frame as SDKMessage;
  }

  const wakeTaskStarted = claudeSdkFrame({
    type: "system",
    subtype: "task_started",
    task_id: WAKE_TASK_ID,
    tool_use_id: WAKE_TOOL_USE_ID,
    description: WAKE_TASK_DESCRIPTION,
    is_backgrounded: true,
    task_type: "local_bash",
    uuid: "00000000-0000-4000-8000-000000000101",
    session_id: WAKE_NATIVE_SESSION,
  });
  const makeAssistantTextFrame = (input: { readonly uuid: string; readonly text: string }) =>
    claudeSdkFrame({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        id: `msg_${input.uuid}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: input.text }],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const makeAssistantErrorFrame = (input: {
    readonly uuid: string;
    readonly error:
      | "authentication_failed"
      | "invalid_request"
      | "rate_limit"
      | "server_error"
      | undefined;
    readonly text?: string;
    readonly parentToolUseId?: string | null;
    readonly apiErrorParams?: unknown;
  }) =>
    claudeSdkFrame({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        id: `msg_${input.uuid}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: input.text ?? "Claude could not complete this request." }],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: input.parentToolUseId ?? null,
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(input.apiErrorParams === undefined ? {} : { api_error_params: input.apiErrorParams }),
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const makeResultFrame = (input: {
    readonly uuid: string;
    readonly result: string;
    readonly numTurns?: number;
    readonly origin?: { readonly kind: "task-notification" };
    readonly subtype?: string;
    readonly isError?: boolean;
    readonly errors?: ReadonlyArray<string>;
    readonly apiErrorStatus?: number;
    // null omits the field, as the CLI does on a zero-turn result.
    readonly terminalReason?: SDKResultMessage["terminal_reason"] | null;
    readonly usage?: {
      readonly input_tokens: number;
      readonly output_tokens: number;
      readonly cache_creation_input_tokens: number;
      readonly cache_read_input_tokens: number;
    };
  }) =>
    claudeSdkFrame({
      type: "result",
      subtype: input.subtype ?? "success",
      duration_ms: 10,
      duration_api_ms: 10,
      is_error: input.isError ?? false,
      num_turns: input.numTurns ?? 1,
      result: input.result,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: input.usage ?? {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(input.errors === undefined ? {} : { errors: input.errors }),
      ...(input.apiErrorStatus === undefined ? {} : { api_error_status: input.apiErrorStatus }),
      ...(input.terminalReason === null
        ? {}
        : { terminal_reason: input.terminalReason ?? "completed" }),
    });
  const turnOneResult = makeResultFrame({
    uuid: "00000000-0000-4000-8000-000000000102",
    result: "Kicked off the build in the background.",
  });
  const wakeNotification = claudeSdkFrame({
    type: "system",
    subtype: "task_notification",
    task_id: WAKE_TASK_ID,
    tool_use_id: WAKE_TOOL_USE_ID,
    status: "completed",
    output_file: `/tmp/claude-replay/tasks/${WAKE_TASK_ID}.output`,
    summary: WAKE_SUMMARY,
    uuid: "00000000-0000-4000-8000-000000000103",
    session_id: WAKE_NATIVE_SESSION,
  });
  const wakeAssistant = makeAssistantTextFrame({
    uuid: "00000000-0000-4000-8000-000000000107",
    text: WAKE_ASSISTANT_TEXT,
  });
  const wakeTurnInit = claudeSdkFrame({
    type: "system",
    subtype: "init",
    uuid: "00000000-0000-4000-8000-000000000110",
    session_id: WAKE_NATIVE_SESSION,
  });
  const wakeResult = makeResultFrame({
    uuid: "00000000-0000-4000-8000-000000000104",
    result: WAKE_RESULT_TEXT,
    origin: { kind: "task-notification" },
  });
  const STALE_TASK_NOTIFICATION_RESULT_TEXT =
    "Stale task-notification origin text that must not appear.";
  const staleTaskNotificationResult = makeResultFrame({
    uuid: "00000000-0000-4000-8000-000000000106",
    result: STALE_TASK_NOTIFICATION_RESULT_TEXT,
    numTurns: 0,
    origin: { kind: "task-notification" },
    terminalReason: null,
  });

  // Harnesses notify after every recorded event, continuation, or prompt, so a
  // wait re-checks exactly when the state it reads changes. Subscribing before
  // the first check means a change that lands in between is not lost.
  const makeChangeSignal = Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<void>();
    const until = (predicate: () => boolean): Effect.Effect<void> =>
      Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          while (!predicate()) yield* PubSub.take(subscription);
        }),
      );
    return { notify: PubSub.publish(changes, undefined), until };
  });

  // Fixed quiet windows for asserting that nothing happens after input the
  // harness cannot observe being handled (a shut-down query, a replaced process).
  const yieldTicks = (ticks: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (let tick = 0; tick < ticks; tick++) yield* Effect.yieldNow;
    });

  const makeWakeHarnessWithOptions = (options?: {
    readonly close?: (sdkMessages: Queue.Queue<SDKMessage>) => Effect.Effect<void>;
    readonly interrupt?: Effect.Effect<void>;
    readonly setPermissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQuerySession["setPermissionMode"];
    readonly stopTask?: (
      taskId: string,
    ) => Effect.Effect<void, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
    readonly backgroundTasks?: (
      toolUseId: string,
    ) => Effect.Effect<boolean, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
    readonly environment?: NodeJS.ProcessEnv;
    readonly subagentLaunchToolUseId?: string;
    readonly nativeSessionId?: string;
    readonly settings?: ClaudeSettings;
    readonly freshQueueOnReopen?: boolean;
    readonly forkSession?: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape["forkSession"];
    readonly allocateSessionId?: Effect.Effect<string>;
  }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-claude-v2-wake-",
      });
      const sdkMessages = yield* Queue.unbounded<SDKMessage>();
      const processQueues: Array<Queue.Queue<SDKMessage>> = [];
      const processedMessages = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
      const offerAndWait = Effect.fnUntraced(function* (
        message: SDKMessage,
        offered?: Deferred.Deferred<void>,
      ) {
        const processed = yield* Deferred.make<void>();
        processedMessages.set(message, processed);
        yield* Queue.offer(processQueues.at(-1) ?? sdkMessages, message);
        if (offered !== undefined) yield* Deferred.succeed(offered, undefined);
        yield* Deferred.await(processed);
      });
      const changes = yield* makeChangeSignal;
      const offeredMessages: Array<SDKUserMessage> = [];
      const permissionModeChanges: Array<string> = [];
      const liveSelectionChanges: Array<unknown> = [];
      const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
        [];
      const continuationReceipts =
        yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
      const terminalReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
        >();
      const subagentReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }>
        >();
      const systemNoticeReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>
        >();
      const runtimeRequestReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "runtime_request.updated" }>
        >();
      const planReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "plan.updated" }>
        >();
      const providerThreadReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "provider_thread.updated" }>
        >();
      let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
      const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
        settings: options?.settings ?? DEFAULT_CLAUDE_SETTINGS,
        environment: options?.environment ?? {},
        attachmentsDir,
        fileSystem,
        path: yield* Path.Path,
        crypto: yield* Crypto.Crypto,
        idAllocator,
        continuationRequests: {
          offer: (request) =>
            Effect.sync(() => {
              continuationRequests.push(request);
            }).pipe(
              Effect.andThen(Queue.offer(continuationReceipts, request)),
              Effect.andThen(changes.notify),
            ),
        },
        queryRunner: {
          allocateSessionId:
            options?.allocateSessionId ??
            Effect.succeed(options?.nativeSessionId ?? WAKE_NATIVE_SESSION),
          open: (input) =>
            Effect.gen(function* () {
              openedOptions = input.options;
              const processMessages =
                options?.freshQueueOnReopen === true && processQueues.length > 0
                  ? yield* Queue.unbounded<SDKMessage>()
                  : sdkMessages;
              const messages = Stream.fromQueue(processMessages).pipe(
                Stream.flatMap((message) =>
                  Stream.make(message).pipe(
                    Stream.concat(
                      Stream.fromEffect(
                        Effect.suspend(() => {
                          const processed = processedMessages.get(message);
                          return processed === undefined
                            ? Effect.void
                            : Deferred.succeed(processed, undefined);
                        }),
                      ).pipe(Stream.drain),
                    ),
                  ),
                ),
              );
              if (options?.freshQueueOnReopen === true && processQueues.length > 0) {
                processQueues.push(processMessages);
                return {
                  messages,
                  offer: (message: SDKUserMessage) =>
                    Effect.sync(() => {
                      offeredMessages.push(message);
                    }).pipe(Effect.andThen(changes.notify)),
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: (mode) =>
                    Effect.sync(() => {
                      permissionModeChanges.push(mode);
                    }).pipe(
                      Effect.andThen(() => options?.setPermissionMode?.(mode) ?? Effect.void),
                    ),
                  backgroundTasks: options?.backgroundTasks ?? (() => Effect.succeed(false)),
                  stopTask: options?.stopTask ?? (() => Effect.void),
                  interrupt: Effect.void,
                  close: Queue.shutdown(processMessages),
                };
              }
              processQueues.push(sdkMessages);
              return {
                messages,
                offer: (message) =>
                  Effect.sync(() => {
                    offeredMessages.push(message);
                  }).pipe(Effect.andThen(changes.notify)),
                setModel: (model) =>
                  Effect.sync(() => {
                    liveSelectionChanges.push({ model });
                  }),
                applyFlagSettings: (settings) =>
                  Effect.sync(() => {
                    liveSelectionChanges.push(settings);
                  }),
                setPermissionMode: (mode) =>
                  Effect.sync(() => {
                    permissionModeChanges.push(mode);
                  }).pipe(Effect.andThen(() => options?.setPermissionMode?.(mode) ?? Effect.void)),
                backgroundTasks: options?.backgroundTasks ?? (() => Effect.succeed(false)),
                stopTask: options?.stopTask ?? (() => Effect.void),
                interrupt: options?.interrupt ?? Effect.void,
                close: options?.close?.(sdkMessages) ?? Effect.void,
              };
            }),
          forkSession: options?.forkSession ?? (() => Effect.die("unused forkSession")),
          subagentLaunchToolUseId: () => Effect.succeed(options?.subagentLaunchToolUseId ?? null),
          assertComplete: Effect.void,
        },
      });
      const threadId = ThreadId.make("thread-claude-wake");
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-claude-wake"),
        modelSelection: CLAUDE_TEST_MODEL_SELECTION,
        runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: CLAUDE_TEST_MODEL_SELECTION,
        runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
      });
      const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type === "subagent.updated") {
              yield* Queue.offer(subagentReceipts, event);
            }
            if (event.type === "turn.terminal") {
              yield* Queue.offer(terminalReceipts, event);
            }
            if (event.type === "runtime_request.updated") {
              yield* Queue.offer(runtimeRequestReceipts, event);
            }
            if (event.type === "plan.updated") {
              yield* Queue.offer(planReceipts, event);
            }
            if (event.type === "provider_thread.updated") {
              yield* Queue.offer(providerThreadReceipts, event);
            }
            if (event.type === "turn_item.updated" && event.turnItem.type === "system_notice") {
              yield* Queue.offer(systemNoticeReceipts, event);
            }
            yield* changes.notify;
          }),
        ),
        Effect.forkScoped,
      );
      if (runtime.hasPendingBackgroundWork === undefined) {
        throw new Error("Claude adapter runtime must expose hasPendingBackgroundWork.");
      }
      const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
      const terminalEvents = () =>
        events.filter(
          (
            event,
          ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
            event.type === "turn.terminal",
        );
      return {
        attachmentsDir,
        runtime,
        providerThread,
        threadId,
        sdkMessages,
        processQueues,
        offerAndWait,
        offeredMessages,
        promptUuid: (index: number) => {
          const uuid = offeredMessages[index]?.uuid;
          if (uuid === undefined) throw new Error(`No prompt offered at index ${index}.`);
          return uuid;
        },
        permissionModeChanges,
        liveSelectionChanges,
        continuationRequests,
        continuationReceipts,
        events,
        terminalReceipts,
        subagentReceipts,
        systemNoticeReceipts,
        runtimeRequestReceipts,
        planReceipts,
        providerThreadReceipts,
        getOpenedOptions: () => openedOptions,
        terminalEvents,
        hasPendingBackgroundWork,
        until: changes.until,
        awaitTerminal: (count: number) => changes.until(() => terminalEvents().length >= count),
        awaitContinuation: (count: number) =>
          changes.until(() => continuationRequests.length >= count),
      };
    });
  const makeWakeHarness = makeWakeHarnessWithOptions();

  it.effect.each(["release-after", "cancel-after", "release-before", "resume-pending"] as const)(
    "keeps attachment reservations across compaction: %s boundary",
    (outcome) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const backgrounding = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const harness = yield* makeWakeHarnessWithOptions({
          backgroundTasks: () =>
            Deferred.succeed(backgrounding, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(true),
            ),
        });
        const document = ChatFileAttachment.make({
          type: "file",
          id: ChatAttachmentId.make("compacting-document"),
          name: "compacting.pdf",
          mimeType: "application/pdf",
          sizeBytes: 19 * 1024 * 1024,
        });
        const pages = Buffer.from(
          `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 60 >> endobj\n${Array.from({ length: 60 }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n")}\n`,
        );
        yield* fileSystem.writeFile(
          path.join(harness.attachmentsDir, attachmentRelativePath(document)!),
          Buffer.concat([
            pages,
            Buffer.alloc(document.sizeBytes - pages.length - 5, 32),
            Buffer.from("%%EOF"),
          ]),
        );
        const input = makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("compacting-reservation"),
          text: "Audit with a subagent.",
          attachments: [],
        });
        yield* harness.runtime.startTurn(input);
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: "compacting-task",
            tool_use_id: "compacting-tool",
            description: "Audit",
            subagent_type: "general-purpose",
            is_backgrounded: false,
            task_type: "local_agent",
            prompt: "Audit.",
            uuid: "00000000-0000-4000-8000-000000000811",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const steer = harness.runtime.steerTurn({
          threadId: harness.threadId,
          runId: input.runId,
          providerThread: harness.providerThread,
          providerTurnId: idAllocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${input.attemptId}`,
          }),
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("compacting-steer"),
            text: "Read this PDF.",
            attachments: [document],
          },
        });
        const pending = yield* Effect.forkScoped(steer);
        yield* Deferred.await(backgrounding);
        assert.lengthOf(harness.offeredMessages, 1);
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: "compacting",
            uuid: "00000000-0000-4000-8000-000000000812",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        if (outcome === "release-before") {
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(pending);
        }
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "auto", pre_tokens: 1500, post_tokens: 400 },
            uuid: "00000000-0000-4000-8000-000000000813",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        if (outcome === "cancel-after") {
          yield* Fiber.interrupt(pending);
          assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(pending)));
        } else if (outcome === "release-after") {
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(pending);
        }
        // Flush the budget update through the event stream before trying again.
        yield* harness.offerAndWait(
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000814", result: "Read." }),
        );
        yield* Queue.take(harness.terminalReceipts);
        const updates = harness.events.flatMap((event) =>
          event.type === "provider_thread.updated" ? [event.providerThread] : [],
        );
        for (const thread of updates) {
          yield* decodeProviderThreadJson(yield* encodeProviderThreadJson(thread));
        }
        const persisted = yield* decodeProviderThreadJson(
          yield* encodeProviderThreadJson(updates.at(-1)!),
        );
        const usage = persisted.nativeMetadata?.claudeAttachmentBudget;
        const undelivered = outcome === "cancel-after" || outcome === "resume-pending";
        assert.equal(usage?.pagesUsed, undelivered ? 0 : 60);
        if (undelivered) assert.equal(usage?.bytesUsed, 0);
        else assert.isAbove(usage?.bytesUsed ?? 0, 25 * 1024 * 1024);
        const next = outcome === "resume-pending" ? yield* makeWakeHarness : harness;
        const providerThread =
          outcome === "resume-pending"
            ? yield* next.runtime.resumeThread({ providerThread: persisted })
            : persisted;
        if (outcome === "resume-pending") {
          assert.lengthOf(harness.offeredMessages, 1);
          yield* fileSystem.copyFile(
            path.join(harness.attachmentsDir, attachmentRelativePath(document)!),
            path.join(next.attachmentsDir, attachmentRelativePath(document)!),
          );
        }
        yield* next.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: next.threadId,
            providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("after-compacting-reservation"),
            text: "Read this PDF again.",
            attachments: [document],
            providerTurnOrdinal: 2,
            nativeThreadHasTurns: true,
          }),
        );
        if (outcome === "resume-pending") {
          assert.equal(next.getOpenedOptions()?.resume, WAKE_NATIVE_SESSION);
        }
        const delivered = next.offeredMessages.slice(outcome === "resume-pending" ? 0 : 1);
        const documents = delivered.flatMap((message) =>
          Array.isArray(message.message.content)
            ? message.message.content.filter((block) => block.type === "document")
            : [],
        );
        assert.lengthOf(documents, 1);
        assert.isBelow(
          Buffer.byteLength(encodeJsonString(delivered.map((message) => message.message.content))),
          32_000_000,
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  const attachmentBudgetOutcomes = [
    "resume",
    "legacy",
    "compacted",
    "preserved-segment",
    "preserved-messages",
    "failed",
    "stopped",
    "fork-bytes",
    "fork-pages",
  ] as const;
  it.effect.each(attachmentBudgetOutcomes)(
    "restores retained attachment counters after %s",
    (outcome) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const document = ChatFileAttachment.make({
          type: "file",
          id: ChatAttachmentId.make("budget-document"),
          name: "budget.pdf",
          mimeType: "application/pdf",
          sizeBytes: 19 * 1024 * 1024,
        });
        const image = ChatImageAttachment.make({
          type: "image",
          id: ChatAttachmentId.make("budget-image"),
          name: "budget.png",
          mimeType: "image/png",
          sizeBytes: 4 * 1024 * 1024,
        });
        const pages = Buffer.from(
          `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 100 >> endobj\n${Array.from({ length: 100 }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n")}\n`,
        );
        const persisted = yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeWakeHarness;
            yield* fileSystem.writeFile(
              path.join(harness.attachmentsDir, attachmentRelativePath(document)!),
              Buffer.concat([
                pages,
                Buffer.alloc(document.sizeBytes - pages.length - 5, 32),
                Buffer.from("%%EOF"),
              ]),
            );
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("spend-attachment-budget"),
                text: "Read this PDF.",
                attachments: [document],
              }),
            );
            const first = harness.offeredMessages[0]?.message.content;
            assert.isArray(first);
            if (Array.isArray(first)) assert.equal(first[0]?.type, "document");
            if (
              [
                "compacted",
                "preserved-segment",
                "preserved-messages",
                "failed",
                "stopped",
              ].includes(outcome)
            ) {
              yield* harness.offerAndWait(
                claudeSdkFrame({
                  type: "system",
                  subtype: "status",
                  status: "compacting",
                  uuid: "00000000-0000-4000-8000-000000000801",
                  session_id: WAKE_NATIVE_SESSION,
                }),
              );
              yield* harness.offerAndWait(
                claudeSdkFrame(
                  outcome === "compacted" ||
                    outcome === "preserved-segment" ||
                    outcome === "preserved-messages"
                    ? {
                        type: "system",
                        subtype: "compact_boundary",
                        compact_metadata: {
                          trigger: "auto",
                          pre_tokens: 1500,
                          post_tokens: 400,
                          ...(outcome === "preserved-segment"
                            ? {
                                preserved_segment: {
                                  head_uuid: harness.promptUuid(0),
                                  tail_uuid: harness.promptUuid(0),
                                  anchor_uuid: "00000000-0000-4000-8000-000000000802",
                                },
                              }
                            : outcome === "preserved-messages"
                              ? {
                                  preserved_messages: {
                                    anchor_uuid: "00000000-0000-4000-8000-000000000802",
                                    uuids: [harness.promptUuid(0)],
                                  },
                                }
                              : {}),
                        },
                        uuid: "00000000-0000-4000-8000-000000000802",
                        session_id: WAKE_NATIVE_SESSION,
                      }
                    : {
                        type: "system",
                        subtype: "status",
                        status: null,
                        ...(outcome === "failed"
                          ? { compact_result: "failed", compact_error: "Could not compact." }
                          : {}),
                        uuid: "00000000-0000-4000-8000-000000000802",
                        session_id: WAKE_NATIVE_SESSION,
                      },
                ),
              );
            }
            yield* harness.offerAndWait(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000000803",
                result: "Read.",
              }),
            );
            yield* Queue.take(harness.terminalReceipts);
            const event = harness.events.findLast(
              (entry) => entry.type === "provider_thread.updated",
            );
            assert.equal(event?.type, "provider_thread.updated");
            if (event?.type !== "provider_thread.updated")
              return yield* Effect.die("Missing persisted thread");
            const budget = event.providerThread.nativeMetadata?.claudeAttachmentBudget;
            assert.isDefined(budget);
            if (outcome === "compacted") assert.deepEqual(budget, { bytesUsed: 0, pagesUsed: 0 });
            else {
              assert.equal(budget?.pagesUsed, 100);
              assert.isAbove(budget?.bytesUsed ?? 0, 25 * 1024 * 1024);
            }
            // Exercise the same schema boundary as the persisted provider thread.
            return yield* decodeProviderThreadJson(
              yield* encodeProviderThreadJson({
                ...event.providerThread,
                ...(outcome === "legacy" ? { nativeMetadata: null } : {}),
              }),
            );
          }),
        );
        const fork = outcome === "fork-bytes" || outcome === "fork-pages";
        const inherited = fork
          ? yield* Effect.scoped(
              Effect.gen(function* () {
                const harness = yield* makeWakeHarnessWithOptions({
                  forkSession: () =>
                    Effect.succeed({
                      sessionId: "forked-native-session",
                      ...(outcome === "fork-bytes"
                        ? { headMessageId: "forked-assistant-head" }
                        : {}),
                    }),
                });
                const forked = yield* harness.runtime.forkThread({
                  sourceProviderThread: persisted,
                  targetThreadId: harness.threadId,
                });
                return yield* decodeProviderThreadJson(yield* encodeProviderThreadJson(forked));
              }),
            )
          : persisted;
        const resumed = yield* makeWakeHarness;
        const providerThread = yield* resumed.runtime.resumeThread({ providerThread: inherited });
        yield* fileSystem.writeFileString(
          path.join(resumed.attachmentsDir, attachmentRelativePath(document)!),
          "%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF",
        );
        yield* fileSystem.writeFile(
          path.join(resumed.attachmentsDir, attachmentRelativePath(image)!),
          Buffer.alloc(image.sizeBytes, 1),
        );
        yield* resumed.runtime.startTurn({
          ...makeClaudeTestTurnInput({
            threadId: resumed.threadId,
            providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("resume-attachment-budget"),
            text: "Read the PDF and both images.",
            attachments:
              outcome === "fork-bytes"
                ? [image, image]
                : outcome === "fork-pages"
                  ? [document]
                  : [document, image, image],
          }),
          nativeThreadHasTurns: true,
        });
        assert.equal(
          resumed.getOpenedOptions()?.resume,
          fork ? "forked-native-session" : WAKE_NATIVE_SESSION,
        );
        const content = resumed.offeredMessages[0]?.message.content;
        assert.isArray(content);
        if (!Array.isArray(content)) return;
        const native = outcome === "legacy" || outcome === "compacted";
        assert.equal(content.filter((block) => block.type === "document").length, native ? 1 : 0);
        assert.equal(content.filter((block) => block.type === "image").length, native ? 2 : 0);
        assert.isBelow(Buffer.byteLength(encodeJsonString(content)), 32_000_000);
        if (fork) {
          assert.deepEqual(
            inherited.nativeMetadata?.claudeAttachmentBudget,
            persisted.nativeMetadata?.claudeAttachmentBudget,
          );
          assert.equal(
            inherited.nativeMetadata?.forkHeadMessageId,
            outcome === "fork-bytes" ? "forked-assistant-head" : undefined,
          );
          assert.isBelow(
            (persisted.nativeMetadata?.claudeAttachmentBudget?.bytesUsed ?? 0) +
              Buffer.byteLength(encodeJsonString(content)),
            32_000_000,
          );
          assert.include(encodeJsonString(content), "budget.");
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  describe("Claude settings restrictions", () => {
    it.effect("resolves cached managed policy from the configured home through the real SDK", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-remote-" });
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-remote-cwd-" });
        const remoteFile = path.join(home, "remote-settings.json");
        const sdk = yield* Effect.promise(() =>
          vi.importActual<typeof ClaudeSdk>("@anthropic-ai/claude-agent-sdk"),
        );
        vi.mocked(ClaudeSdk.resolveSettings).mockImplementation(sdk.resolveSettings);
        const open = Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeWakeHarnessWithOptions({
              settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath: home },
            });
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("attempt-cached-managed-policy"),
                text: "Run git status.",
                attachments: [],
                runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  cwd,
                }),
              }),
            );
            return harness.getOpenedOptions()!;
          }),
        );
        yield* fileSystem.writeFileString(
          remoteFile,
          JSON.stringify({
            permissions: { disableBypassPermissionsMode: "disable" },
            disableAutoMode: "disable",
            managedSourcesBehavior: "merge",
          }),
        );
        const restricted = yield* open;
        assert.equal(restricted.permissionMode, "default");
        assert.isUndefined(restricted.allowDangerouslySkipPermissions);
        yield* fileSystem.remove(remoteFile);
        assert.equal((yield* open).permissionMode, "bypassPermissions");
        yield* fileSystem.writeFileString(remoteFile, "{ invalid json");
        assert.equal((yield* open).permissionMode, "auto");
        yield* fileSystem.remove(remoteFile);
        yield* fileSystem.makeDirectory(remoteFile);
        assert.equal((yield* open).permissionMode, "auto");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect("asks before restricted Full access tools and follows policy across turns", () =>
      Effect.gen(function* () {
        const resolveSettings = vi
          .mocked(ClaudeSdk.resolveSettings)
          .mockImplementation(async (options) => ({
            effective:
              options?.cwd === "/unrestricted"
                ? {}
                : {
                    permissions: {
                      disableBypassPermissionsMode: "disable",
                      ...(options?.cwd === "/restricted-worktree"
                        ? { disableAutoMode: "disable" as const }
                        : {}),
                    },
                  },
            provenance: {},
            sources: [],
          }));
        const harness = yield* makeWakeHarnessWithOptions({
          close: Queue.shutdown,
          freshQueueOnReopen: true,
          setPermissionMode: (mode) =>
            mode === "bypassPermissions"
              ? Effect.fail(
                  new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                    method: "setPermissionMode",
                    cause: new Error(
                      "Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration",
                    ),
                  }),
                )
              : Effect.void,
        });
        const now = yield* DateTime.now;
        let ordinal = 0;
        const start = (cwd: string, runtimeMode: "full-access" | "auto" = "full-access") =>
          harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make(`attempt-policy-${++ordinal}`),
              providerTurnOrdinal: ordinal,
              text: "Run git status.",
              attachments: [],
              runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                runtimeMode,
                interactionMode: "default",
                cwd,
              }),
            }),
          );
        const finish = Effect.gen(function* () {
          yield* harness.offerAndWait(
            makeResultFrame({ uuid: `policy-result-${ordinal}`, result: "Done." }),
          );
          yield* Queue.take(harness.terminalReceipts);
        });
        const notices = () =>
          harness.events.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
          );

        yield* start("/restricted-worktree", "auto");
        assert.equal(harness.getOpenedOptions()?.permissionMode, "auto");
        yield* finish;
        assert.equal(notices().length, 0);
        assert.equal(resolveSettings.mock.calls.length, 0);

        yield* start("/restricted");
        const openedOptions = harness.getOpenedOptions()!;
        const decision = yield* Effect.promise(() =>
          openedOptions.canUseTool!(
            "Bash",
            { command: "git status" },
            {
              signal: new AbortController().signal,
              toolUseID: "policy-command",
              requestId: "request-policy-command",
            },
          ),
        ).pipe(Effect.forkScoped);
        const first = yield* Effect.raceFirst(
          Queue.take(harness.runtimeRequestReceipts).pipe(
            Effect.map((event) => ({ type: "request", event }) as const),
          ),
          Fiber.join(decision).pipe(
            Effect.map((result) => ({ type: "decision", result }) as const),
          ),
        );
        assert.equal(
          first.type,
          "request",
          "Full access must not auto-allow a policy-restricted command",
        );
        if (first.type !== "request") return;
        assert.equal(first.event.runtimeRequest.kind, "command");
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: first.event.runtimeRequest.id,
          decision: "decline",
        });
        assert.equal((yield* Fiber.join(decision))?.behavior, "deny");
        assert.equal(openedOptions.permissionMode, "auto");
        assert.isUndefined(openedOptions.allowDangerouslySkipPermissions);

        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: null,
            permissionMode: "plan",
            uuid: "policy-enter-plan",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* finish;
        assert.equal(notices().length, 1);
        yield* start("/restricted");
        assert.strictEqual(harness.getOpenedOptions(), openedOptions);
        assert.deepEqual(harness.permissionModeChanges, ["auto"]);
        assert.equal(resolveSettings.mock.calls.length, 1);
        yield* finish;

        yield* start("/restricted-worktree");
        assert.equal(harness.getOpenedOptions()?.permissionMode, "default");
        assert.isUndefined(harness.getOpenedOptions()?.allowDangerouslySkipPermissions);
        assert.equal(resolveSettings.mock.calls.length, 2);
        yield* finish;

        yield* start("/unrestricted");
        assert.equal(harness.getOpenedOptions()?.permissionMode, "bypassPermissions");
        assert.equal(harness.getOpenedOptions()?.allowDangerouslySkipPermissions, true);
        // Forwarded asks (including ask rules and settings fallback) still need a decision
        // before queued init/status frames arrive.
        for (const { phase, frame } of [
          {
            phase: "init",
            frame: claudeSdkFrame({
              type: "system",
              subtype: "init",
              permissionMode: "bypassPermissions",
              uuid: "policy-cli-init",
              session_id: WAKE_NATIVE_SESSION,
            }),
          },
          {
            phase: "status",
            frame: claudeSdkFrame({
              type: "system",
              subtype: "status",
              status: null,
              permissionMode: "default",
              uuid: "policy-cli-downgrade",
              session_id: WAKE_NATIVE_SESSION,
            }),
          },
        ]) {
          const forwardedDecision = yield* Effect.promise(() =>
            harness.getOpenedOptions()!.canUseTool!(
              "Bash",
              { command: "git status" },
              {
                signal: new AbortController().signal,
                toolUseID: `forwarded-before-${phase}`,
                requestId: `request-forwarded-before-${phase}`,
              },
            ),
          ).pipe(Effect.forkScoped);
          const forwardedFirst = yield* Effect.raceFirst(
            Queue.take(harness.runtimeRequestReceipts).pipe(
              Effect.map((event) => ({ type: "request", event }) as const),
            ),
            Fiber.join(forwardedDecision).pipe(
              Effect.map((result) => ({ type: "decision", result }) as const),
            ),
          );
          assert.equal(
            forwardedFirst.type,
            "request",
            `CLI-forwarded Bash must ask before the queued ${phase} frame reaches the adapter`,
          );
          if (forwardedFirst.type !== "request") return;
          assert.equal(forwardedFirst.event.runtimeRequest.kind, "command");
          yield* harness.runtime.respondToRuntimeRequest({
            requestId: forwardedFirst.event.runtimeRequest.id,
            decision: "decline",
          });
          assert.equal((yield* Fiber.join(forwardedDecision))?.behavior, "deny");
          yield* harness.offerAndWait(frame);
        }
        yield* finish;
        const unrestrictedOptions = harness.getOpenedOptions();
        yield* start("/unrestricted");
        assert.strictEqual(harness.getOpenedOptions(), unrestrictedOptions);
        assert.deepEqual(
          harness.permissionModeChanges,
          ["auto"],
          "A CLI policy downgrade must not be restored to bypass on the next turn",
        );
        assert.equal(resolveSettings.mock.calls.length, 3);
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: null,
            permissionMode: "plan",
            uuid: "policy-restricted-enter-plan",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* finish;
        assert.equal(notices().length, 1);

        for (const phase of ["restore", "reuse"]) {
          const started = yield* start("/unrestricted").pipe(Effect.exit);
          assert.isTrue(
            Exit.isSuccess(started),
            `A rejected bypass restore must not fail the ${phase} turn`,
          );
          assert.strictEqual(harness.getOpenedOptions(), unrestrictedOptions);
          assert.deepEqual(harness.permissionModeChanges, ["auto", "bypassPermissions", "default"]);
          assert.equal(harness.offeredMessages.length, ordinal);
          const restoredDecision = yield* Effect.promise(() =>
            harness.getOpenedOptions()!.canUseTool!(
              "Bash",
              { command: "git status" },
              {
                signal: new AbortController().signal,
                toolUseID: `forwarded-after-plan-${phase}`,
                requestId: `request-after-plan-${phase}`,
              },
            ),
          ).pipe(Effect.forkScoped);
          const restoredFirst = yield* Effect.raceFirst(
            Queue.take(harness.runtimeRequestReceipts).pipe(
              Effect.map((event) => ({ type: "request", event }) as const),
            ),
            Fiber.join(restoredDecision).pipe(
              Effect.map((result) => ({ type: "decision", result }) as const),
            ),
          );
          assert.equal(restoredFirst.type, "request");
          if (restoredFirst.type !== "request") return;
          assert.equal(restoredFirst.event.runtimeRequest.kind, "command");
          yield* harness.runtime.respondToRuntimeRequest({
            requestId: restoredFirst.event.runtimeRequest.id,
            decision: "decline",
          });
          assert.equal((yield* Fiber.join(restoredDecision))?.behavior, "deny");
          yield* finish;
          assert.equal(harness.terminalEvents().at(-1)?.status, "completed");
        }
        assert.equal(notices().length, 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    // regression: #21806 bypass policy reads the custom home and project, never ambient ~/.claude
    it.effect(
      "combines a normalized custom home with project policy without reading the ambient user tier",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-policy-home-",
          });
          yield* fileSystem.makeDirectory(path.join(home, "profile"));
          yield* fileSystem.writeFileString(
            path.join(home, "profile", "settings.json"),
            `{
          // Claude accepts comments and trailing commas.
          "permissions": { "disableBypassPermissionsMode": "disable", },
        }`,
          );
          const resolveSettings = vi.mocked(ClaudeSdk.resolveSettings).mockResolvedValue({
            effective: { disableAutoMode: "disable" },
            provenance: {},
            sources: [{ source: "project", settings: { disableAutoMode: "disable" } }],
          });
          const harness = yield* makeWakeHarnessWithOptions({
            settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath: " ~/profile " },
          }).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-custom-home"),
              text: "Run git status.",
              attachments: [],
            }),
          );
          assert.equal(harness.getOpenedOptions()?.permissionMode, "default");
          assert.isUndefined(harness.getOpenedOptions()?.allowDangerouslySkipPermissions);
          assert.deepEqual(resolveSettings.mock.calls[0]?.[0]?.settingSources, [
            "project",
            "local",
          ]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
    );

    // regression: #21806 only a missing custom settings file is benign; bad policy fails
    it.effect(
      "distinguishes missing custom settings from unreadable, malformed, or unresolved policy",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-policy-failure-",
          });
          const settingsFile = path.join(home, "settings.json");
          const open = Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeWakeHarnessWithOptions({
                settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath: home },
              });
              yield* harness.runtime.startTurn(
                makeClaudeTestTurnInput({
                  threadId: harness.threadId,
                  providerThread: harness.providerThread,
                  now: yield* DateTime.now,
                  attemptId: RunAttemptId.make("attempt-settings-failure"),
                  text: "Run git status.",
                  attachments: [],
                }),
              );
              return harness.getOpenedOptions()!;
            }),
          );
          assert.equal((yield* open).permissionMode, "bypassPermissions");
          yield* fileSystem.makeDirectory(settingsFile);
          const unreadable = yield* open;
          assert.equal(unreadable.permissionMode, "auto");
          assert.isUndefined(unreadable.allowDangerouslySkipPermissions);
          yield* fileSystem.remove(settingsFile, { recursive: true });
          yield* fileSystem.writeFileString(settingsFile, "{ invalid json");
          assert.equal((yield* open).permissionMode, "auto");
          yield* fileSystem.remove(settingsFile);
          const resolveSettings = vi
            .mocked(ClaudeSdk.resolveSettings)
            .mockClear()
            .mockRejectedValueOnce(new Error("Cannot resolve managed settings"))
            .mockResolvedValue({ effective: {}, provenance: {}, sources: [] });
          const harness = yield* makeWakeHarnessWithOptions({
            settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath: home },
            close: Queue.shutdown,
            freshQueueOnReopen: true,
          });
          for (const ordinal of [1, 2]) {
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make(`attempt-settings-recovery-${ordinal}`),
                providerTurnOrdinal: ordinal,
                text: "Run git status.",
                attachments: [],
              }),
            );
            const options = harness.getOpenedOptions()!;
            assert.equal(
              options.permissionMode,
              ordinal === 1 ? "auto" : "bypassPermissions",
              "A transient resolver failure must only downgrade the failing turn",
            );
            if (ordinal === 1) assert.isUndefined(options.allowDangerouslySkipPermissions);
            else assert.equal(options.allowDangerouslySkipPermissions, true);
            assert.equal(resolveSettings.mock.calls.length, ordinal);
            yield* harness.offerAndWait(
              makeResultFrame({ uuid: `settings-recovery-result-${ordinal}`, result: "Done." }),
            );
            assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
          }
          assert.equal(harness.offeredMessages.length, 2);
          assert.equal(
            resolveSettings.mock.calls[0]?.[0]?.cwd,
            resolveSettings.mock.calls[1]?.[0]?.cwd,
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
    );

    it.effect("pins tool search on when the user's Claude settings choose auto", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-tool-search-",
        });
        const openedToolSearch = (
          settingsJson: string,
          cwd = CLAUDE_TEST_RUNTIME_POLICY.cwd,
          environment?: NodeJS.ProcessEnv,
        ) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* fileSystem.writeFileString(path.join(home, "settings.json"), settingsJson);
              const harness = yield* makeWakeHarnessWithOptions({
                settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath: home },
                ...(environment === undefined ? {} : { environment }),
              });
              yield* harness.runtime.startTurn(
                makeClaudeTestTurnInput({
                  threadId: harness.threadId,
                  providerThread: harness.providerThread,
                  now: yield* DateTime.now,
                  attemptId: RunAttemptId.make("attempt-tool-search"),
                  text: "Run git status.",
                  attachments: [],
                  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                    ...CLAUDE_TEST_RUNTIME_POLICY,
                    cwd,
                  }),
                }),
              );
              const settings = harness.getOpenedOptions()?.settings;
              return typeof settings === "object" ? settings.env?.ENABLE_TOOL_SEARCH : undefined;
            }),
          );
        assert.equal(yield* openedToolSearch('{"env":{"ENABLE_TOOL_SEARCH":"auto"}}'), "true");
        assert.isUndefined(yield* openedToolSearch('{"env":{"ENABLE_TOOL_SEARCH":"false"}}'));
        assert.isUndefined(yield* openedToolSearch("{}"));

        // Claude Code keeps the local file at the repository root, the main checkout's root in a
        // worktree, and that file beats the user's settings.
        const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-repo-" });
        const worktree = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-wt-" });
        const worktreeGitDir = path.join(repo, ".git", "worktrees", "wt");
        yield* fileSystem.makeDirectory(worktreeGitDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(worktreeGitDir, "commondir"), "../..\n");
        yield* fileSystem.writeFileString(
          path.join(worktree, ".git"),
          `gitdir: ${worktreeGitDir}\n`,
        );
        yield* fileSystem.makeDirectory(path.join(repo, ".claude"));
        yield* fileSystem.makeDirectory(path.join(repo, "packages", "app"), { recursive: true });
        const rootLocal = (value: string) =>
          fileSystem.writeFileString(
            path.join(repo, ".claude", "settings.local.json"),
            `{"env":{"ENABLE_TOOL_SEARCH":"${value}"}}`,
          );
        const userAuto = '{"env":{"ENABLE_TOOL_SEARCH":"auto"}}';
        yield* rootLocal("auto");
        assert.equal(yield* openedToolSearch("{}", worktree), "true");
        yield* rootLocal("false");
        assert.isUndefined(yield* openedToolSearch(userAuto, worktree));
        assert.isUndefined(yield* openedToolSearch(userAuto, path.join(repo, "packages", "app")));

        // Project settings beat user settings, and the process env applies only when no file sets it.
        const project = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-project-" });
        yield* fileSystem.makeDirectory(path.join(project, ".claude"));
        yield* fileSystem.writeFileString(
          path.join(project, ".claude", "settings.json"),
          '{"env":{"ENABLE_TOOL_SEARCH":"auto"}}',
        );
        assert.equal(
          yield* openedToolSearch('{"env":{"ENABLE_TOOL_SEARCH":"false"}}', project),
          "true",
        );
        assert.equal(
          yield* openedToolSearch("{}", CLAUDE_TEST_RUNTIME_POLICY.cwd, {
            ENABLE_TOOL_SEARCH: "auto",
          }),
          "true",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );
  });

  describe("Plan-mode tool approval", () => {
    const openPlanTurn = Effect.fn("openPlanTurn")(function* (
      runtimeMode: "auto" | "full-access",
      approvalPolicy?: "never",
    ) {
      const harness = yield* makeWakeHarness;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode,
        interactionMode: "plan",
        cwd: "/workspace",
        ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
      });
      const input = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("attempt-claude-plan-write"),
        text: "Investigate before implementing.",
        attachments: [],
        runtimePolicy,
      });
      yield* harness.runtime.startTurn({
        ...input,
        appThread: { ...input.appThread, runtimeMode, interactionMode: "plan" },
      });
      assert.equal(harness.getOpenedOptions()?.permissionMode, "plan");
      const canUseTool = harness.getOpenedOptions()?.canUseTool;
      assert.isDefined(canUseTool);
      return { ...harness, canUseTool: canUseTool! };
    });

    const requestWrite = Effect.fn("requestPlanWrite")(function* (
      turn: Effect.Success<ReturnType<typeof openPlanTurn>>,
      toolName: string,
      toolInput: Record<string, unknown>,
      options?: { toolUseID: string; agentID?: string },
    ) {
      const decision = yield* Effect.promise(() =>
        turn.canUseTool(toolName, toolInput, {
          signal: new AbortController().signal,
          toolUseID: options?.toolUseID ?? "tool-plan-write",
          requestId: "request-plan-write",
          ...(options?.agentID === undefined ? {} : { agentID: options.agentID }),
        }),
      ).pipe(Effect.forkScoped);
      const first = yield* Effect.raceFirst(
        Queue.take(turn.runtimeRequestReceipts).pipe(
          Effect.map((event) => ({ type: "request", event }) as const),
        ),
        Fiber.join(decision).pipe(Effect.map((result) => ({ type: "decision", result }) as const)),
      );
      return { first, decision };
    });

    it.effect.each([
      {
        runtimeMode: "auto",
        toolName: "Edit",
        toolInput: {
          file_path: "/workspace/target.txt",
          old_string: "before",
          new_string: "after",
        },
        kind: "file-change",
        decision: "accept",
        behavior: "allow",
      },
      {
        runtimeMode: "full-access",
        toolName: "Bash",
        toolInput: { command: "echo after > target.txt" },
        kind: "command",
        decision: "cancel",
        behavior: "deny",
      },
    ] as const)(
      "asks before $toolName in $runtimeMode Plan, then respects $decision",
      ({ runtimeMode, toolName, toolInput, kind, decision, behavior }) =>
        Effect.gen(function* () {
          const turn = yield* openPlanTurn(runtimeMode);
          const permission = yield* requestWrite(turn, toolName, toolInput);
          assert.equal(permission.first.type, "request", "the planned write bypassed approval");
          if (permission.first.type !== "request") return;
          const request = permission.first.event.runtimeRequest;
          assert.equal(request.status, "pending");
          assert.equal(request.kind, kind);
          yield* turn.runtime.respondToRuntimeRequest({ requestId: request.id, decision });
          const result = yield* Fiber.join(permission.decision);
          assert.equal(result?.behavior, behavior);
          if (result?.behavior === "allow") {
            assert.deepEqual(result.updatedInput, toolInput);
            assert.equal(result.toolUseID, "tool-plan-write");
          }
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
    );

    it.effect("denies Plan writes without asking when approvals are never allowed", () =>
      Effect.gen(function* () {
        const turn = yield* openPlanTurn("full-access", "never");
        const permission = yield* requestWrite(turn, "Bash", {
          command: "echo after > target.txt",
        });
        assert.equal(permission.first.type, "decision", "Never raised an approval request");
        if (permission.first.type !== "decision") return;
        assert.equal(permission.first.result?.behavior, "deny");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect(
      "returns approval feedback to the requesting tool without sending a parent prompt",
      () =>
        Effect.gen(function* () {
          const turn = yield* openPlanTurn("full-access");
          const parentPermission = yield* requestWrite(
            turn,
            "Bash",
            { command: "git status" },
            { toolUseID: "parent-command" },
          );
          assert.equal(parentPermission.first.type, "request");
          if (parentPermission.first.type !== "request") return;
          const permission = yield* requestWrite(
            turn,
            "Bash",
            { command: "rm -f $W/*/*.obj" },
            { toolUseID: "child-command", agentID: "child-worker" },
          );
          assert.equal(permission.first.type, "request");
          if (permission.first.type !== "request") return;
          const request = permission.first.event.runtimeRequest;
          assert.equal(request.responseCapability.type, "live");
          assert.isTrue(
            request.responseCapability.type === "live" &&
              request.responseCapability.supportsFeedback,
          );
          yield* turn.runtime.respondToRuntimeRequest({
            requestId: request.id,
            decision: "decline",
            feedback: "Run it in a safer manner.",
          });
          const result = yield* Fiber.join(permission.decision);
          assert.equal(result?.behavior, "deny");
          if (result?.behavior === "deny") {
            assert.include(result.message, "Run it in a safer manner.");
            assert.notProperty(result, "interrupt");
          }
          assert.equal(turn.offeredMessages.length, 1);
          yield* turn.runtime.respondToRuntimeRequest({
            requestId: parentPermission.first.event.runtimeRequest.id,
            decision: "accept",
          });
          const parentResult = yield* Fiber.join(parentPermission.decision);
          assert.equal(parentResult?.behavior, "allow");
          if (parentResult?.behavior === "allow")
            assert.equal(parentResult.toolUseID, "parent-command");
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
    );

    it.effect("still captures ExitPlanMode when Plan approvals are never allowed", () =>
      Effect.gen(function* () {
        const turn = yield* openPlanTurn("full-access", "never");
        const markdown = "# Proposed work\n\nFix the calculation after approval.";
        const result = yield* Effect.promise(() =>
          turn.canUseTool(
            "ExitPlanMode",
            { plan: markdown },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-plan-capture",
              requestId: "request-plan-capture",
            },
          ),
        );
        assert.equal(result?.behavior, "deny");
        if (result?.behavior === "deny")
          assert.include(result.message, "captured your proposed plan");
        const event = yield* Queue.take(turn.planReceipts);
        assert.equal(event.plan.kind, "proposed_plan");
        assert.equal(event.plan.kind === "proposed_plan" ? event.plan.markdown : "", markdown);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );
  });

  it.effect(
    "carries earlier user-only skill instructions on sends and steering with attachments",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skill-dispatch-" });
        for (const [name, userOnly] of [
          ["interrogate", true],
          ["implement", true],
          ["review", false],
        ] as const) {
          const directory = path.join(homePath, "skills", name);
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* fs.writeFileString(
            path.join(directory, "SKILL.md"),
            `---\nname: ${name}\ndisable-model-invocation: ${userOnly}\n---\nFollow the ${name} instructions.\n`,
          );
        }
        const harness = yield* makeWakeHarnessWithOptions({
          settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath },
        });
        const input = makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("skill-dispatch"),
          text: "$interrogate then $review then $implement the fixes",
          attachments: [],
          runtimePolicy: { ...CLAUDE_TEST_RUNTIME_POLICY, cwd: homePath },
        });
        yield* harness.runtime.startTurn(input);

        const leadingText = `Ultrathink:\n/interrogate [The user invoked this skill. Follow the instructions at: ${path.join(homePath, "skills", "interrogate", "SKILL.md")}] then /review then /implement the fixes`;
        assert.deepEqual(harness.offeredMessages[0]?.message.content, [
          { type: "text", text: leadingText },
          { type: "text", text: "/implement the fixes" },
        ]);

        const attachment = ChatFileAttachment.make({
          type: "file",
          id: ChatAttachmentId.make("skill-dispatch-12345678-1234-1234-1234-123456789abc"),
          name: "requirements.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4,
        });
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        yield* harness.runtime.steerTurn({
          threadId: harness.threadId,
          runId: input.runId,
          providerThread: harness.providerThread,
          providerTurnId: idAllocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${input.attemptId}`,
          }),
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("skill-dispatch-steer"),
            text: input.message.text,
            attachments: [attachment],
          },
        });
        const attachmentNote = `\n\n[Attached file "requirements.pdf" is saved at: ${path.join(harness.attachmentsDir, attachmentRelativePath(attachment)!)}]`;
        assert.equal(harness.offeredMessages[1]?.priority, "now");
        assert.deepEqual(harness.offeredMessages[1]?.message.content, [
          { type: "text", text: `${leadingText}${attachmentNote}` },
          { type: "text", text: `/implement the fixes${attachmentNote}` },
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  // regression: #15475 MCP title arriving after the tool starts must survive to completion
  it.effect.each([
    { isError: false, title: "Check weather" },
    { isError: true, title: "Check weather" },
    { isError: false, title: undefined },
  ])("keeps late MCP display metadata with %j", ({ isError, title }) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("mcp-presentation"),
          text: "Check the weather",
          attachments: [],
        }),
      );
      const toolName = "mcp__weather__get_weather";
      const id = "weather-call";
      const permission = yield* Effect.promise(() =>
        harness.getOpenedOptions()!.canUseTool!(
          toolName,
          { city: "Berlin" },
          {
            signal: new AbortController().signal,
            toolUseID: id,
            requestId: "weather-request",
          },
        ),
      ).pipe(Effect.forkScoped);
      const request = yield* Queue.take(harness.runtimeRequestReceipts);
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: request.runtimeRequest.id,
        decision: "accept",
      });
      yield* Fiber.join(permission);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "assistant",
          uuid: "weather-assistant",
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          message: {
            id: "weather-message",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "tool_use", id, name: toolName, input: { city: "Berlin" } }],
          },
          tool_use_meta: [
            {
              id,
              display_name: title,
              server_display_name: "Weather",
              icon_url: "https://example.com/weather.png",
            },
          ],
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "user",
          uuid: "weather-result",
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: id,
                content: "Weather result",
                is_error: isError,
              },
            ],
          },
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({ uuid: "weather-terminal", result: "Weather checked" }),
      );
      yield* Queue.take(harness.terminalReceipts);
      const items = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        items.map((item) => item.status),
        ["running", "running", isError ? "failed" : "completed"],
      );
      assert.isNull(items[0]?.title);
      for (const item of items.slice(1)) {
        assert.equal(item.title, title ?? "get weather");
        assert.deepEqual(item.toolIcon, {
          _tag: "themed-logo",
          logoUrl: "https://example.com/weather.png",
        });
        assert.deepEqual(item.toolSource, {
          key: "mcp:weather",
          name: "Weather",
          kind: "integration",
          icon: { _tag: "themed-logo", logoUrl: "https://example.com/weather.png" },
        });
        assert.deepEqual(item.input, { city: "Berlin" });
      }
      assert.equal(new Set(items.map((item) => item.id)).size, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect(
    "applies model, effort and Fast changes to a process running a background shell, but not thinking or a cleared effort",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const normal = {
            instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
            model: "claude-opus-5-5",
          } satisfies ModelSelection;
          const turn = (ordinal: number, modelSelection: ModelSelection) =>
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make(`attempt-normal-background:${ordinal}`),
              text: `Request ${ordinal}`,
              attachments: [],
              providerTurnOrdinal: ordinal,
              modelSelection,
            });
          const settle = Effect.gen(function* () {
            yield* harness.offerAndWait(turnOneResult);
            yield* Queue.take(harness.terminalReceipts);
          });
          yield* harness.runtime.startTurn(turn(1, normal));
          const originalOptions = harness.getOpenedOptions();
          yield* harness.offerAndWait(wakeTaskStarted);
          yield* settle;
          assert.isTrue(yield* harness.hasPendingBackgroundWork);

          yield* harness.runtime.startTurn(
            turn(2, { ...normal, options: [{ id: "fastMode", value: false }] }),
          );
          yield* settle;
          assert.deepEqual(harness.liveSelectionChanges, []);

          yield* harness.runtime.startTurn(
            turn(3, {
              ...normal,
              options: [
                { id: "effort", value: "ultracode" },
                { id: "fastMode", value: true },
              ],
            }),
          );
          yield* settle;
          yield* harness.runtime.startTurn(turn(4, { ...normal, model: "claude-sonnet-4-6" }));
          yield* settle;
          assert.deepEqual(harness.liveSelectionChanges, [
            { model: "claude-opus-5-5" },
            { effortLevel: "xhigh", fastMode: true, ultracode: true },
            { model: "claude-sonnet-4-6" },
            { effortLevel: "high", fastMode: null, ultracode: null },
          ]);
          assert.strictEqual(harness.getOpenedOptions(), originalOptions);
          assert.lengthOf(harness.offeredMessages, 4);

          for (const [ordinal, selection] of [
            [5, CLAUDE_TEST_RESTART_MODEL_SELECTION],
            [6, { ...normal, model: "claude-haiku-4-5-20251001" }],
          ] as const) {
            const refused = yield* harness.runtime
              .startTurn(turn(ordinal, selection))
              .pipe(Effect.result);
            assert.equal(refused._tag, "Failure");
            if (refused._tag === "Failure") {
              assert.instanceOf(
                refused.failure.cause,
                ClaudeAdapterV2.ClaudeBackgroundWorkBlocksQueryReplacementError,
              );
            }
          }
          assert.strictEqual(harness.getOpenedOptions(), originalOptions);
          assert.lengthOf(harness.offeredMessages, 4);
          assert.lengthOf(harness.liveSelectionChanges, 4);
          assert.isTrue(yield* harness.hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect.each(["completed", "interrupted"] as const)(
    "projects Claude thinking blocks when %s",
    (status) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("reasoning-attempt"),
            text: "Check the plan",
            attachments: [],
          }),
        );
        const stream = (event: unknown, parent: string | null = null) =>
          claudeSdkFrame({
            type: "stream_event",
            event,
            parent_tool_use_id: parent,
            session_id: WAKE_NATIVE_SESSION,
            uuid: "stream-frame",
          });
        const snapshot = (id: string, uuid: string, thinking: string) =>
          claudeSdkFrame({
            type: "assistant",
            uuid,
            session_id: WAKE_NATIVE_SESSION,
            parent_tool_use_id: null,
            message: {
              id,
              model: "claude-sonnet-4-6",
              content: [{ type: "thinking", thinking, signature: "secret-signature" }],
            },
          });
        const frames = [
          stream({ type: "message_start", message: { id: "thought-message" } }),
          stream({
            type: "content_block_start",
            index: 2,
            content_block: { type: "thinking", thinking: "" },
          }),
          stream({
            type: "content_block_delta",
            index: 2,
            delta: { type: "thinking_delta", thinking: "First " },
          }),
          stream({
            type: "content_block_delta",
            index: 2,
            delta: { type: "thinking_delta", thinking: "thought" },
          }),
          stream({
            type: "content_block_delta",
            index: 2,
            delta: { type: "signature_delta", signature: "secret-signature" },
          }),
          stream({ type: "content_block_stop", index: 2 }),
          snapshot("thought-message", "first-snapshot", "Authoritative first thought"),
          snapshot("thought-message", "first-snapshot", "Authoritative first thought"),
          stream({
            type: "content_block_start",
            index: 4,
            content_block: { type: "thinking", thinking: "Second thought" },
          }),
          stream({ type: "content_block_stop", index: 4 }),
          snapshot("thought-message", "second-snapshot", ""),
          snapshot("completion-only", "third-snapshot", "Completion only"),
          snapshot("redacted", "empty-snapshot", ""),
          stream({ type: "message_start", message: { id: "child-message" } }, "child-tool"),
          stream(
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "Child thought" },
            },
            "child-tool",
          ),
          stream({ type: "message_start", message: { id: "partial-message" } }),
          stream({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "Partial thought" },
          }),
          makeResultFrame({
            uuid: "reasoning-result",
            result: "",
            ...(status === "interrupted" ? { terminalReason: "aborted_streaming" as const } : {}),
          }),
        ];
        for (const frame of frames) yield* Queue.offer(harness.sdkMessages, frame);
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, status);
        const latest = new Map(
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "reasoning"
              ? [[event.turnItem.id, event.turnItem] as const]
              : [],
          ),
        );
        assert.deepEqual(
          [...latest.values()].map((item) => item.text),
          ["Authoritative first thought", "Second thought", "Completion only", "Partial thought"],
        );
        assert.equal(new Set([...latest.values()].map((item) => item.ordinal)).size, 4);
        for (const item of latest.values()) {
          assert.equal(item.streaming, false);
          assert.isNotNull(item.completedAt);
        }
        assert.isFalse(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.role === "assistant",
          ),
        );
        for (const item of latest.values()) assert.notInclude(item.text, "secret-signature");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  // regression: #15892 non-execution metadata is carried through, not guessed from result text
  it.effect.each(["cancelled", "denied", "permission_denied", undefined])(
    "preserves native tool non-execution metadata %s without inferring a denial from text",
    (kind) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-tool-non-execution"),
              text: "Run the tool.",
              attachments: [],
            }),
          );
          yield* harness.offerAndWait(
            claudeSdkFrame({
              type: "user",
              uuid: "tool-non-execution",
              session_id: WAKE_NATIVE_SESSION,
              parent_tool_use_id: null,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tool-error",
                    is_error: true,
                    content: "STOP and wait for the user.",
                  },
                  { type: "tool_result", tool_use_id: "tool-ok", is_error: false, content: "OK" },
                ],
              },
              ...(kind === undefined
                ? {}
                : {
                    tool_result_meta: [
                      { id: "tool-error", non_execution_kind: kind },
                      { id: "tool-ok", non_execution_kind: null },
                    ],
                  }),
            }),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "result-non-execution", result: "Done" }),
          );
          yield* Queue.take(harness.terminalReceipts);
          const items = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
              ? [event.turnItem]
              : [],
          );
          const failed = items.findLast((item) => item.nativeItemRef?.nativeId === "tool-error")!;
          assert.equal(failed.status, kind === "cancelled" ? "cancelled" : "failed");
          assert.equal(failed.toolNonExecutionKind, kind);
          const ok = items.findLast((item) => item.nativeItemRef?.nativeId === "tool-ok")!;
          assert.equal(ok.status, "completed");
          assert.equal(ok.toolNonExecutionKind, undefined);
          const node = harness.events.findLast(
            (event) =>
              event.type === "node.updated" && event.node.nativeItemRef?.nativeId === "tool-error",
          );
          assert.equal(node?.type === "node.updated" ? node.node.status : undefined, failed.status);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect.each(
    (["aborted_tools", "aborted_streaming"] as const).flatMap((terminalReason) =>
      [true, false].map((steered) => ({ terminalReason, steered })),
    ),
  )("handles $terminalReason with active steering=$steered", ({ terminalReason, steered }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attemptId = RunAttemptId.make("attempt-steering-abort");
        const input = makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId,
          text: "Audit the settings pages.",
          attachments: [],
        });
        yield* harness.runtime.startTurn(input);
        if (steered) {
          yield* harness.runtime.steerTurn({
            threadId: harness.threadId,
            runId: input.runId,
            providerThread: harness.providerThread,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeTurnId: `turn:${attemptId}`,
            }),
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make("message-steering-abort"),
              text: "Include the hierarchy mock.",
              attachments: [],
            },
          });
          assert.equal(harness.offeredMessages[1]?.priority, "now");
        }
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000901",
            result: "",
            terminalReason,
            usage: {
              input_tokens: 600,
              output_tokens: 40,
              cache_creation_input_tokens: 500,
              cache_read_input_tokens: 2000,
            },
          }),
        );
        if (steered) {
          yield* Queue.offer(harness.sdkMessages, wakeAssistant);
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000902",
              result: "Audit finished after the steer.",
              usage: {
                input_tokens: 3,
                output_tokens: 6,
                cache_creation_input_tokens: 2347,
                cache_read_input_tokens: 9455,
              },
            }),
          );
        }
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, steered ? "completed" : "interrupted");
        if (steered) {
          assert.isTrue(
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "assistant_message" &&
                event.turnItem.text === WAKE_ASSISTANT_TEXT,
            ),
          );
          const completed = harness.events.findLast(
            (event) => event.type === "provider_turn.updated",
          );
          assert.deepEqual(
            completed?.type === "provider_turn.updated"
              ? completed.providerTurn.turnTokenUsage
              : undefined,
            {
              usageScope: "main_agent",
              usageStatus: "complete",
              hasSubagents: false,
              inputTokens: 603 + 2847 + 11455,
              outputTokens: 46,
              cachedInputTokens: 11455,
              cacheCreationTokens: 2847,
            },
          );
        }
        assert.lengthOf(harness.terminalEvents(), 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("announces usage-limit pauses once per window and again on a new turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      const resetsAt = Math.floor(DateTime.toEpochMillis(now) / 1000) + 7_200;
      const limit = (rateLimitType: "five_hour" | "seven_day" = "five_hour") =>
        claudeSdkFrame({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType, resetsAt },
          uuid: "00000000-0000-4000-8000-000000000601",
          session_id: WAKE_NATIVE_SESSION,
        });
      const start = (ordinal: number) =>
        harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(`attempt-claude-limit-${ordinal}`),
            providerTurnOrdinal: ordinal,
            text: "Continue.",
            attachments: [],
          }),
        );
      yield* start(1);
      yield* Queue.offer(harness.sdkMessages, limit());
      const pause = (yield* Queue.take(harness.systemNoticeReceipts)).turnItem;
      assert.equal(pause.type, "system_notice");
      if (pause.type !== "system_notice") return;
      assert.equal(
        pause.message,
        "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 2h.",
      );
      assert.lengthOf(harness.terminalEvents(), 0);
      yield* Queue.offerAll(harness.sdkMessages, [
        limit(),
        limit("seven_day"),
        limit(),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000602",
          result: "Recovered.",
        }),
      ]);
      yield* Queue.take(harness.terminalReceipts);
      const notices = () =>
        harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
            ? [event.turnItem]
            : [],
        );
      assert.lengthOf(notices(), 2);
      yield* start(2);
      yield* Queue.offerAll(harness.sdkMessages, [
        limit(),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000603",
          result: "Done.",
        }),
      ]);
      yield* Queue.take(harness.terminalReceipts);
      assert.lengthOf(notices(), 3);
      assert.notEqual(notices()[0]?.id, notices()[2]?.id);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("keeps a later future-window event-supplied Claude reset over the embedded reset", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-embedded-limit-event"),
          text: "Continue.",
          attachments: [],
        }),
      );
      yield* Queue.offerAll(harness.sdkMessages, [
        claudeSdkFrame({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "future_window",
            resetsAt: 1791807600,
          },
          uuid: "00000000-0000-4000-8000-000000000683",
          session_id: WAKE_NATIVE_SESSION,
        }),
        makeAssistantErrorFrame({
          uuid: "00000000-0000-4000-8000-000000000684",
          error: "rate_limit",
          apiErrorParams: {
            rate_limit_info: {
              status: "rejected",
              rateLimitType: "five_hour",
              resetsAt: 1791804000,
            },
          },
        }),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000685",
          result: "Usage limit reached.",
          isError: true,
          apiErrorStatus: 429,
          terminalReason: "api_error",
        }),
      ]);
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.class, "usage_limit");
      assert.equal(terminal.failure.resetAt, "2026-10-12T12:20:00.000Z");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each([
    {
      name: "an unflagged result with surrounding whitespace",
      isError: false,
      result: "  API Error: 400 Request rejected by a safeguard.\n",
      expected: "API Error: 400 Request rejected by a safeguard.",
    },
    {
      name: "a secret crossing the truncation boundary",
      isError: true,
      result: `API Error: 400 ${"x".repeat(440)} {"token":"${"synthetic-secret".repeat(100)}"} ${"y".repeat(100)}`,
      expected: `API Error: 400 ${"x".repeat(440)} {"token":"[REDACTED]"} `.padEnd(500, "y"),
    },
    {
      name: "ordinary assistant text",
      isError: true,
      result: "I found three files.",
      expected: "Claude gave up after repeated API errors.",
    },
    {
      name: "a listed non-diagnostic error",
      isError: true,
      result: "API Error: 400 Request rejected.",
      errors: ["[ede_diagnostic] internal detail", "Tool execution failed: EACCES"],
      expected: "Tool execution failed: EACCES",
    },
    {
      name: "an HTTP 529 overload",
      isError: true,
      result: "API Error: 529 Specific overload detail.",
      apiErrorStatus: 529,
      expected: "Claude API is overloaded (529). Try again shortly.",
    },
    {
      name: "an HTTP 429 rate limit",
      isError: true,
      result: "API Error: 429 Specific rate limit detail.",
      apiErrorStatus: 429,
      expected: "Claude API rate limit reached. Try again later.",
    },
    {
      name: "a different terminal reason",
      isError: true,
      result: "API Error: 400 Request rejected.",
      terminalReason: "prompt_too_long" as const,
      expected:
        "Claude stopped: the prompt exceeds the model's context window. Run /compact or start a new thread.",
    },
  ])("reports terminal API error text for $name", (input) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-specific-api-error"),
          text: "Continue.",
          attachments: [],
        }),
      );
      const apiErrorStatus = input.apiErrorStatus ?? 400;
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000699",
          result: input.result,
          terminalReason: input.terminalReason ?? "api_error",
          apiErrorStatus,
          isError: input.isError,
          ...(input.errors === undefined ? {} : { errors: input.errors }),
        }),
      );

      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.message, input.expected);
      assert.equal(terminal.failure.code, `api_error_${apiErrorStatus}`);
      assert.equal(
        terminal.failure.class,
        apiErrorStatus === 429 ? "usage_limit" : "provider_error",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("names an expired Claude login instead of the terminal API error", () =>
    Effect.gen(function* () {
      const configDir = "/synthetic/Claude config";
      // The adapter resolves the cwd on the host, which adds a drive letter on Windows.
      const cwd = NodePath.resolve("/synthetic/project");
      const harness = yield* makeWakeHarnessWithOptions({
        environment: { CLAUDE_CONFIG_DIR: configDir },
      });
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-auth-failure"),
          text: "Continue.",
          attachments: [],
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd,
          }),
        }),
      );
      yield* Queue.offerAll(harness.sdkMessages, [
        makeAssistantErrorFrame({
          uuid: "00000000-0000-4000-8000-000000000606",
          error: "authentication_failed",
        }),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000607",
          result: "API Error: 401 Credentials expired.",
          terminalReason: "api_error",
        }),
      ]);

      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.include(terminal.failure.message, "run `claude auth login`");
      assert.include(terminal.failure.message, configDir);
      assert.include(terminal.failure.message, JSON.stringify(cwd));
      assert.notInclude(terminal.failure.message, "repeated API errors");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("shows a 403 permission error instead of the login hint", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-permission-denied"),
          text: "Continue.",
          attachments: [],
        }),
      );
      // Claude CLI 2.1.288 labels a 403 authentication_failed too.
      const cliText =
        "Failed to authenticate. API Error: 403 Your organization does not have access to this model.";
      yield* Queue.offerAll(harness.sdkMessages, [
        makeAssistantErrorFrame({
          uuid: "00000000-0000-4000-8000-000000000608",
          error: "authentication_failed",
        }),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000609",
          result: cliText,
          isError: true,
          apiErrorStatus: 403,
          terminalReason: "api_error",
        }),
      ]);

      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.message, cliText);
      assert.equal(terminal.failure.code, "api_error_403");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  const lastProviderTurn = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) => {
    const event = events.findLast((candidate) => candidate.type === "provider_turn.updated");
    if (event?.type !== "provider_turn.updated") {
      throw new Error("Expected a provider turn update.");
    }
    return event.providerTurn;
  };
  const makeRollbackHarness = makeWakeHarnessWithOptions({
    close: (sdkMessages) => Queue.shutdown(sdkMessages),
  });

  it.effect.each([
    { kind: "fork with inherited head", fork: true, headMessageId: "remapped-inherited-head" },
    { kind: "fork without recorded head", fork: true, headMessageId: undefined },
    { kind: "ordinary thread", fork: false, headMessageId: undefined },
  ])("rolls back the first run of a $kind", ({ fork, headMessageId }) =>
    Effect.gen(function* () {
      let allocations = 0;
      const harness = yield* makeWakeHarnessWithOptions({
        close: (sdkMessages) => Queue.shutdown(sdkMessages),
        freshQueueOnReopen: true,
        allocateSessionId: Effect.sync(() =>
          allocations++ === 0 ? WAKE_NATIVE_SESSION : "fresh-native-session",
        ),
        forkSession: () =>
          Effect.succeed({
            sessionId: WAKE_NATIVE_SESSION,
            ...(headMessageId === undefined ? {} : { headMessageId }),
          }),
      });
      const providerThread = fork
        ? yield* harness.runtime.forkThread({
            sourceProviderThread: {
              ...harness.providerThread,
              nativeThreadRef: {
                driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                nativeId: "source-native-session",
                strength: "strong",
              },
            },
            targetThreadId: harness.threadId,
          })
        : harness.providerThread;
      const turnInput = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("first-run"),
        text: "This run will be rolled back.",
        attachments: [],
        nativeThreadHasTurns: false,
      });
      yield* harness.runtime.startTurn(turnInput);
      yield* harness.offerAndWait(
        makeAssistantTextFrame({ uuid: "own-run-message", text: "Discard this answer." }),
      );
      yield* harness.offerAndWait(
        makeResultFrame({ uuid: "own-run-result", result: "Discard this answer." }),
      );
      assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
      const completed = harness.events.findLast(
        (event) => event.type === "provider_thread.updated",
      );
      assert.equal(completed?.type, "provider_thread.updated");
      if (completed?.type !== "provider_thread.updated") return;
      assert.equal(completed.providerThread.firstRunOrdinal, 1);

      const rolledBack = yield* harness.runtime.rollbackThread({
        providerThread: completed.providerThread,
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("checkpoint-before-first-run"),
          appRunOrdinal: 0,
        },
        providerThreadTurns: [lastProviderTurn(harness.events)],
      });
      assert.equal(
        rolledBack.providerThread.forkedFrom?.providerThreadId,
        providerThread.forkedFrom?.providerThreadId,
      );
      yield* harness.runtime.startTurn({
        ...turnInput,
        attemptId: RunAttemptId.make("after-rollback"),
        providerThread: rolledBack.providerThread,
        providerTurnOrdinal: 2,
        nativeThreadHasTurns: false,
      });
      const options = harness.getOpenedOptions();
      assert.equal(harness.processQueues.length, 2);
      if (headMessageId !== undefined) {
        assert.equal(rolledBack.providerThread.nativeThreadRef?.nativeId, WAKE_NATIVE_SESSION);
        assert.equal(rolledBack.providerThread.nativeConversationHeadRef?.nativeId, headMessageId);
        assert.equal(options?.resume, WAKE_NATIVE_SESSION);
        assert.equal(options?.resumeSessionAt, headMessageId);
        assert.isUndefined(options?.sessionId);
      } else {
        assert.equal(rolledBack.providerThread.nativeThreadRef?.nativeId, "fresh-native-session");
        assert.isNull(rolledBack.providerThread.nativeConversationHeadRef);
        assert.equal(options?.sessionId, "fresh-native-session");
        assert.isUndefined(options?.resume);
        assert.isUndefined(options?.resumeSessionAt);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect(
    "rolls back to the main-thread assistant message when a subagent frame comes last",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRollbackHarness;
        const now = yield* DateTime.now;
        const mainUuid = "00000000-0000-4000-8000-000000000641";
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-cursor-main"),
            text: "Continue.",
            attachments: [],
          }),
        );
        yield* Queue.offerAll(harness.sdkMessages, [
          makeAssistantTextFrame({ uuid: mainUuid, text: "Delegating." }),
          makeAssistantErrorFrame({
            uuid: "00000000-0000-4000-8000-000000000642",
            error: undefined,
            parentToolUseId: "toolu_subagent",
          }),
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000643", result: "Done." }),
        ]);
        yield* Queue.take(harness.terminalReceipts);

        const providerTurn = lastProviderTurn(harness.events);
        assert.equal(providerTurn.nativeTurnRef?.nativeId, mainUuid);
        const rolledBack = yield* harness.runtime.rollbackThread({
          providerThread: harness.providerThread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-claude-cursor-main"),
            appRunOrdinal: 1,
            providerTurn,
          },
          providerThreadTurns: [
            providerTurn,
            {
              ...providerTurn,
              id: ProviderTurnId.make("provider-turn-claude-cursor-next"),
              ordinal: 2,
            },
          ],
        });
        assert.equal(rolledBack.providerThread.nativeConversationHeadRef?.nativeId, mainUuid);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  it.effect("an interrupted turn after a rollback stops resuming at the rolled-back head", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions({
        close: (sdkMessages) => Queue.shutdown(sdkMessages),
        freshQueueOnReopen: true,
      });
      const now = yield* DateTime.now;
      const pinnedHead = "00000000-0000-4000-8000-000000025510";
      const pinnedThread = {
        ...harness.providerThread,
        nativeConversationHeadRef: {
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeId: pinnedHead,
          strength: "weak" as const,
        },
      };
      const interruptedInput = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: pinnedThread,
        now,
        attemptId: RunAttemptId.make("attempt-claude-interrupt-after-rollback"),
        text: "The secret word is apricot-25510. Then run sleep 60.",
        attachments: [],
        providerTurnOrdinal: 2,
        nativeThreadHasTurns: true,
      });
      yield* harness.runtime.startTurn(interruptedInput);
      assert.equal(harness.getOpenedOptions()?.resumeSessionAt, pinnedHead);
      yield* harness.offerAndWait(
        makeAssistantTextFrame({
          uuid: "00000000-0000-4000-8000-000000025511",
          text: "Noted apricot-25510. Running sleep.",
        }),
      );
      yield* harness.runtime.interruptTurn({
        providerThread: pinnedThread,
        providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeTurnId: `turn:${interruptedInput.attemptId}`,
        }),
      });
      assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "interrupted");
      const afterInterrupt = harness.events.findLast(
        (event) => event.type === "provider_thread.updated",
      )?.providerThread;
      assert.isDefined(afterInterrupt);
      assert.isNull(afterInterrupt.nativeConversationHeadRef);

      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: afterInterrupt,
          now,
          attemptId: RunAttemptId.make("attempt-claude-after-interrupt"),
          text: "What is the secret word?",
          attachments: [],
          providerTurnOrdinal: 3,
          nativeThreadHasTurns: true,
        }),
      );
      assert.equal(harness.processQueues.length, 2);
      assert.isUndefined(harness.getOpenedOptions()?.resumeSessionAt);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("an interrupted turn with no assistant output keeps the rolled-back head", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions({
        close: (sdkMessages) => Queue.shutdown(sdkMessages),
        freshQueueOnReopen: true,
      });
      const now = yield* DateTime.now;
      const pinnedHead = "00000000-0000-4000-8000-000000025510";
      const pinnedThread = {
        ...harness.providerThread,
        nativeConversationHeadRef: {
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeId: pinnedHead,
          strength: "weak" as const,
        },
      };
      const interruptedInput = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: pinnedThread,
        now,
        attemptId: RunAttemptId.make("attempt-claude-silent-interrupt-after-rollback"),
        text: "The secret word is apricot-25510. Then run sleep 60.",
        attachments: [],
        providerTurnOrdinal: 2,
        nativeThreadHasTurns: true,
      });
      yield* harness.runtime.startTurn(interruptedInput);
      assert.equal(harness.getOpenedOptions()?.resumeSessionAt, pinnedHead);
      yield* harness.runtime.interruptTurn({
        providerThread: pinnedThread,
        providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeTurnId: `turn:${interruptedInput.attemptId}`,
        }),
      });
      assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "interrupted");
      const afterInterrupt = harness.events.findLast(
        (event) => event.type === "provider_thread.updated",
      )?.providerThread;
      assert.isDefined(afterInterrupt);
      assert.equal(afterInterrupt.nativeConversationHeadRef?.nativeId, pinnedHead);

      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: afterInterrupt,
          now,
          attemptId: RunAttemptId.make("attempt-claude-after-silent-interrupt"),
          text: "What is the secret word?",
          attachments: [],
          providerTurnOrdinal: 3,
          nativeThreadHasTurns: true,
        }),
      );
      assert.equal(harness.processQueues.length, 2);
      assert.equal(harness.getOpenedOptions()?.resumeSessionAt, pinnedHead);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("never records a subagent uuid for a turn with no main-thread assistant message", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions({
        close: (sdkMessages) => Queue.shutdown(sdkMessages),
        freshQueueOnReopen: true,
      });
      const now = yield* DateTime.now;
      const subagentUuid = "00000000-0000-4000-8000-000000000644";
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-cursor-subagent-only"),
          text: "Background task completed.",
          attachments: [],
        }),
      );
      yield* Queue.offerAll(harness.sdkMessages, [
        makeAssistantErrorFrame({
          uuid: subagentUuid,
          error: undefined,
          parentToolUseId: "toolu_subagent",
        }),
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000645", result: "Done." }),
      ]);
      yield* Queue.take(harness.terminalReceipts);

      const providerTurn = lastProviderTurn(harness.events);
      assert.notEqual(providerTurn.nativeTurnRef?.nativeId, subagentUuid);
      const rollbackTo = (providerThreadTurns: ReadonlyArray<typeof providerTurn>) =>
        harness.runtime.rollbackThread({
          providerThread: harness.providerThread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-claude-cursor-subagent-only"),
            appRunOrdinal: 1,
            providerTurn,
          },
          providerThreadTurns,
        });

      const latest = yield* rollbackTo([providerTurn]);
      assert.isNull(latest.providerThread.nativeConversationHeadRef);
      const error = yield* rollbackTo([
        providerTurn,
        {
          ...providerTurn,
          id: ProviderTurnId.make("provider-turn-claude-cursor-next"),
          ordinal: 2,
        },
      ]).pipe(Effect.flip);
      assert.instanceOf(error, ProviderAdapter.ProviderAdapterRollbackThreadError);
      assert.include(String(error.cause), "no SDK assistant message cursor");

      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: latest.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-cursor-subagent-only-next"),
          text: "Continue.",
          attachments: [],
          providerTurnOrdinal: 2,
        }),
      );
      const reopenedQueue = harness.processQueues[1];
      assert.isDefined(reopenedQueue);
      if (reopenedQueue === undefined) return;
      yield* Queue.offerAll(reopenedQueue, [
        makeAssistantTextFrame({
          uuid: "00000000-0000-4000-8000-000000000646",
          text: "Continuing.",
        }),
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000647", result: "Done." }),
      ]);
      const next = yield* Queue.take(harness.terminalReceipts);
      assert.equal(next.status, "completed");
      assert.isUndefined(harness.getOpenedOptions()?.resumeSessionAt);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each([
    {
      name: "fails a /compact the usage limit stopped",
      limited: true,
      compaction: "failed",
      compact: true,
      status: "failed",
    },
    {
      name: "completes an unlimited failed /compact",
      limited: false,
      compaction: "failed",
      compact: true,
      status: "completed",
    },
    {
      name: "completes a successful limited /compact",
      limited: true,
      compaction: "success",
      compact: true,
      status: "completed",
    },
    {
      name: "completes a failed automatic compaction",
      limited: true,
      compaction: "failed",
      compact: false,
      status: "completed",
    },
  ] as const)("$name", ({ name, limited, compaction, compact, status }) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      const resetsAt = 1791991200;
      const compactError =
        "Error during compaction: You've hit your session limit · resets 5:20pm (Europe/Berlin).";
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make(`attempt-claude-compaction-${name}`),
          text: compact ? "/compact" : "Continue.",
          attachments: [],
        }),
      );
      // Failed /compact reports success without a terminal reason; status frames carry outcomes, including automatic compaction.
      const result = makeResultFrame({
        uuid: "00000000-0000-4000-8000-000000000613",
        result: compact ? "" : "Done.",
        numTurns: compact ? 0 : 1,
        terminalReason: null,
      });
      yield* Queue.offerAll(harness.sdkMessages, [
        ...(limited
          ? [
              claudeSdkFrame({
                type: "rate_limit_event",
                rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt },
                uuid: "00000000-0000-4000-8000-000000000611",
                session_id: WAKE_NATIVE_SESSION,
              }),
            ]
          : []),
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: "compacting",
          uuid: "00000000-0000-4000-8000-000000000610",
          session_id: WAKE_NATIVE_SESSION,
        }),
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: null,
          compact_result: compaction,
          ...(compaction === "failed"
            ? { compact_error: limited ? compactError : "Not enough messages to compact." }
            : {}),
          uuid: "00000000-0000-4000-8000-000000000612",
          session_id: WAKE_NATIVE_SESSION,
        }),
        claudeSdkFrame({
          type: "system",
          subtype: "informational",
          content: "Compaction finished; turn continues.",
          level: "warning",
          uuid: "00000000-0000-4000-8000-000000000614",
          session_id: WAKE_NATIVE_SESSION,
        }),
      ]);
      yield* Queue.take(harness.systemNoticeReceipts);
      const updates = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "compaction"
          ? [event.turnItem]
          : [],
      );
      assert.lengthOf(updates, 2);
      const [running, settled] = updates;
      assert.equal(running?.status, "running");
      assert.equal(settled?.status, compaction === "success" ? "completed" : "failed");
      assert.equal(
        settled?.type === "compaction" ? settled.summary : undefined,
        compaction === "failed"
          ? limited
            ? compactError
            : "Not enough messages to compact."
          : undefined,
      );
      assert.equal(settled?.id, running?.id);
      assert.equal(settled?.ordinal, running?.ordinal);
      assert.deepEqual(settled?.startedAt, running?.startedAt);
      assert.isNotNull(settled?.completedAt);
      assert.isEmpty(harness.terminalEvents());

      yield* Queue.offerAll(
        harness.sdkMessages,
        compact
          ? [
              // Claude Code echoes the command's stdout as a synthetic assistant message.
              claudeSdkFrame({
                ...makeAssistantTextFrame({
                  uuid: "00000000-0000-4000-8000-000000000615",
                  text: "Compacted.",
                }),
                local_command_source: "<local-command-stdout>Compacted.</local-command-stdout>",
              }),
              claudeSdkFrame({ ...result, local_command: "compact" }),
            ]
          : [result],
      );
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.deepEqual(
        harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        ),
        updates,
      );
      assert.equal(terminal.status, status);
      assert.equal(
        harness.events.some(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
        ),
        !compact,
      );
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.class, "usage_limit");
      assert.equal(terminal.failure.message, compactError);
      assert.equal(
        terminal.failure.resetAt,
        DateTime.formatIso(DateTime.makeUnsafe(resetsAt * 1000)),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("keeps an unreported /compact failure's reason on the compaction, not as a reply", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-compaction-unreported"),
          text: "/compact",
          attachments: [],
        }),
      );
      // Claude can refuse a /compact without a compact_result: the only reason is the result text.
      yield* Queue.offerAll(harness.sdkMessages, [
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: "compacting",
          uuid: "00000000-0000-4000-8000-000000000620",
          session_id: WAKE_NATIVE_SESSION,
        }),
        claudeSdkFrame({
          ...makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000622",
            text: "Not enough messages to compact.",
          }),
          local_command_source:
            "<local-command-stdout>Not enough messages to compact.</local-command-stdout>",
        }),
        claudeSdkFrame({
          ...makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000621",
            result: "Not enough messages to compact.",
            numTurns: 0,
            terminalReason: null,
          }),
          local_command: "compact",
        }),
      ]);
      yield* Queue.take(harness.terminalReceipts);
      const settled = harness.events
        .flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        )
        .at(-1);
      assert.equal(settled?.status, "failed");
      assert.equal(settled?.summary, "Not enough messages to compact.");
      assert.isFalse(
        harness.events.some(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each([
    { name: "parent limit", parentErrors: ["rate_limit"], expectedLimit: true },
    {
      name: "parent limit then nested response",
      parentErrors: ["rate_limit", "nested-ok"],
      expectedLimit: true,
    },
    { name: "nested limit", parentErrors: ["nested-limit"], expectedLimit: false },
    {
      name: "parent limit then parent response",
      parentErrors: ["rate_limit", "ok"],
      expectedLimit: false,
    },
  ])("classifies retried terminal API failures after $name", ({ parentErrors, expectedLimit }) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make(`attempt-claude-retry-${parentErrors.join("-")}`),
          text: "Continue.",
          attachments: [],
        }),
      );
      for (const [index, evidence] of parentErrors.entries()) {
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantErrorFrame({
            uuid: `00000000-0000-4000-8000-00000000062${index}`,
            error: evidence.includes("limit") ? "rate_limit" : undefined,
            parentToolUseId: evidence.startsWith("nested") ? "nested-tool" : null,
            ...(evidence.includes("limit")
              ? {
                  apiErrorParams: {
                    rate_limit_info: {
                      status: "rejected",
                      rateLimitType: "five_hour",
                      resetsAt: 1790298600,
                    },
                  },
                }
              : {}),
          }),
        );
      }
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000629",
          result: "API Error",
          isError: true,
          terminalReason: "api_error",
        }),
      );

      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.class, expectedLimit ? "usage_limit" : "provider_error");
      assert.equal(
        terminal.failure.resetAt,
        expectedLimit ? "2026-09-25T01:10:00.000Z" : undefined,
      );
      assert.equal(
        terminal.failure.message,
        expectedLimit
          ? "Claude usage limit reached. Send the message again once the limit resets."
          : "Claude gave up after repeated API errors.",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each([
    { status: 503, cooldown: "4m 6s", seconds: 246 },
    { status: 503, cooldown: "1h 2m 3s", seconds: 3723 },
    { status: 503, cooldown: "7s", seconds: 7 },
    { status: 503, cooldown: "0s", seconds: 0 },
    { status: 503, cooldown: "unknown", seconds: 0 },
    { status: 503, cooldown: "999999999999999999999999h", seconds: 0 },
    { status: 503, cooldown: "4m 6s", seconds: 0, errorType: "overloaded_error" },
    { status: 401, cooldown: "4m 6s", seconds: 0 },
  ])("recovers wrapped gateway limits with status $status and cooldown $cooldown", (input) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-gateway-limit"),
          text: "Continue.",
          attachments: [],
        }),
      );
      yield* Queue.offerAll(harness.sdkMessages, [
        makeAssistantErrorFrame({
          uuid: "00000000-0000-4000-8000-000000000652",
          error: "server_error",
        }),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000653",
          result: `API Error: ${input.status} [claude/claude-opus-5-5] [429]: {"type":"error","error":{"type":"${input.errorType ?? "rate_limit_error"}","message":"Please try again later."}} (reset after ${input.cooldown}).`,
          terminalReason: "api_error",
          isError: true,
          apiErrorStatus: input.status,
        }),
      ]);
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.class, input.seconds > 0 ? "usage_limit" : "provider_error");
      if (input.seconds > 0) {
        assert.equal(terminal.failure.retryable, true);
        assert.equal(
          terminal.failure.resetAt,
          DateTime.formatIso(
            DateTime.makeUnsafe(DateTime.toEpochMillis(now) + input.seconds * 1_000),
          ),
        );
      } else {
        assert.isUndefined(terminal.failure.resetAt);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("keeps the measured context when a usage limit ends the turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-limit-context"),
          text: "Continue.",
          attachments: [],
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000660", text: "Working." }),
      );
      // The CLI answers a 429 with a locally generated frame that reports no usage.
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "assistant",
          message: {
            model: "<synthetic>",
            id: "00000000-0000-4000-8000-000000000661",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "You've hit your session limit" }],
            stop_reason: "stop_sequence",
            stop_sequence: "",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
          error: "rate_limit",
          uuid: "00000000-0000-4000-8000-000000000661",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000662",
          result: "You've hit your session limit",
          terminalReason: "api_error",
          isError: true,
          apiErrorStatus: 429,
        }),
      );
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      const reportedContext = harness.events.flatMap((event) =>
        event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
          ? [event.providerTurn.tokenUsage.usedTokens]
          : [],
      );
      assert.deepEqual(reportedContext, [2]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  const usageStreamFrame = (event: unknown, parentToolUseId: string | null = null) =>
    claudeSdkFrame({
      type: "stream_event",
      event,
      parent_tool_use_id: parentToolUseId,
      session_id: WAKE_NATIVE_SESSION,
      uuid: "usage-stream-frame",
    });
  const usageSnapshotFrame = (id: string, uuid: string, usage: unknown) =>
    claudeSdkFrame({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        id,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Working." }],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
      parent_tool_use_id: null,
      uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const zeroUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const reportedContextTokens = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
    events.flatMap((event) =>
      event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
        ? [event.providerTurn.tokenUsage.usedTokens]
        : [],
    );

  it.effect("reports context from final stream usage when the request starts at zero", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-zero-start-usage"),
          text: "Continue.",
          attachments: [],
        }),
      );
      // Some Anthropic-compatible proxies report zero usage at message_start
      // and the real counts on the final message_delta.
      const frames = [
        usageStreamFrame({
          type: "message_start",
          message: { id: "msg_first", usage: zeroUsage },
        }),
        usageSnapshotFrame("msg_first", "00000000-0000-4000-8000-000000000670", zeroUsage),
        usageStreamFrame(
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { ...zeroUsage, input_tokens: 999_999, output_tokens: 9 },
          },
          "child-tool",
        ),
        usageStreamFrame({
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { ...zeroUsage, input_tokens: 37_939, output_tokens: 184 },
        }),
        usageSnapshotFrame("msg_first", "00000000-0000-4000-8000-000000000671", zeroUsage),
        usageStreamFrame({
          type: "message_start",
          message: { id: "msg_second", usage: zeroUsage },
        }),
        usageSnapshotFrame("msg_second", "00000000-0000-4000-8000-000000000672", zeroUsage),
        usageStreamFrame({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: null, output_tokens: 12 },
        }),
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000673", result: "Done." }),
      ];
      for (const frame of frames) yield* Queue.offer(harness.sdkMessages, frame);
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "completed");
      assert.deepEqual(reportedContextTokens(harness.events), [38_123]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("merges cumulative stream usage into the message_start counts", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions({
        settings: { ...DEFAULT_CLAUDE_SETTINGS, autoCompactWindow: "150000" },
      });
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-merged-stream-usage"),
          text: "Continue.",
          attachments: [],
        }),
      );
      const startUsage = {
        input_tokens: 10,
        output_tokens: 1,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 1_000,
      };
      const frames = [
        usageStreamFrame({
          type: "message_start",
          message: { id: "msg_native", usage: startUsage },
        }),
        usageSnapshotFrame("msg_native", "00000000-0000-4000-8000-000000000680", startUsage),
        usageStreamFrame({
          type: "message_delta",
          delta: { stop_reason: null, stop_sequence: null },
          usage: { input_tokens: null, output_tokens: 20 },
        }),
        usageStreamFrame({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: {
            input_tokens: 25,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 1_000,
          },
        }),
        usageSnapshotFrame("msg_native", "00000000-0000-4000-8000-000000000681", startUsage),
        claudeSdkFrame({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 1_075, post_tokens: 400 },
          uuid: "00000000-0000-4000-8000-000000000682",
          session_id: WAKE_NATIVE_SESSION,
        }),
        usageSnapshotFrame("msg_native", "00000000-0000-4000-8000-000000000684", startUsage),
        usageStreamFrame({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: null, output_tokens: 60 },
        }),
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000683", result: "Done." }),
      ];
      for (const frame of frames) yield* Queue.offer(harness.sdkMessages, frame);
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "completed");
      assert.deepEqual(reportedContextTokens(harness.events), [1_211, 1_230, 1_075, 400]);
      assert.deepEqual(
        harness.events.flatMap((event) =>
          event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
            ? [event.providerTurn.tokenUsage.autoCompactThreshold]
            : [],
        ),
        [150_000, 150_000, 150_000, 150_000],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each([
    { autoCompactWindow: "", model: "claude-sonnet-4-6", threshold: undefined },
    { autoCompactWindow: "150000", model: "claude-sonnet-4-6", threshold: 150_000 },
    { autoCompactWindow: "200000", model: "claude-sonnet-4-6", threshold: undefined },
    { autoCompactWindow: "650000", model: "claude-sonnet-4-6", threshold: undefined },
    { autoCompactWindow: "650000", model: "uncatalogued-model", threshold: 650_000 },
  ])(
    "ignores stale snapshots after compaction and reports threshold $autoCompactWindow for $model",
    ({ autoCompactWindow, model, threshold }) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({
          settings: { ...DEFAULT_CLAUDE_SETTINGS, autoCompactWindow },
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-snapshot-usage-compaction"),
            text: "Continue.",
            attachments: [],
            modelSelection: { ...CLAUDE_TEST_MODEL_SELECTION, model },
          }),
        );
        const usage = { ...zeroUsage, input_tokens: 1_000, output_tokens: 75 };
        const frames = [
          usageSnapshotFrame("msg_fallback", "00000000-0000-4000-8000-000000000790", usage),
          claudeSdkFrame({
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "auto", pre_tokens: 1_075, post_tokens: 400 },
            uuid: "00000000-0000-4000-8000-000000000791",
            session_id: WAKE_NATIVE_SESSION,
          }),
          usageSnapshotFrame("msg_fallback", "00000000-0000-4000-8000-000000000792", usage),
          // A new request after the boundary reports the compacted context.
          usageSnapshotFrame("msg_after", "00000000-0000-4000-8000-000000000793", {
            ...zeroUsage,
            input_tokens: 450,
            output_tokens: 10,
          }),
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000794", result: "Done." }),
        ];
        for (const frame of frames) yield* Queue.offer(harness.sdkMessages, frame);
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, "completed");
        assert.deepEqual(reportedContextTokens(harness.events), [1_075, 400, 460]);
        assert.deepEqual(
          harness.events.flatMap((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
              ? [event.providerTurn.tokenUsage.autoCompactThreshold]
              : [],
          ),
          [threshold, threshold, threshold],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  it.effect("shows a hook-dropped Claude prompt once and skips info-level lines", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("claude-hook-dropped-prompt-attempt"),
          text: "Deploy to production",
          attachments: [],
        }),
      );
      const notice = "Prompt dropped by a hook: Deploys are frozen until Monday.";
      const uuid = "00000000-0000-4000-8000-000000000305";
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "system",
          subtype: "informational",
          content: "Started in the background: agent-1",
          level: "info",
          session_id: WAKE_NATIVE_SESSION,
          uuid: "00000000-0000-4000-8000-000000000307",
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "system",
          subtype: "informational",
          content: notice,
          level: "warning",
          prevent_continuation: true,
          session_id: WAKE_NATIVE_SESSION,
          uuid,
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000306",
          result: notice,
          numTurns: 0,
          terminalReason: null,
        }),
      );
      yield* Queue.take(harness.terminalReceipts);
      const notices = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
          ? [event.turnItem]
          : [],
      );
      assert.lengthOf(notices, 1);
      assert.equal(notices[0]?.message, notice);
      assert.equal(notices[0]?.status, "completed");
      assert.equal(notices[0]?.nativeItemRef?.nativeId, uuid);
      assert.equal(harness.terminalEvents()[0]?.status, "completed");
      assert.isFalse(
        harness.events.some(
          (event) => event.type === "message.updated" && event.message.role === "assistant",
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect(
    "runs native compaction and keeps its context watermark separate from billed usage",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const compact = harness.runtime.compactThread;
        assert.isDefined(compact);
        if (compact === undefined) return;
        yield* compact(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("claude-native-compact-attempt"),
            text: " /COMPACT ",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "manual", pre_tokens: 1500, post_tokens: 400 },
            uuid: "00000000-0000-4000-8000-000000000201",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000202",
            result: "Compacted conversation.",
          }),
        );
        yield* Queue.take(harness.terminalReceipts);

        assert.deepEqual(harness.offeredMessages[0]?.message.content, "/compact");
        const compaction = harness.events.find(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
        );
        assert.isDefined(compaction);
        if (compaction?.type === "turn_item.updated" && compaction.turnItem.type === "compaction") {
          assert.equal(compaction.turnItem.beforeTokenCount, 1500);
          assert.equal(compaction.turnItem.afterTokenCount, 400);
          assert.equal(compaction.turnItem.status, "completed");
        }
        const watermark = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.tokenUsage?.usedTokens === 400,
        );
        assert.isDefined(watermark);
        const completed = harness.events.findLast(
          (event) => event.type === "provider_turn.updated",
        );
        assert.equal(completed?.type, "provider_turn.updated");
        if (completed?.type === "provider_turn.updated") {
          assert.deepEqual(completed.providerTurn.turnTokenUsage, {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
          });
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
        ),
      ),
  );

  it.effect("shows automatic compaction before its boundary and completes the same item", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const observeCompactions = Effect.fnUntraced(function* (uuid: string) {
        // A later notice receipt confirms the event subscriber consumed preceding updates.
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "informational",
            content: "Context checkpoint",
            level: "warning",
            session_id: WAKE_NATIVE_SESSION,
            uuid,
          }),
        );
        yield* Queue.take(harness.systemNoticeReceipts);
        return harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        );
      });
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("claude-auto-compact-attempt"),
          text: "Continue working.",
          attachments: [],
        }),
      );
      for (const index of [1, 2]) {
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: "compacting",
            uuid: `00000000-0000-4000-8000-00000000021${index}`,
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
      }
      const beforeBoundary = yield* observeCompactions("00000000-0000-4000-8000-000000000215");
      assert.lengthOf(beforeBoundary, 1);
      const running = beforeBoundary[0]!;
      assert.equal(running.status, "running");
      assert.isNull(running.completedAt);
      assert.isNotNull(running.startedAt);

      yield* TestClock.adjust(1_000);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: null,
          compact_result: "success",
          uuid: "00000000-0000-4000-8000-000000000222",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      const reported = yield* observeCompactions("00000000-0000-4000-8000-000000000223");
      assert.lengthOf(reported, 2);
      assert.equal(reported[1]?.id, running.id);
      assert.equal(reported[1]?.status, "completed");
      assert.isUndefined(reported[1]?.afterTokenCount);
      assert.isEmpty(harness.terminalEvents());
      yield* TestClock.adjust(1_000);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 1500, post_tokens: 400 },
          uuid: "00000000-0000-4000-8000-000000000213",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      const afterBoundary = yield* observeCompactions("00000000-0000-4000-8000-000000000216");
      assert.lengthOf(afterBoundary, 3);
      const completed = afterBoundary[2]!;
      assert.equal(completed.status, "completed");
      assert.equal(completed.id, running.id);
      assert.equal(completed.ordinal, running.ordinal);
      assert.deepEqual(completed.startedAt, running.startedAt);
      assert.equal(completed.beforeTokenCount, 1500);
      assert.equal(completed.afterTokenCount, 400);
      assert.deepEqual(completed.completedAt, reported[1]?.completedAt);

      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 2000, post_tokens: 500 },
          uuid: "00000000-0000-4000-8000-000000000217",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: "compacting",
          uuid: "00000000-0000-4000-8000-000000000218",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      const nextCompactions = yield* observeCompactions("00000000-0000-4000-8000-000000000219");
      assert.lengthOf(nextCompactions, 5);
      const boundaryOnly = nextCompactions[3]!;
      const nextRunning = nextCompactions[4]!;
      assert.equal(boundaryOnly.status, "completed");
      assert.notEqual(boundaryOnly.id, completed.id);
      assert.isAbove(boundaryOnly.ordinal, completed.ordinal);
      assert.equal(boundaryOnly.beforeTokenCount, 2000);
      assert.equal(boundaryOnly.afterTokenCount, 500);
      assert.equal(nextRunning.status, "running");
      assert.notEqual(nextRunning.id, boundaryOnly.id);
      assert.isAbove(nextRunning.ordinal, boundaryOnly.ordinal);

      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: null,
          permissionMode: "default",
          uuid: "00000000-0000-4000-8000-000000000233",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      assert.deepEqual(
        yield* observeCompactions("00000000-0000-4000-8000-000000000234"),
        nextCompactions,
      );

      let retryRunning = nextRunning;
      for (const [index, outcome] of [
        { compact_result: "failed", compact_error: "Temporary compaction failure." },
        {},
      ].entries()) {
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: null,
            ...outcome,
            uuid: `00000000-0000-4000-8000-00000000024${index}`,
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const stopped = yield* observeCompactions(`00000000-0000-4000-8000-00000000025${index}`);
        assert.lengthOf(stopped, 6 + index * 2);
        const settled = stopped.at(-1)!;
        assert.equal(settled.id, retryRunning.id);
        assert.equal(settled.ordinal, retryRunning.ordinal);
        assert.deepEqual(settled.startedAt, retryRunning.startedAt);
        assert.equal(
          settled.status,
          outcome.compact_result === "failed" ? "failed" : "interrupted",
        );
        assert.equal(
          settled.title,
          outcome.compact_result === "failed"
            ? "Context compaction failed"
            : "Context compaction stopped",
        );
        assert.isNotNull(settled.completedAt);
        assert.isEmpty(harness.terminalEvents());

        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: "compacting",
            uuid: `00000000-0000-4000-8000-00000000026${index}`,
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const retried = yield* observeCompactions(`00000000-0000-4000-8000-00000000027${index}`);
        assert.lengthOf(retried, stopped.length + 1);
        retryRunning = retried.at(-1)!;
        assert.equal(retryRunning.status, "running");
        assert.notEqual(retryRunning.id, settled.id);
        assert.isAbove(retryRunning.ordinal, settled.ordinal);
      }

      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 3000, post_tokens: 600 },
          uuid: "00000000-0000-4000-8000-000000000220",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      const allCompactions = yield* observeCompactions("00000000-0000-4000-8000-000000000221");
      assert.lengthOf(allCompactions, 10);
      assert.equal(allCompactions[9]?.id, retryRunning.id);
      assert.equal(allCompactions[9]?.ordinal, retryRunning.ordinal);
      assert.equal(allCompactions[9]?.status, "completed");
      assert.equal(allCompactions[9]?.beforeTokenCount, 3000);
      assert.equal(allCompactions[9]?.afterTokenCount, 600);

      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000214",
          result: "Work complete.",
        }),
      );
      yield* Queue.take(harness.terminalReceipts);
      assert.deepEqual(
        harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        ),
        allCompactions,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each([
    { outcome: "result", turnStatus: "completed", itemStatus: "failed" },
    { outcome: "interrupt", turnStatus: "interrupted", itemStatus: "interrupted" },
    { outcome: "query_exit", turnStatus: "failed", itemStatus: "failed" },
  ] as const)(
    "settles unfinished compaction before the $outcome terminal receipt",
    ({ outcome, turnStatus, itemStatus }) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({
          close: (sdkMessages) => Queue.shutdown(sdkMessages),
        });
        const attemptId = RunAttemptId.make(`claude-compact-${outcome}`);
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId,
            text: "Continue.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: "compacting",
            uuid: "00000000-0000-4000-8000-000000000221",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        if (outcome === "query_exit") {
          yield* Queue.shutdown(harness.sdkMessages);
        } else if (outcome === "interrupt") {
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeTurnId: `turn:${attemptId}`,
            }),
          });
        } else {
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000222",
              result: "Stopped before the boundary.",
            }),
          );
        }
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, turnStatus);
        const updates = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        );
        assert.lengthOf(updates, 2);
        const [running, settled] = updates;
        assert.equal(running?.status, "running");
        assert.equal(settled?.status, itemStatus);
        assert.equal(settled?.id, running?.id);
        assert.equal(settled?.ordinal, running?.ordinal);
        assert.deepEqual(settled?.startedAt, running?.startedAt);
        assert.isNotNull(settled?.completedAt);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  it.effect.each(["claude-haiku-4-5-20251001", "claude-sonnet-4-6"])(
    "renegotiates auto only when switching API models after fallback to default: %s",
    (nextModel) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({ freshQueueOnReopen: true });
        const modelSelection = {
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          model: "claude-haiku-4-5-20251001",
        };
        const turnInput = {
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attachments: [],
          modelSelection,
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            ...CLAUDE_TEST_RUNTIME_POLICY,
            runtimeMode: "auto",
          }),
        };
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            ...turnInput,
            attemptId: RunAttemptId.make("attempt-claude-auto-fallback-1"),
            text: "Hello.",
          }),
        );
        const openedOptions = harness.getOpenedOptions();
        assert.equal(openedOptions?.permissionMode, "auto");
        yield* harness.offerAndWait(claudeSdkFrame({ ...wakeTurnInit, permissionMode: "default" }));
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* Queue.take(harness.terminalReceipts);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            ...turnInput,
            modelSelection: { ...modelSelection, model: nextModel },
            attemptId: RunAttemptId.make("attempt-claude-auto-fallback-2"),
            providerTurnOrdinal: 2,
            text: "Continue.",
          }),
        );
        if (nextModel === modelSelection.model) {
          assert.strictEqual(harness.getOpenedOptions(), openedOptions);
          assert.lengthOf(harness.processQueues, 1);
        } else {
          const resumedOptions = harness.getOpenedOptions();
          assert.notStrictEqual(resumedOptions, openedOptions);
          assert.equal(resumedOptions?.model, nextModel);
          assert.equal(resumedOptions?.resume, WAKE_NATIVE_SESSION);
          assert.isUndefined(resumedOptions?.sessionId);
          assert.equal(resumedOptions?.permissionMode, "auto");
          assert.lengthOf(harness.processQueues, 2);
        }
        assert.lengthOf(harness.offeredMessages, 2);
        assert.deepEqual(harness.permissionModeChanges, []);
        assert.deepEqual(harness.liveSelectionChanges, []);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  it.effect("preserves typed Claude plans and todos through generic tool completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const assistantTools = (
          uuid: string,
          tools: ReadonlyArray<Record<string, unknown>>,
          parentToolUseId: string | null = null,
        ) =>
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: `msg_${uuid}`,
              type: "message",
              role: "assistant",
              content: tools.map((tool) => ({ type: "tool_use", ...tool })),
              stop_reason: "tool_use",
              stop_sequence: null,
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            },
            parent_tool_use_id: parentToolUseId,
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          });
        const toolResults = (uuid: string, toolUseIds: ReadonlyArray<string>) =>
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: toolUseIds.map((toolUseId) => ({
                type: "tool_result",
                tool_use_id: toolUseId,
                content: "ok",
              })),
            },
            parent_tool_use_id: null,
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          });

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-plan-lifecycle-1"),
            text: "Plan the work.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          assistantTools("00000000-0000-4000-8000-000000000501", [
            {
              id: "tool-todo-1",
              name: "TodoWrite",
              input: { todos: [{ content: "Inspect", status: "in_progress" }] },
            },
          ]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          assistantTools("00000000-0000-4000-8000-000000000501", [
            {
              id: "tool-todo-1",
              name: "TodoWrite",
              input: { todos: [{ content: "Inspect", status: "in_progress" }] },
            },
          ]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          toolResults("00000000-0000-4000-8000-000000000502", ["tool-todo-1"]),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({ ...wakeTurnInit, permissionMode: "bypassPermissions" }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: null,
            permissionMode: "plan",
            uuid: "00000000-0000-4000-8000-000000000508",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...wakeTurnInit,
            uuid: "00000000-0000-4000-8000-000000000509",
            permissionMode: "plan",
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000503",
            result: "Todo recorded.",
          }),
        );
        yield* Queue.take(harness.terminalReceipts);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-plan-lifecycle-2"),
            providerTurnOrdinal: 2,
            text: "Finish the plan.",
            attachments: [],
          }),
        );
        const canUseTool = harness.getOpenedOptions()?.canUseTool;
        assert.isFunction(canUseTool);
        const planMarkdown = "# Ready to implement\n\n1. Ship it.";
        yield* Effect.promise(() =>
          canUseTool!(
            "ExitPlanMode",
            { plan: planMarkdown },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-exit-plan-1",
              requestId: "request-exit-plan-1",
            },
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          assistantTools("00000000-0000-4000-8000-000000000504", [
            {
              id: "tool-todo-2",
              name: "TodoWrite",
              input: { todos: [{ content: "Inspect", status: "completed" }] },
            },
            { id: "tool-exit-plan-1", name: "ExitPlanMode", input: { plan: planMarkdown } },
          ]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          assistantTools(
            "00000000-0000-4000-8000-000000000507",
            [
              {
                id: "tool-subagent-todo",
                name: "TodoWrite",
                input: { todos: [{ content: "Child-only work", status: "in_progress" }] },
              },
            ],
            "tool-parent-agent",
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          toolResults("00000000-0000-4000-8000-000000000505", ["tool-todo-2", "tool-exit-plan-1"]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          assistantTools("00000000-0000-4000-8000-000000000509", [
            {
              id: "tool-todo-3",
              name: "TodoWrite",
              input: { todos: [{ content: "Implement", status: "pending" }] },
            },
          ]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          toolResults("00000000-0000-4000-8000-000000000510", ["tool-todo-3"]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000506",
            result: "Plan captured.",
          }),
        );
        yield* Queue.take(harness.terminalReceipts);

        const items = new Map(
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" ? [[String(event.turnItem.id), event.turnItem]] : [],
          ),
        );
        const plans = new Map(
          harness.events.flatMap((event) =>
            event.type === "plan.updated" ? [[String(event.plan.id), event.plan]] : [],
          ),
        );
        const todoItems = [...items.values()].filter((item) => item.type === "todo_list");
        const proposedItems = [...items.values()].filter((item) => item.type === "proposed_plan");
        assert.lengthOf(todoItems, 3);
        assert.equal(todoItems[1]?.status, "completed");
        assert.deepEqual(todoItems[1]?.steps, [
          { id: "todo-0", text: "Inspect", status: "completed" },
        ]);
        assert.deepEqual(todoItems[2]?.steps, [
          { id: "todo-0", text: "Implement", status: "pending" },
        ]);
        assert.equal(todoItems[1]?.runId, todoItems[2]?.runId);
        assert.lengthOf(proposedItems, 1);
        assert.equal(
          proposedItems[0]?.type === "proposed_plan" && proposedItems[0].markdown,
          planMarkdown,
        );
        assert.isTrue(
          [...items.values()].some(
            (item) =>
              item.type === "dynamic_tool" && item.nativeItemRef?.nativeId === "tool-todo-2",
          ),
        );
        assert.isTrue(
          [...items.values()].some(
            (item) =>
              item.type === "dynamic_tool" && item.nativeItemRef?.nativeId === "tool-exit-plan-1",
          ),
        );
        const proposedPlan = [...plans.values()].find((plan) => plan.kind === "proposed_plan");
        assert.equal(proposedPlan?.status, "active");
        assert.deepEqual(harness.permissionModeChanges, ["bypassPermissions"]);
        assert.deepEqual(
          [...plans.values()]
            .filter((plan) => plan.kind === "todo_list")
            .map((plan) => plan.status),
          ["superseded", "superseded", "active"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  type TaskToolCall =
    | { name: "TaskCreate"; input: TaskCreateInput; output: TaskCreateOutput }
    | { name: "TaskUpdate"; input: TaskUpdateInput; output: TaskUpdateOutput }
    | { name: "TaskList"; input: Record<string, never>; output: TaskListOutput };

  function taskToolFrames(
    tool: TaskToolCall,
    nextUuid: () => string,
    options?: {
      parentToolUseId?: string;
      isError?: boolean;
      extraToolResult?: boolean;
      nonExecutionKind?: string;
    },
  ): ReadonlyArray<SDKMessage> {
    const uuid = nextUuid();
    const toolUseId = `tool-${uuid}`;
    const parentToolUseId = options?.parentToolUseId ?? null;
    return [
      claudeSdkFrame({
        type: "assistant",
        message: {
          id: `msg_${uuid}`,
          model: "claude-sonnet-4-6",
          type: "message",
          role: "assistant",
          content: [{ type: "tool_use", id: toolUseId, name: tool.name, input: tool.input }],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: parentToolUseId,
        uuid,
        session_id: WAKE_NATIVE_SESSION,
      }),
      claudeSdkFrame({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content:
                parentToolUseId !== null && tool.name === "TaskCreate"
                  ? `Task #${tool.output.task.id} created successfully: ${tool.output.task.subject}`
                  : parentToolUseId !== null && tool.name === "TaskUpdate"
                    ? tool.output.success
                      ? `Updated task #${tool.output.taskId} ${tool.output.updatedFields.join(", ")}`
                      : tool.output.error
                    : "Task tool finished.",
              ...(options?.isError === undefined ? {} : { is_error: options.isError }),
            },
            ...(options?.extraToolResult
              ? [{ type: "tool_result", tool_use_id: "unrelated-tool", content: "ok" }]
              : []),
          ],
        },
        // Like real Claude, subagent results carry only the text, no `tool_use_result`.
        ...(parentToolUseId === null ? { tool_use_result: tool.output } : {}),
        ...(options?.nonExecutionKind === undefined
          ? {}
          : {
              tool_result_meta: [{ id: toolUseId, non_execution_kind: options.nonExecutionKind }],
            }),
        parent_tool_use_id: parentToolUseId,
        uuid: nextUuid(),
        session_id: WAKE_NATIVE_SESSION,
      }),
    ];
  }

  const makeTaskToolHarnessWithOptions = (environment: NodeJS.ProcessEnv = {}) =>
    Effect.gen(function* () {
      const configDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "t3-claude-tasks-",
      });
      const path = yield* Path.Path;
      const harness = yield* makeWakeHarnessWithOptions({
        environment: {
          CLAUDE_CONFIG_DIR: path.relative(CLAUDE_TEST_RUNTIME_POLICY.cwd ?? ".", configDir),
          ...environment,
        },
      });
      let sequence = 600;
      let turn = 0;
      const nextUuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
      const startTurn = Effect.fnUntraced(function* () {
        turn++;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`attempt-claude-task-tools-${turn}`),
            providerTurnOrdinal: turn,
            text: "Update the task list.",
            attachments: [],
          }),
        );
      });
      const call = Effect.fnUntraced(function* (
        tool: TaskToolCall,
        options?: Parameters<typeof taskToolFrames>[2],
      ) {
        for (const frame of taskToolFrames(tool, nextUuid, options)) {
          yield* harness.offerAndWait(frame);
        }
      });
      const finishTurn = Effect.fnUntraced(function* () {
        yield* harness.offerAndWait(
          makeResultFrame({ uuid: nextUuid(), result: "Task list updated." }),
        );
        return yield* Queue.take(harness.terminalReceipts);
      });
      const plans = () =>
        harness.events.flatMap((event) =>
          event.type === "plan.updated" && event.plan.kind === "todo_list" ? [event.plan] : [],
        );
      // Registers a running subagent so frames carrying its tool_use_id as
      // parent_tool_use_id are processed instead of held for an unknown owner.
      const launchSubagent = (toolUseId: string) =>
        harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: `task-${toolUseId}`,
            tool_use_id: toolUseId,
            description: "Work on tasks",
            task_type: "local_agent",
            uuid: nextUuid(),
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
      return { configDir, startTurn, call, launchSubagent, finishTurn, plans };
    });

  const makeTaskToolHarness = makeTaskToolHarnessWithOptions();

  const createTask = (id: string, subject: string): TaskToolCall => ({
    name: "TaskCreate",
    input: { subject: `Requested ${subject}`, description: `Work on ${subject}.` },
    output: { task: { id, subject } },
  });
  const updateTask = (input: TaskUpdateInput, success = true): TaskToolCall => ({
    name: "TaskUpdate",
    input,
    output: { success, taskId: input.taskId, updatedFields: ["status"] },
  });

  it.effect("persists a todo_list from inline Claude task-tool frames", () =>
    Effect.gen(function* () {
      let sequence = 700;
      const nextUuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
      const prompt = "Track a synthetic task.";
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript({
        provider: "claudeAgent",
        protocol: "claude-agent-sdk.query",
        version: "1",
        scenario: "claude_task_tools_inline",
        metadata: { nativeSessionId: WAKE_NATIVE_SESSION },
        entries: [
          {
            type: "expect_outbound",
            frame: {
              type: "query.open",
              options: {
                model: "claude-sonnet-4-6",
                tools: { type: "preset", preset: "claude_code" },
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                settings: { showThinkingSummaries: true },
                sessionId: WAKE_NATIVE_SESSION,
              },
            },
          },
          {
            type: "expect_outbound",
            frame: {
              type: "prompt.offer",
              message: {
                type: "user",
                message: { role: "user", content: prompt },
                parent_tool_use_id: null,
              },
            },
          },
          ...[
            ...taskToolFrames(createTask("1", "Inspect"), nextUuid),
            ...taskToolFrames(updateTask({ taskId: "1", status: "in_progress" }), nextUuid),
            makeResultFrame({ uuid: nextUuid(), result: "Task recorded." }),
          ].map((frame) => ({ type: "emit_inbound" as const, frame })),
        ],
      } satisfies ProviderReplayTranscript);
      const materialized = yield* materializeFixtureInput({
        scenario: transcript.scenario,
        fixtureInput: { steps: [{ type: "message", text: prompt }] },
        driver: ProviderDriverKind.make("claudeAgent"),
        modelSelection: CLAUDE_MODEL_SELECTION,
      }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
      const scenario = { name: transcript.scenario, transcript, ...materialized };
      yield* Effect.gen(function* () {
        const result = yield* runOrchestratorV2Scenario(scenario);
        assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
        const projection = projectionFor(result, transcript.scenario);
        assertSemanticProjectionIntegrity(projection);
        const plans = projection.plans.filter((plan) => plan.kind === "todo_list");
        assert.lengthOf(plans, 1);
        assert.deepEqual(
          plans[0]?.steps.map(({ id, text, status }) => ({ id, text, status })),
          [{ id: "task-1", text: "Inspect", status: "running" }],
        );
        assert.lengthOf(
          projection.turnItems.filter((item) => item.type === "todo_list"),
          1,
        );
      }).pipe(
        Effect.provide(layerProviderReplay(scenario, ClaudeOrchestratorReplayHarness)),
        provideDeterministicTestRuntime,
        Effect.scoped,
      );
    }),
  );

  it.effect(
    "projects TaskCreate and TaskUpdate into one plan per turn and supersedes it later",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeTaskToolHarness;
        yield* harness.startTurn();
        yield* harness.call(createTask("1", "Inspect"));
        yield* harness.call(createTask("2", "Implement"));
        yield* harness.call(updateTask({ taskId: "1", status: "in_progress" }));
        yield* harness.finishTurn();

        const firstTurnPlans = harness.plans();
        assert.lengthOf(firstTurnPlans, 3);
        assert.equal(new Set(firstTurnPlans.map((plan) => plan.id)).size, 1);
        assert.deepEqual(firstTurnPlans.at(-1)?.steps, [
          { id: "task-1", text: "Inspect", status: "running" },
          { id: "task-2", text: "Implement", status: "pending" },
        ]);
        const firstPlan = firstTurnPlans.at(-1)!;

        yield* harness.startTurn();
        yield* harness.call(updateTask({ taskId: "1", status: "completed", subject: "Inspected" }));
        yield* harness.finishTurn();

        const laterPlans = harness.plans().slice(firstTurnPlans.length);
        assert.lengthOf(laterPlans, 2);
        assert.equal(laterPlans[0]?.id, firstPlan.id);
        assert.equal(laterPlans[0]?.status, "superseded");
        const newPlan = laterPlans[1]!;
        assert.notEqual(newPlan.id, firstPlan.id);
        assert.notEqual(newPlan.runId, firstPlan.runId);
        assert.deepEqual(newPlan.steps, [
          { id: "task-1", text: "Inspected", status: "completed" },
          { id: "task-2", text: "Implement", status: "pending" },
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  it.effect("removes deleted tasks without resurrecting them on later updates or turns", () =>
    Effect.gen(function* () {
      const harness = yield* makeTaskToolHarness;
      yield* harness.startTurn();
      yield* harness.call(createTask("1", "Discard"));
      yield* harness.call(createTask("2", "Keep"));
      yield* harness.call(updateTask({ taskId: "1", status: "deleted" }));
      yield* harness.call(updateTask({ taskId: "1", status: "pending" }));
      yield* harness.finishTurn();
      assert.lengthOf(harness.plans(), 3);
      assert.deepEqual(harness.plans().at(-1)?.steps, [
        { id: "task-2", text: "Keep", status: "pending" },
      ]);

      yield* harness.startTurn();
      yield* harness.call(updateTask({ taskId: "2", status: "in_progress" }));
      yield* harness.finishTurn();
      assert.deepEqual(harness.plans().at(-1)?.steps, [
        { id: "task-2", text: "Keep", status: "running" },
      ]);
      for (const plan of harness.plans().slice(2)) {
        assert.isFalse(plan.steps.some((step) => step.id === "task-1"));
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each([
    {
      tool: updateTask({ taskId: "2", status: "completed" }),
      listId: undefined,
      directory: WAKE_NATIVE_SESSION,
      status: "completed",
    },
    {
      tool: createTask("2", "Implement"),
      listId: " list/ID ",
      directory: "list-ID",
      status: "pending",
    },
  ] as const)(
    "recovers persisted tasks on the first $tool.name after restart",
    ({ tool, listId, directory, status }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const harness = yield* makeTaskToolHarnessWithOptions({ CLAUDE_CODE_TASK_LIST_ID: listId });
        const tasksDir = `${harness.configDir}/tasks/${directory}`;
        yield* fs.makeDirectory(tasksDir, { recursive: true });
        // The native tool has already written its result before emitting the SDK frame.
        for (const task of [
          { id: "1", subject: "Inspect", status: "completed" },
          { id: "2", subject: "Implement", status },
          { id: "3", subject: "Internal", status: "pending", metadata: { _internal: true } },
        ]) {
          yield* fs.writeFileString(
            `${tasksDir}/${task.id}.json`,
            JSON.stringify({ description: "", blocks: [], blockedBy: [], ...task }),
          );
        }
        yield* fs.writeFileString(`${tasksDir}/4.json`, "{");
        yield* fs.makeDirectory(`${tasksDir}/5.json`);

        yield* harness.startTurn();
        yield* harness.call(tool);
        assert.equal((yield* harness.finishTurn()).status, "completed");
        assert.deepEqual(
          harness.plans().map((plan) => plan.steps),
          [
            [
              { id: "task-1", text: "Inspect", status: "completed" },
              { id: "task-2", text: "Implement", status },
            ],
          ],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  it.effect(
    "publishes an empty task list when the first TaskUpdate after restart deletes the last task",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const harness = yield* makeTaskToolHarness;
        const tasksDir = `${harness.configDir}/tasks/${WAKE_NATIVE_SESSION}`;
        // Claude has removed the task file before emitting the SDK frame.
        yield* fs.makeDirectory(tasksDir, { recursive: true });
        yield* fs.writeFileString(`${tasksDir}/.highwatermark`, "1");

        yield* harness.startTurn();
        yield* harness.call(updateTask({ taskId: "1", status: "deleted" }));
        assert.equal((yield* harness.finishTurn()).status, "completed");
        assert.deepEqual(
          harness.plans().map((plan) => plan.steps),
          [[]],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  it.effect("replaces task state with TaskList, including an empty list", () =>
    Effect.gen(function* () {
      const harness = yield* makeTaskToolHarness;
      yield* harness.startTurn();
      yield* harness.call(createTask("1", "Stale"));
      yield* harness.call({
        name: "TaskList",
        input: {},
        output: {
          tasks: [
            { id: "2", subject: "Queued", status: "pending", blockedBy: [] },
            { id: "3", subject: "Working", status: "in_progress", blockedBy: [] },
            { id: "4", subject: "Done", status: "completed", blockedBy: [] },
          ],
        },
      });
      yield* harness.call(updateTask({ taskId: "1", status: "in_progress" }));
      yield* harness.call(updateTask({ taskId: "2", status: "in_progress" }));
      yield* harness.call({ name: "TaskList", input: {}, output: { tasks: [] } });
      yield* harness.call(updateTask({ taskId: "2", status: "pending" }));
      yield* harness.finishTurn();
      const plans = harness.plans();
      assert.lengthOf(plans, 4);
      assert.deepEqual(plans[1]?.steps, [
        { id: "task-2", text: "Queued", status: "pending" },
        { id: "task-3", text: "Working", status: "running" },
        { id: "task-4", text: "Done", status: "completed" },
      ]);
      assert.deepEqual(plans[2]?.steps, [
        { id: "task-2", text: "Queued", status: "running" },
        { id: "task-3", text: "Working", status: "running" },
        { id: "task-4", text: "Done", status: "completed" },
      ]);
      assert.deepEqual(plans[3]?.steps, []);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("applies subagent task tools to the parent turn's shared task list", () =>
    Effect.gen(function* () {
      const harness = yield* makeTaskToolHarness;
      yield* harness.startTurn();
      yield* harness.call(createTask("1", "Main task"));
      yield* harness.launchSubagent("tool-parent-agent");
      const child = { parentToolUseId: "tool-parent-agent" };
      yield* harness.call(updateTask({ taskId: "1", status: "completed" }), child);
      yield* harness.call(createTask("2", "Child task"), child);
      yield* harness.call(
        {
          name: "TaskUpdate",
          input: { taskId: "2", status: "completed" },
          output: {
            success: false,
            taskId: "2",
            updatedFields: [],
            error: "Tests must pass before completing.",
          },
        },
        child,
      );
      yield* harness.call(updateTask({ taskId: "2", status: "in_progress" }), {
        ...child,
        isError: true,
      });
      // A cancelled call never ran, even without `is_error`.
      yield* harness.call(updateTask({ taskId: "2", status: "completed" }), {
        ...child,
        nonExecutionKind: "cancelled",
      });
      yield* harness.finishTurn();
      const plans = harness.plans();
      assert.lengthOf(plans, 3);
      assert.equal(new Set(plans.map((plan) => plan.id)).size, 1);
      assert.deepEqual(plans.at(-1)?.steps, [
        { id: "task-1", text: "Main task", status: "completed" },
        { id: "task-2", text: "Child task", status: "pending" },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("recovers persisted tasks when a subagent's TaskList comes first", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const harness = yield* makeTaskToolHarness;
      const tasksDir = `${harness.configDir}/tasks/${WAKE_NATIVE_SESSION}`;
      yield* fs.makeDirectory(tasksDir, { recursive: true });
      yield* fs.writeFileString(
        `${tasksDir}/1.json`,
        JSON.stringify({ id: "1", subject: "Inspect", status: "pending", blockedBy: [] }),
      );

      yield* harness.startTurn();
      yield* harness.launchSubagent("tool-parent-agent");
      yield* harness.call(
        { name: "TaskList", input: {}, output: { tasks: [] } },
        { parentToolUseId: "tool-parent-agent" },
      );
      yield* harness.call(updateTask({ taskId: "1", status: "completed" }));
      yield* harness.finishTurn();
      assert.deepEqual(harness.plans().at(-1)?.steps, [
        { id: "task-1", text: "Inspect", status: "completed" },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  // regression: #14964 structured task output attaches to exactly one tool result
  it.effect("does not associate structured task output with multiple tool results", () =>
    Effect.gen(function* () {
      const harness = yield* makeTaskToolHarness;
      yield* harness.startTurn();
      yield* harness.call(createTask("1", "Ambiguous"), { extraToolResult: true });
      yield* harness.finishTurn();
      assert.deepEqual(harness.plans(), []);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("resolves API retries on resumed assistant activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-api-retry"),
            text: "Open github.com.",
            attachments: [],
          }),
        );

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "api_retry",
            attempt: 2,
            max_retries: 10,
            retry_delay_ms: 1_500,
            error_status: 529,
            error: "overloaded",
            uuid: "00000000-0000-4000-8000-000000000201",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const retryItems = () =>
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.retry !== undefined
              ? [event.turnItem]
              : [],
          );
        yield* harness.until(() => retryItems().length === 1);
        const runningRetry = retryItems()[0];
        assert.equal(runningRetry?.status, "running");
        assert.equal(runningRetry?.failure.code, "api_error_529");
        assert.deepEqual(runningRetry?.retry, {
          attempt: 2,
          maxAttempts: 10,
          retryDelayMs: 1_500,
        });

        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000202",
            text: "Opening GitHub.",
          }),
        );
        yield* harness.until(() => retryItems().length === 2);
        assert.lengthOf(harness.terminalEvents(), 0);
        const recoveredRetry = retryItems()[1];
        assert.equal(recoveredRetry?.id, runningRetry?.id);
        assert.equal(recoveredRetry?.status, "completed");
        assert.equal(recoveredRetry?.title, "Provider recovered");

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000203",
            result: "Opened GitHub.",
          }),
        );
        yield* harness.awaitTerminal(1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each(["api_error", "overloaded_status"] as const)(
    "fails a success-shaped Claude result with %s",
    (terminalReason) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-structured-terminal-failure"),
              text: "Complete the task.",
              attachments: [],
            }),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000205",
              result: "Provider failure details.",
              isError: false,
              ...(terminalReason === "overloaded_status"
                ? { apiErrorStatus: 529 }
                : { terminalReason }),
            }),
          );
          const terminal = yield* Queue.take(harness.terminalReceipts);
          assert.equal(terminal.status, "failed");
          if (terminal.status !== "failed") return;
          assert.isNotEmpty(terminal.failure.message);
          assert.equal(terminal.failure.class, "provider_error");
          assert.isFalse(
            harness.events.some(
              (event) =>
                event.type === "message.updated" &&
                event.message.text === "Provider failure details.",
            ),
          );
          assert.equal(
            terminal.failure.code,
            terminalReason === "overloaded_status" ? "api_error_529" : terminalReason,
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  // Context exhaustion reports blocking_limit even when the rate-limit window is allowed.
  it.effect.each([
    {
      windowStatus: "allowed",
      expectedClass: "provider_error",
      expectedMessage: "Claude stopped: the prompt exceeds the model's context window.",
    },
    {
      windowStatus: "rejected",
      expectedClass: "usage_limit",
      expectedMessage: "Claude usage limit reached. Send the message again once the limit resets.",
    },
  ] as const)(
    "classifies blocking_limit by its rate-limit evidence ($windowStatus window)",
    ({ windowStatus, expectedClass, expectedMessage }) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`attempt-blocking-limit-${windowStatus}`),
            text: "Continue.",
            attachments: [],
          }),
        );
        yield* Queue.offerAll(harness.sdkMessages, [
          claudeSdkFrame({
            type: "rate_limit_event",
            rate_limit_info: { status: windowStatus, rateLimitType: "five_hour" },
            uuid: "00000000-0000-4000-8000-000000000660",
            session_id: WAKE_NATIVE_SESSION,
          }),
          makeAssistantErrorFrame({
            uuid: "00000000-0000-4000-8000-000000000661",
            error: "invalid_request",
            text: "Prompt is too long",
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000662",
            result: "Prompt is too long",
            isError: true,
            numTurns: 189,
            terminalReason: "blocking_limit",
          }),
        ]);
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, "failed");
        if (terminal.status !== "failed") return;
        assert.equal(terminal.failure.class, expectedClass);
        assert.include(terminal.failure.message, expectedMessage);
        assert.equal(terminal.failure.code, "blocking_limit");
        if (expectedClass === "provider_error") {
          assert.include(terminal.failure.message, "/compact");
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  const providerThreadRosterEvents = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  ) =>
    events.filter(
      (
        event,
      ): event is Extract<
        ProviderAdapter.ProviderAdapterV2Event,
        { type: "provider_thread.updated" }
      > => event.type === "provider_thread.updated",
    );

  it.effect(
    "uses task_started as an incremental roster fallback and clears on empty snapshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const emptyRoster = claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [],
            uuid: "00000000-0000-4000-8000-000000000202",
            session_id: WAKE_NATIVE_SESSION,
          });

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-roster-fallback"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
          yield* Queue.offer(harness.sdkMessages, turnOneResult);
          yield* harness.awaitTerminal(1);

          const afterStart = providerThreadRosterEvents(harness.events).filter(
            (event) => (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
          );
          assert.isAtLeast(afterStart.length, 1);
          assert.equal(
            (afterStart.at(-1)?.providerThread.pendingBackgroundTasks ?? [])[0]?.taskId,
            WAKE_TASK_ID,
          );

          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "system",
              subtype: "background_tasks_changed",
              tasks: [
                {
                  task_id: "subagent-shell",
                  task_type: "local_bash",
                  description: "sleep 150",
                  parent_task_id: "agent-1",
                },
              ],
              uuid: "00000000-0000-4000-8000-000000000203",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* harness.until(() =>
            providerThreadRosterEvents(harness.events).some(
              (event) =>
                event.providerThread.pendingBackgroundTasks?.[0]?.parentTaskId === "agent-1",
            ),
          );

          yield* Queue.offer(harness.sdkMessages, emptyRoster);
          yield* harness.until(() =>
            providerThreadRosterEvents(harness.events).some(
              (event) =>
                event.providerThread.status === "idle" &&
                (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0,
            ),
          );
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("holds only the background tasks the agent marks awaited, until they end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const awaitBackgroundTasks = harness.runtime.awaitBackgroundTasks;
        if (awaitBackgroundTasks === undefined) {
          throw new Error("Claude adapter runtime must expose awaitBackgroundTasks.");
        }
        const roster = (tasks: ReadonlyArray<string>, uuid: string) =>
          claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: tasks.map((taskId) => ({
              task_id: taskId,
              task_type: "local_bash",
              description: taskId,
            })),
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          });
        const nextRoster = Effect.fn("nextRoster")(function* (
          matches: (tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>) => boolean,
        ) {
          while (true) {
            const { providerThread } = yield* Queue.take(harness.providerThreadReceipts);
            const tasks = providerThread.pendingBackgroundTasks ?? [];
            if (matches(tasks)) return tasks;
          }
        });
        const marks = (tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>) =>
          tasks.map((task) => [task.taskId, task.awaited === true]);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-awaited-roster"),
            text: "Run the tests in the background and the dev server.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          roster([WAKE_TASK_ID, "dev-server"], "00000000-0000-4000-8000-000000000301"),
        );
        yield* nextRoster((tasks) => tasks.length === 2);

        const marked = yield* awaitBackgroundTasks({
          providerThread: harness.providerThread,
          taskIds: [WAKE_TASK_ID, "already-finished"],
          awaited: true,
        });
        assert.deepStrictEqual(marked.matched, [WAKE_TASK_ID]);
        assert.deepStrictEqual(
          marks(yield* nextRoster((tasks) => tasks.some((task) => task.awaited === true))),
          [
            [WAKE_TASK_ID, true],
            ["dev-server", false],
          ],
        );
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* Queue.take(harness.terminalReceipts);

        // A replacing level rebuilds every entry; the mark must survive it.
        yield* Queue.offer(
          harness.sdkMessages,
          roster(["dev-server", WAKE_TASK_ID], "00000000-0000-4000-8000-000000000302"),
        );
        assert.deepStrictEqual(
          marks(yield* nextRoster((tasks) => tasks[0]?.taskId === "dev-server")),
          [
            ["dev-server", false],
            [WAKE_TASK_ID, true],
          ],
        );

        // Once the task leaves the roster, a reused id starts unmarked.
        yield* Queue.offer(
          harness.sdkMessages,
          roster(["dev-server"], "00000000-0000-4000-8000-000000000303"),
        );
        yield* nextRoster((tasks) => tasks.length === 1);
        yield* Queue.offer(
          harness.sdkMessages,
          roster(["dev-server", WAKE_TASK_ID], "00000000-0000-4000-8000-000000000304"),
        );
        assert.deepStrictEqual(marks(yield* nextRoster((tasks) => tasks.length === 2)), [
          ["dev-server", false],
          [WAKE_TASK_ID, false],
        ]);

        yield* awaitBackgroundTasks({
          providerThread: harness.providerThread,
          taskIds: ["dev-server"],
          awaited: true,
        });
        assert.deepStrictEqual(
          marks(yield* nextRoster((tasks) => tasks.some((task) => task.awaited === true))),
          [
            ["dev-server", true],
            [WAKE_TASK_ID, false],
          ],
        );
        const released = yield* awaitBackgroundTasks({
          providerThread: harness.providerThread,
          taskIds: ["dev-server"],
          awaited: false,
        });
        assert.deepStrictEqual(released.matched, ["dev-server"]);
        assert.deepStrictEqual(
          marks(yield* nextRoster((tasks) => !tasks.some((task) => task.awaited === true))),
          [
            ["dev-server", false],
            [WAKE_TASK_ID, false],
          ],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("keeps a running Claude monitor typed after many newer monitors end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        let frameNumber = 0;
        const nextUuid = () => `00000000-0000-4000-8000-${String(++frameNumber).padStart(12, "0")}`;
        const monitorFrames = (index: number) => {
          const taskId = `monitor-task-${index}`;
          const toolUseId = `toolu_monitor_${index}`;
          const description = `Monitor ${index}`;
          return {
            taskId,
            start: [
              claudeSdkFrame({
                type: "assistant",
                message: {
                  model: "claude-sonnet-4-6",
                  id: `msg_monitor_${index}`,
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use",
                      id: toolUseId,
                      name: "Monitor",
                      input: { description, command: "sleep 8 && echo MONITOR_DONE" },
                    },
                  ],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
                parent_tool_use_id: null,
                uuid: nextUuid(),
                session_id: WAKE_NATIVE_SESSION,
              }),
              claudeSdkFrame({
                type: "system",
                subtype: "task_started",
                task_id: taskId,
                tool_use_id: toolUseId,
                description,
                is_backgrounded: true,
                task_type: "local_bash",
                uuid: nextUuid(),
                session_id: WAKE_NATIVE_SESSION,
              }),
              claudeSdkFrame({
                type: "user",
                message: {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: toolUseId,
                      content: `Monitor started (task ${taskId}).`,
                    },
                  ],
                },
                parent_tool_use_id: null,
                uuid: nextUuid(),
                session_id: WAKE_NATIVE_SESSION,
                tool_use_result: { taskId, persistent: false },
              }),
            ],
            end: claudeSdkFrame({
              type: "system",
              subtype: "task_notification",
              task_id: taskId,
              tool_use_id: toolUseId,
              status: "completed",
              output_file: `/tmp/claude-replay/tasks/${taskId}.output`,
              summary: `Monitor "${description}" stream ended`,
              uuid: nextUuid(),
              session_id: WAKE_NATIVE_SESSION,
            }),
          };
        };

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-many-monitors"),
            text: "Watch the deploy, then re-arm short watches.",
            attachments: [],
          }),
        );
        const longRunning = monitorFrames(0);
        for (const frame of longRunning.start) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        for (let index = 1; index <= 65; index++) {
          const monitor = monitorFrames(index);
          for (const frame of monitor.start) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* Queue.offer(harness.sdkMessages, monitor.end);
        }
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [
              {
                task_id: longRunning.taskId,
                task_type: "local_bash",
                description: "Monitor 0",
              },
            ],
            uuid: nextUuid(),
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: nextUuid(), result: "Watching." }),
        );
        yield* harness.awaitTerminal(1);

        const roster = providerThreadRosterEvents(harness.events).at(-1)?.providerThread
          .pendingBackgroundTasks;
        assert.deepEqual(roster, [
          { taskId: longRunning.taskId, kind: "monitor", description: "Monitor 0" },
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("preserves settled background work until an explicit stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let closes = 0;
        const harness = yield* makeWakeHarnessWithOptions({
          close: (sdkMessages) =>
            Effect.sync(() => {
              closes++;
            }).pipe(Effect.andThen(Queue.shutdown(sdkMessages))),
        });
        const now = yield* DateTime.now;
        const attemptId = RunAttemptId.make("attempt-claude-settled-stop");
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId,
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* harness.awaitTerminal(1);
        const settledThread = providerThreadRosterEvents(harness.events).at(-1)?.providerThread;
        assert.equal(settledThread?.pendingBackgroundTasks?.[0]?.taskId, WAKE_TASK_ID);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        const replacementAttempt = yield* harness.runtime
          .startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: {
                ...harness.providerThread,
                nativeThreadRef: {
                  ...harness.providerThread.nativeThreadRef!,
                  nativeId: "replacement-session",
                },
              },
              now,
              attemptId: RunAttemptId.make("attempt-claude-background-replacement"),
              text: "Continue in a fresh session.",
              attachments: [],
              providerTurnOrdinal: 2,
            }),
          )
          .pipe(Effect.result);
        assert.equal(replacementAttempt._tag, "Failure");
        assert.equal(closes, 0);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* harness.runtime.interruptTurn({
          providerThread: settledThread ?? harness.providerThread,
          providerTurnId: harness.terminalEvents()[0]!.providerTurnId,
          requestRuntimeRestart: true,
        });

        assert.equal(closes, 1, "Stop must close the CLI process that owns the task");
        yield* harness.until(
          () =>
            (providerThreadRosterEvents(harness.events).at(-1)?.providerThread
              .pendingBackgroundTasks?.length ?? 0) === 0,
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("a settled Stop leaves a turn that replaced the closing process alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* makeChangeSignal;
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-settled-stop-replaced-",
        });
        const processQueues: Array<Queue.Queue<SDKMessage>> = [];
        const firstCloseRequested = yield* Deferred.make<void>();
        const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
          [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator,
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => {
                continuationRequests.push(request);
              }).pipe(Effect.andThen(changes.notify)),
          },
          queryRunner: {
            allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
            open: () =>
              Effect.gen(function* () {
                const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                const isFirstProcess = processQueues.length === 0;
                processQueues.push(sdkMessages);
                return {
                  messages: Stream.fromQueue(sdkMessages),
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: isFirstProcess
                    ? Deferred.succeed(firstCloseRequested, undefined).pipe(Effect.asVoid)
                    : Queue.shutdown(sdkMessages),
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-settled-stop-replaced");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-settled-stop"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }).pipe(Effect.andThen(changes.notify)),
          ),
          Effect.forkScoped,
        );
        if (runtime.hasPendingBackgroundWork === undefined) {
          return yield* Effect.die("Claude adapter runtime must expose hasPendingBackgroundWork.");
        }
        const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
        const terminals = () => events.filter((event) => event.type === "turn.terminal");
        const now = yield* DateTime.now;

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-settled-stop-replaced-a"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(processQueues[0]!, wakeTaskStarted);
        yield* Queue.offer(processQueues[0]!, turnOneResult);
        yield* changes.until(() => terminals().length === 1);
        const settledThread = providerThreadRosterEvents(events).at(-1)?.providerThread;
        const settledTurn = terminals()[0];
        assert.equal(settledThread?.pendingBackgroundTasks?.[0]?.taskId, WAKE_TASK_ID);

        const stop = yield* runtime
          .interruptTurn({
            providerThread: settledThread ?? providerThread,
            providerTurnId: settledTurn!.providerTurnId,
            requestRuntimeRestart: true,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(firstCloseRequested);

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread: { ...providerThread, status: "active" },
            now,
            attemptId: RunAttemptId.make("attempt-claude-settled-stop-replaced-b"),
            text: "Start another background build.",
            attachments: [],
            providerTurnOrdinal: 2,
            modelSelection: {
              ...CLAUDE_TEST_MODEL_SELECTION,
              model: "claude-haiku-4-5-20251001",
            },
          }),
        );
        assert.lengthOf(processQueues, 2);
        const replacementTaskId = "replacement-task";
        yield* Queue.offer(
          processQueues[1]!,
          claudeSdkFrame({
            ...wakeTaskStarted,
            task_id: replacementTaskId,
            uuid: "00000000-0000-4000-8000-000000000905",
          }),
        );
        yield* changes.until(
          () =>
            providerThreadRosterEvents(events).at(-1)?.providerThread.pendingBackgroundTasks?.[0]
              ?.taskId === replacementTaskId,
        );

        yield* Queue.shutdown(processQueues[0]!);
        yield* Fiber.join(stop);
        assert.isTrue(yield* hasPendingBackgroundWork);
        yield* yieldTicks(50);
        const latestThread = providerThreadRosterEvents(events).at(-1)?.providerThread;
        assert.equal(latestThread?.status, "active");
        assert.deepEqual(
          latestThread?.pendingBackgroundTasks?.map((task) => task.taskId),
          [replacementTaskId],
        );

        yield* Queue.offer(
          processQueues[1]!,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000906",
            result: "Started another build.",
          }),
        );
        yield* changes.until(() => terminals().length === 2);
        yield* Queue.offer(
          processQueues[1]!,
          claudeSdkFrame({
            ...wakeNotification,
            task_id: replacementTaskId,
            uuid: "00000000-0000-4000-8000-000000000907",
          }),
        );
        yield* Queue.offer(
          processQueues[1]!,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000908",
            text: WAKE_ASSISTANT_TEXT,
          }),
        );
        yield* changes.until(() => continuationRequests.length === 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect(
    "clears the replaced sibling native thread roster when openQuery switches processes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* makeChangeSignal;
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-sibling-replace-",
          });
          const nativeIds = ["native-thread-roster-a", "native-thread-roster-b"] as const;
          let allocateIndex = 0;
          // A shared queue would hide sibling process death on replacement.
          const processQueues: Array<{
            readonly nativeThreadId: string;
            readonly queue: Queue.Queue<SDKMessage>;
          }> = [];
          const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
          const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
            instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
            settings: DEFAULT_CLAUDE_SETTINGS,
            environment: {},
            attachmentsDir,
            fileSystem,
            path: yield* Path.Path,
            crypto: yield* Crypto.Crypto,
            idAllocator,
            continuationRequests: {
              offer: () => Effect.void,
            },
            queryRunner: {
              allocateSessionId: Effect.sync(() => {
                const next =
                  nativeIds[allocateIndex] ?? `native-thread-roster-extra-${allocateIndex}`;
                allocateIndex += 1;
                return next;
              }),
              open: (openInput) =>
                Effect.gen(function* () {
                  const nativeThreadId = openInput.options.sessionId ?? openInput.options.resume;
                  if (typeof nativeThreadId !== "string" || nativeThreadId.length === 0) {
                    return yield* Effect.die("openQuery must supply a native session id");
                  }
                  const queue = yield* Queue.unbounded<SDKMessage>();
                  processQueues.push({ nativeThreadId, queue });
                  return {
                    messages: Stream.fromQueue(queue),
                    offer: () => Effect.void,
                    setModel: () => Effect.void,
                    applyFlagSettings: () => Effect.void,
                    setPermissionMode: () => Effect.void,
                    backgroundTasks: () => Effect.succeed(false),
                    stopTask: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(queue),
                  };
                }),
              forkSession: () => Effect.die("unused forkSession"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          const appThreadA = ThreadId.make("thread-claude-roster-a");
          const appThreadB = ThreadId.make("thread-claude-roster-b");
          const runtime = yield* adapter.openSession({
            threadId: appThreadA,
            providerSessionId: ProviderSessionId.make("provider-session-claude-sibling-replace"),
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThreadA = yield* runtime.ensureThread({
            threadId: appThreadA,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThreadB = yield* runtime.ensureThread({
            threadId: appThreadB,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          assert.notEqual(
            providerThreadA.nativeThreadRef?.nativeId,
            providerThreadB.nativeThreadRef?.nativeId,
          );
          yield* runtime.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
              }).pipe(Effect.andThen(changes.notify)),
            ),
            Effect.forkScoped,
          );
          if (runtime.hasPendingBackgroundWork === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWork.",
            );
          }
          if (runtime.hasPendingBackgroundWorkForThread === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWorkForThread.",
            );
          }
          const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
          const hasPendingBackgroundWorkForThread = runtime.hasPendingBackgroundWorkForThread;
          const now = yield* DateTime.now;
          const taskA = "task-roster-a";
          const taskB = "task-roster-b";

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: appThreadA,
              providerThread: providerThreadA,
              now,
              attemptId: RunAttemptId.make("attempt-roster-iso-a"),
              text: "Background work on A.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 1);
          const processA = processQueues[0]!;
          yield* Queue.offer(
            processA.queue,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: taskA,
              tool_use_id: "toolu-roster-a",
              description: "work on A",
              is_backgrounded: true,
              task_type: "local_bash",
              uuid: "00000000-0000-4000-8000-000000000301",
              session_id: nativeIds[0],
            }),
          );
          yield* Queue.offer(
            processA.queue,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000302",
              result: "A settled with background work.",
            }),
          );
          yield* changes.until(() =>
            events.some(
              (event) =>
                event.type === "turn.terminal" &&
                event.providerThreadId === providerThreadA.id &&
                event.status === "completed",
            ),
          );
          const rosterAAfterSettle = providerThreadRosterEvents(events).findLast(
            (event) => event.providerThread.id === providerThreadA.id,
          )?.providerThread.pendingBackgroundTasks;
          assert.deepEqual(rosterAAfterSettle ?? [], [
            { taskId: taskA, description: "work on A", kind: "command" },
          ]);
          assert.isTrue(yield* hasPendingBackgroundWork);
          assert.isTrue(yield* hasPendingBackgroundWorkForThread(providerThreadA));
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadB));

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: appThreadB,
              providerThread: { ...providerThreadB, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-roster-iso-b"),
              text: "Background work on B.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 2);
          yield* changes.until(() =>
            providerThreadRosterEvents(events).some(
              (event) =>
                event.providerThread.id === providerThreadA.id &&
                event.providerThread.status === "idle" &&
                (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0,
            ),
          );
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadA));

          const processB = processQueues[1]!;
          yield* Queue.offer(
            processB.queue,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: taskB,
              tool_use_id: "toolu-roster-b",
              description: "work on B",
              is_backgrounded: true,
              task_type: "local_bash",
              uuid: "00000000-0000-4000-8000-000000000303",
              session_id: nativeIds[1],
            }),
          );
          yield* changes.until(() =>
            providerThreadRosterEvents(events).some(
              (event) =>
                event.providerThread.id === providerThreadB.id &&
                (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
            ),
          );
          assert.isTrue(yield* hasPendingBackgroundWorkForThread(providerThreadB));
          assert.isTrue(yield* hasPendingBackgroundWork);
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadA));

          yield* Queue.offer(
            processB.queue,
            claudeSdkFrame({
              type: "result",
              subtype: "error_during_execution",
              duration_ms: 10,
              duration_api_ms: 10,
              is_error: true,
              num_turns: 1,
              result: "B failed",
              stop_reason: "end_turn",
              total_cost_usd: 0,
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
              modelUsage: {},
              permission_denials: [],
              errors: ["B failed"],
              terminal_reason: "model_error",
              uuid: "00000000-0000-4000-8000-000000000304",
              session_id: nativeIds[1],
            }),
          );
          yield* changes.until(() =>
            events.some(
              (event) =>
                event.type === "turn.terminal" &&
                event.providerThreadId === providerThreadB.id &&
                event.status === "failed",
            ),
          );

          const rosterBAfterFail = providerThreadRosterEvents(events).findLast(
            (event) => event.providerThread.id === providerThreadB.id,
          )?.providerThread.pendingBackgroundTasks;
          assert.deepEqual(rosterBAfterFail ?? [], []);
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadA));
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadB));
          assert.isFalse(yield* hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect.each(["full-access", "approval-required"] as const)(
    "keeps a queued wake turn's tool callback with its continuation in %s mode",
    (runtimeMode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode,
            interactionMode: "default",
            cwd: "/workspace",
          });
          const firstAttempt = RunAttemptId.make("attempt-claude-wake-callback-1");
          const userAttempt = RunAttemptId.make("attempt-claude-wake-callback-2");
          const continuationAttempt = RunAttemptId.make("attempt-claude-wake-callback-3");
          const planToolUseId = "toolu_01WakePlanExitPlanMode";
          const planMarkdown = "# Wake plan\n\n1. Report the background result.";
          const stamp = (frame: SDKMessage, promptIndex: number) =>
            claudeSdkFrame({
              ...frame,
              user_message_uuid: harness.promptUuid(promptIndex),
            });
          const runOf = (attemptId: RunAttemptId) => RunId.make(`run-${attemptId}`);
          const planToolUse = claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_wake_plan",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: planToolUseId,
                  name: "ExitPlanMode",
                  input: { plan: planMarkdown },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000741",
            session_id: WAKE_NATIVE_SESSION,
          });
          const planToolResult = claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: planToolUseId,
                  content:
                    "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
                  is_error: true,
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000742",
            session_id: WAKE_NATIVE_SESSION,
          });

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: firstAttempt,
              text: "Run the build in the background.",
              attachments: [],
              runtimePolicy,
            }),
          );
          yield* Queue.offer(harness.sdkMessages, stamp(wakeTaskStarted, 0));
          yield* Queue.offer(
            harness.sdkMessages,
            stamp(
              makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000740", result: "STARTED" }),
              0,
            ),
          );
          yield* harness.awaitTerminal(1);

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: userAttempt,
              text: "Reply with exactly: USER_REPLY",
              attachments: [],
              runtimePolicy,
              providerTurnOrdinal: 2,
            }),
          );
          yield* Queue.offer(harness.sdkMessages, wakeNotification);
          // The SDK asks for permission only after streaming the tool_use.
          yield* harness.offerAndWait(planToolUse);
          const canUseTool = harness.getOpenedOptions()?.canUseTool;
          assert.isFunction(canUseTool);
          const callback = yield* Effect.promise(() =>
            canUseTool!(
              "ExitPlanMode",
              { plan: planMarkdown },
              {
                signal: new AbortController().signal,
                toolUseID: planToolUseId,
                requestId: "request-wake-plan",
              },
            ),
          );
          assert.equal(callback?.behavior, "deny");
          assert.include(
            callback?.behavior === "deny" ? callback.message : "",
            "The client captured your proposed plan",
          );
          yield* Queue.offer(harness.sdkMessages, planToolResult);
          yield* Queue.offer(harness.sdkMessages, wakeResult);
          yield* harness.awaitContinuation(1);

          yield* Queue.offer(
            harness.sdkMessages,
            stamp(
              makeAssistantTextFrame({
                uuid: "00000000-0000-4000-8000-000000000743",
                text: "USER_REPLY",
              }),
              1,
            ),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            stamp(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000000744",
                result: "USER_REPLY",
              }),
              1,
            ),
          );
          yield* harness.awaitTerminal(2);

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: continuationAttempt,
              text: "Background task completed.",
              attachments: [],
              runtimePolicy,
              providerTurnOrdinal: 3,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* harness.awaitTerminal(3);

          const latestItems = new Map(
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated"
                ? [[String(event.turnItem.id), event.turnItem]]
                : [],
            ),
          );
          const planTool = [...latestItems.values()].find(
            (item) =>
              item.type === "dynamic_tool" && item.nativeItemRef?.nativeId === planToolUseId,
          );
          const proposedPlans = [...latestItems.values()].filter(
            (item) => item.type === "proposed_plan",
          );
          const plans = harness.events.flatMap((event) =>
            event.type === "plan.updated" && event.plan.kind === "proposed_plan"
              ? [event.plan]
              : [],
          );
          const planToolRuns = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === planToolUseId &&
            event.turnItem.type === "dynamic_tool"
              ? [event.turnItem.runId]
              : [],
          );
          assert.isNotEmpty(planToolRuns);
          assert.isTrue(planToolRuns.every((runId) => runId === runOf(continuationAttempt)));
          assert.equal(planTool?.runId, runOf(continuationAttempt));
          assert.lengthOf(proposedPlans, 1);
          assert.equal(proposedPlans[0]?.runId, runOf(continuationAttempt));
          assert.isTrue(plans.length > 0);
          assert.isTrue(plans.every((plan) => plan.runId === runOf(continuationAttempt)));
          const userRunItems = [...latestItems.values()].filter(
            (item) => item.runId === runOf(userAttempt),
          );
          assert.deepEqual(
            userRunItems.map((item) => item.type),
            ["assistant_message"],
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("stores a Bash result's stdout and stderr as command output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const attemptId = RunAttemptId.make("attempt-claude-bash-output");
        const bashToolUseId = "toolu_01BashOutput";

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId,
            text: "Run it.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_bash_output",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: bashToolUseId,
                  name: "Bash",
                  input: { command: "git status" },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000790",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: bashToolUseId, content: "On branch main" },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000791",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: {
              stdout: "On branch main",
              stderr: "warning: dirty",
              interrupted: false,
              isImage: false,
            },
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000792", result: "Done." }),
        );
        yield* harness.awaitTerminal(1);

        const bash = harness.events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === bashToolUseId,
        );
        assert.equal(
          bash?.type === "turn_item.updated" && bash.turnItem.type === "command_execution"
            ? bash.turnItem.output
            : undefined,
          "On branch main\nwarning: dirty",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("answers an approval a held wake turn raises without waiting for the echo", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const approvalPolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const firstAttempt = RunAttemptId.make("attempt-claude-wake-approval-1");
        const userAttempt = RunAttemptId.make("attempt-claude-wake-approval-2");
        const bashToolUseId = "toolu_01WakeApprovalBash";
        const stamp = (frame: SDKMessage, promptIndex: number) =>
          claudeSdkFrame({
            ...frame,
            user_message_uuid: harness.promptUuid(promptIndex),
          });

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: firstAttempt,
            text: "First.",
            attachments: [],
            runtimePolicy: approvalPolicy,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000780", text: "One." }),
            0,
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000781", result: "One." }),
            0,
          ),
        );
        yield* harness.awaitTerminal(1);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: userAttempt,
            text: "Second.",
            attachments: [],
            providerTurnOrdinal: 2,
            runtimePolicy: approvalPolicy,
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_wake_bash",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: bashToolUseId,
                  name: "Bash",
                  input: { command: "git status" },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000782",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const permission = yield* Effect.promise(() =>
          harness.getOpenedOptions()!.canUseTool!(
            "Bash",
            { command: "git status" },
            {
              signal: new AbortController().signal,
              toolUseID: bashToolUseId,
              requestId: "request-wake-bash",
            },
          ),
        ).pipe(Effect.forkScoped);

        yield* harness.until(() =>
          harness.events.some((event) => event.type === "runtime_request.updated"),
        );
        const request = harness.events.findLast(
          (event) => event.type === "runtime_request.updated",
        );
        const bashItems = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === bashToolUseId
            ? [event.turnItem.runId]
            : [],
        );
        assert.isNotEmpty(bashItems);
        assert.isTrue(bashItems.every((runId) => runId === RunId.make(`run-${userAttempt}`)));
        if (request?.type !== "runtime_request.updated") return;
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: request.runtimeRequest.id,
          decision: "accept",
        });
        const result = yield* Fiber.join(permission);
        assert.equal(result?.behavior, "allow");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("releases output held for a prompt echo when the stream ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({
          close: (sdkMessages) => Queue.shutdown(sdkMessages),
        });
        const now = yield* DateTime.now;
        const firstAttempt = RunAttemptId.make("attempt-claude-echo-1");
        const secondAttempt = RunAttemptId.make("attempt-claude-echo-2");
        const stamp = (frame: SDKMessage, promptIndex: number) =>
          claudeSdkFrame({
            ...frame,
            user_message_uuid: harness.promptUuid(promptIndex),
          });
        const assistantTexts = () =>
          harness.events.flatMap((event) =>
            event.type === "message.updated" && event.message.role === "assistant"
              ? [event.message.text]
              : [],
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: firstAttempt,
            text: "First.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000701", text: "One." }),
            0,
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000702", result: "One." }),
            0,
          ),
        );
        yield* harness.awaitTerminal(1);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: secondAttempt,
            text: "Second.",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );
        yield* harness.offerAndWait(
          makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000703", text: "Two." }),
        );
        assert.deepEqual(assistantTexts(), ["One."]);

        yield* Queue.shutdown(harness.sdkMessages);
        yield* harness.awaitTerminal(2);
        assert.deepEqual(assistantTexts(), ["One.", "Two."]);
        assert.equal(harness.terminalEvents()[1]?.status, "failed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("fails a prompt Claude completes without starting a turn for it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Claude answers previously recorded prompt uuids with only a completed lifecycle frame.
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-duplicate-prompt"),
            text: "Bump this PR to the latest main.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "command_lifecycle",
            command_uuid: harness.promptUuid(0),
            state: "completed",
            uuid: "00000000-0000-4000-8000-000000000790",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* harness.awaitTerminal(1);
        const [terminal] = harness.terminalEvents();
        assert.equal(terminal?.status, "failed");
        if (terminal?.status !== "failed") return;
        assert.equal(terminal.threadDisposition, "reusable");
        assert.include(terminal.failure.message, "never started a turn");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  // regression: #16897 a prompt whose uuid the session already holds must not hang or end early
  it.effect("keeps a started prompt running until its result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-started-prompt"),
            text: "Bump this PR to the latest main.",
            attachments: [],
          }),
        );
        const lifecycle = (state: string, uuid: string) =>
          claudeSdkFrame({
            type: "command_lifecycle",
            command_uuid: harness.promptUuid(0),
            state,
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          });
        yield* Queue.offer(
          harness.sdkMessages,
          lifecycle("queued", "00000000-0000-4000-8000-000000000791"),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          lifecycle("started", "00000000-0000-4000-8000-000000000792"),
        );
        // The CLI can report the prompt completed before its turn's result.
        yield* Queue.offer(
          harness.sdkMessages,
          lifecycle("completed", "00000000-0000-4000-8000-000000000793"),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            ...makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000794", result: "Done." }),
            user_message_uuid: harness.promptUuid(0),
          }),
        );
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("buffers wake output and requests a single continuation run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-1"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);

        yield* harness.offerAndWait(wakeNotification);
        assert.lengthOf(harness.continuationRequests, 0);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(harness.sdkMessages, wakeAssistant);
        yield* harness.awaitContinuation(1);
        assert.equal(harness.continuationRequests[0]?.threadId, harness.threadId);
        assert.equal(harness.continuationRequests[0]?.providerThreadId, harness.providerThread.id);
        assert.equal(harness.continuationRequests[0]?.driver, ClaudeAdapterV2.CLAUDE_PROVIDER);
        assert.equal(harness.continuationRequests[0]?.detail, WAKE_SUMMARY);

        yield* harness.offerAndWait(wakeResult);
        assert.lengthOf(harness.continuationRequests, 1);
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("starts the wake run when Claude opens the wake turn, before its output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-init-1"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* harness.awaitTerminal(1);

        yield* harness.offerAndWait(wakeNotification);
        assert.lengthOf(harness.continuationRequests, 0);
        yield* harness.offerAndWait(wakeTurnInit);
        assert.lengthOf(harness.continuationRequests, 1);
        assert.equal(harness.continuationRequests[0]?.detail, WAKE_SUMMARY);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-init-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        assert.lengthOf(harness.terminalEvents(), 1);

        yield* harness.offerAndWait(wakeAssistant);
        yield* harness.offerAndWait(wakeResult);
        yield* harness.awaitTerminal(2);
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.lengthOf(harness.continuationRequests, 1);
        assert.isTrue(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([true, false])(
    "carries a rejected wake rate limit into the continuation failure (event=%s)",
    (standaloneEvent) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const resetsAt = 1790298600;

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-wake-limit-1"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
          yield* Queue.offer(harness.sdkMessages, turnOneResult);
          yield* Queue.take(harness.terminalReceipts);

          yield* Queue.offer(harness.sdkMessages, wakeNotification);
          if (standaloneEvent) {
            yield* harness.offerAndWait(
              claudeSdkFrame({
                type: "rate_limit_event",
                rate_limit_info: {
                  status: "rejected",
                  rateLimitType: "five_hour",
                  resetsAt,
                  overageStatus: "rejected",
                },
                uuid: "00000000-0000-4000-8000-000000000630",
                session_id: WAKE_NATIVE_SESSION,
              }),
            );
          }
          assert.lengthOf(harness.continuationRequests, 0);
          yield* harness.offerAndWait(
            makeAssistantErrorFrame({
              uuid: "00000000-0000-4000-8000-000000000631",
              error: "rate_limit",
              apiErrorParams: {
                rate_limit_info: {
                  status: "rejected",
                  rateLimitType: "five_hour",
                  // A conflicting embedded time must not replace the event for this window.
                  resetsAt: standaloneEvent ? resetsAt + 3_600 : resetsAt,
                },
              },
            }),
          );
          assert.lengthOf(harness.continuationRequests, 1);
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000632",
              result: "You've hit your session limit · resets 11:10am (Australia/Sydney)",
              isError: true,
              apiErrorStatus: 429,
              terminalReason: "api_error",
              origin: { kind: "task-notification" },
            }),
          );
          assert.lengthOf(harness.continuationRequests, 1);

          // An empty session-task lifecycle result arriving before T3 opens the
          // wake run must not replace the root's terminal usage-limit result.
          yield* harness.offerAndWait(wakeTurnInit);
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000633",
              result: "",
              numTurns: 0,
              origin: { kind: "task-notification" },
              terminalReason: null,
            }),
          );

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-wake-limit-2"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          const terminal = yield* Queue.take(harness.terminalReceipts);
          assert.equal(terminal?.status, "failed");
          if (terminal === undefined || terminal.status !== "failed") return;
          assert.equal(terminal.failure.class, "usage_limit");
          assert.equal(terminal.failure.resetAt, "2026-09-25T01:10:00.000Z");
          if (standaloneEvent) {
            const pause = yield* Queue.take(harness.systemNoticeReceipts);
            assert.equal(pause.turnItem.type, "system_notice");
            if (pause.turnItem.type !== "system_notice") return;
            assert.include(pause.turnItem.message, "This turn is paused until the 5-hour limit");
          }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("leaves buffered wake messages for the continuation queued behind a user turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-4a"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* harness.awaitTerminal(1);
        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* Queue.offer(harness.sdkMessages, wakeResult);
        yield* harness.awaitContinuation(1);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-4b"),
            text: "How is the build going?",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );

        yield* harness.until(() => harness.offeredMessages.length === 2);
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000105",
            result: "The build passed; nothing else pending.",
          }),
        );
        yield* harness.awaitTerminal(2);
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.isFalse(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
          ),
        );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-4c"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 3,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(3);
        assert.equal(harness.terminalEvents()[2]?.status, "completed");
        assert.lengthOf(harness.offeredMessages, 2);
        assert.isTrue(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
          ),
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type !== "provider_thread.updated" &&
              JSON.stringify(event).includes(WAKE_TASK_ID),
          ),
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("ignores a zero-turn task-notification origin result during a normal user turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const probeAssistantText = "Probe after stale task-notification result.";
        const recoveryAssistantText = "Recovered after the interrupt; continuing.";
        const staleResultText = STALE_TASK_NOTIFICATION_RESULT_TEXT;
        const hasMessageText = (text: string) =>
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === text,
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-stale-notif-1"),
            text: "Continue after interrupt.",
            attachments: [],
          }),
        );
        yield* harness.until(() => harness.offeredMessages.length === 1);

        // After interrupt recovery, stale task notifications and their results can precede the root stream.
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: "task-stale-stopped",
            tool_use_id: "toolu-stale-stopped",
            status: "stopped",
            output_file: "/tmp/task-stale-stopped.log",
            summary: "",
            uuid: "00000000-0000-4000-8000-000000000107",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(harness.sdkMessages, staleTaskNotificationResult);
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-00000000010a",
            text: probeAssistantText,
          }),
        );

        yield* harness.until(() => hasMessageText(probeAssistantText));
        assert.lengthOf(harness.terminalEvents(), 0);
        assert.isFalse(hasMessageText(staleResultText));

        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000108",
            text: recoveryAssistantText,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000109",
            result: recoveryAssistantText,
          }),
        );

        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.isTrue(hasMessageText(recoveryAssistantText));
        assert.isFalse(hasMessageText(staleResultText));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect(
    "emits one interrupted terminal for a positive task-notification result racing interrupt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const closeGate = yield* Deferred.make<void>();
          const testScope = yield* Scope.Scope;
          yield* Scope.addFinalizer(testScope, Deferred.succeed(closeGate, undefined));
          const interruptStarted = yield* Deferred.make<void>();
          const harness = yield* makeWakeHarnessWithOptions({
            close: (sdkMessages) =>
              Deferred.await(closeGate).pipe(Effect.andThen(Queue.shutdown(sdkMessages))),
            stopTask: () => Effect.void,
            interrupt: Deferred.succeed(interruptStarted, undefined),
          });
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const now = yield* DateTime.now;
          const attemptId = RunAttemptId.make("attempt-claude-interrupt-positive-notif");
          const providerTurnId = idAllocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${attemptId}`,
          });

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId,
              text: "Stop this task.",
              attachments: [],
            }),
          );
          yield* harness.runtime
            .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(interruptStarted);
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000115",
              result: "Late result after interrupt.",
              numTurns: 7,
              origin: { kind: "task-notification" },
            }),
          );
          const terminalized = Exit.isSuccess(yield* harness.awaitTerminal(1).pipe(Effect.exit));
          yield* Deferred.succeed(closeGate, undefined);
          assert.isTrue(terminalized);
          assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
          assert.lengthOf(harness.terminalEvents(), 1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("settles a continuation turn immediately when no wake output is buffered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-3"),
            text: "Background task completed.",
            attachments: [],
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );

        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.lengthOf(harness.offeredMessages, 0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const makeSubagentAssistantFrames = (input: {
    readonly parentToolUseId: string;
    readonly uuid: string;
    readonly messageId?: string;
    readonly text?: string;
    readonly bashToolUseId?: string;
  }): ReadonlyArray<SDKMessage> =>
    [
      ...(input.text === undefined ? [] : [{ type: "text", text: input.text }]),
      ...(input.bashToolUseId === undefined
        ? []
        : [
            {
              type: "tool_use",
              id: input.bashToolUseId,
              name: "Bash",
              input: { command: "git log -5" },
            },
          ]),
    ].map((block, index) =>
      claudeSdkFrame({
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          id: input.messageId ?? `msg_${input.uuid}`,
          type: "message",
          role: "assistant",
          content: [block],
        },
        parent_tool_use_id: input.parentToolUseId,
        uuid: index === 0 ? input.uuid : `${input.uuid}:${index}`,
        session_id: WAKE_NATIVE_SESSION,
      }),
    );
  const makeSubagentToolResultFrame = (input: {
    readonly parentToolUseId: string;
    readonly uuid: string;
    readonly toolUseId: string;
  }) =>
    claudeSdkFrame({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: input.toolUseId, content: "ok" }],
      },
      parent_tool_use_id: input.parentToolUseId,
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const makeSubagentTaskStartedFrame = (input: {
    readonly taskId: string;
    readonly toolUseId: string;
    readonly uuid: string;
  }) =>
    claudeSdkFrame({
      type: "system",
      subtype: "task_started",
      task_id: input.taskId,
      tool_use_id: input.toolUseId,
      description: "Audit recent commits",
      subagent_type: "general-purpose",
      is_backgrounded: true,
      task_type: "local_agent",
      prompt: "Audit the last five commits.",
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const makeSubagentNotificationFrame = (input: {
    readonly taskId: string;
    readonly toolUseId: string;
    readonly summary: string;
    readonly uuid: string;
  }) =>
    claudeSdkFrame({
      type: "system",
      subtype: "task_notification",
      task_id: input.taskId,
      tool_use_id: input.toolUseId,
      status: "completed",
      output_file: `/tmp/${input.taskId}.output`,
      summary: input.summary,
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const subagentRouting = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
    nativeToolIds: ReadonlyArray<string>,
  ) => {
    const childThreadId =
      events.find((event) => event.type === "subagent.updated")?.subagent.childThreadId ??
      undefined;
    const toolThreadIds = new Map<string, Set<string>>();
    for (const event of events) {
      const nativeId =
        event.type === "turn_item.updated" ? event.turnItem.nativeItemRef?.nativeId : undefined;
      if (event.type === "turn_item.updated" && nativeId && nativeToolIds.includes(nativeId)) {
        toolThreadIds.set(
          nativeId,
          (toolThreadIds.get(nativeId) ?? new Set()).add(event.turnItem.threadId),
        );
      }
    }
    const assistantTexts = (threadId: string | undefined) =>
      events.flatMap((event) =>
        event.type === "message.updated" &&
        event.message.role === "assistant" &&
        event.message.threadId === threadId
          ? [event.message.text]
          : [],
      );
    return { childThreadId, toolThreadIds, assistantTexts };
  };

  it.effect.each([
    { label: "an empty one", quotaFailureFirst: false },
    { label: "a quota failure and an empty one", quotaFailureFirst: true },
  ])(
    "keeps the wake run open for the turn Claude opens right after $label",
    ({ quotaFailureFirst }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const subagents = [
            { taskId: "task-wake-pair-a", toolUseId: "toolu_wake_pair_a" },
            { taskId: "task-wake-pair-b", toolUseId: "toolu_wake_pair_b" },
          ];
          const wakeAttempt = RunAttemptId.make("attempt-claude-wake-pair-2");

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-wake-pair-1"),
              text: "Audit both in the background.",
              attachments: [],
            }),
          );
          for (const [index, subagent] of subagents.entries()) {
            yield* Queue.offer(
              harness.sdkMessages,
              makeSubagentTaskStartedFrame({
                ...subagent,
                uuid: `00000000-0000-4000-8000-00000000095${index}`,
              }),
            );
          }
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000952", result: "Started." }),
          );
          yield* harness.awaitTerminal(1);

          // Both subagents end together. Claude runs an empty turn for the first
          // notification and opens the real one a millisecond later, all before
          // the wake run attaches.
          for (const [index, subagent] of subagents.entries()) {
            yield* Queue.offer(
              harness.sdkMessages,
              makeSubagentNotificationFrame({
                ...subagent,
                summary: "AUDITED",
                uuid: `00000000-0000-4000-8000-00000000096${index}`,
              }),
            );
          }
          // A rejected wake that precedes the empty turn still must not settle
          // the run the live turn owns.
          if (quotaFailureFirst) {
            yield* harness.offerAndWait(
              makeAssistantErrorFrame({
                uuid: "00000000-0000-4000-8000-000000000964",
                error: "rate_limit",
              }),
            );
            yield* harness.offerAndWait(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000000965",
                result: "You've hit your session limit · resets 11:10am (Australia/Sydney)",
                isError: true,
                apiErrorStatus: 429,
                terminalReason: "api_error",
                origin: { kind: "task-notification" },
              }),
            );
          }
          yield* Queue.offer(harness.sdkMessages, wakeTurnInit);
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000962",
              result: "",
              numTurns: 0,
              origin: { kind: "task-notification" },
              terminalReason: null,
            }),
          );
          yield* harness.offerAndWait(
            claudeSdkFrame({ ...wakeTurnInit, uuid: "00000000-0000-4000-8000-000000000963" }),
          );
          assert.lengthOf(harness.continuationRequests, 1);

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: wakeAttempt,
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          // Claude is still thinking, so the run stays working rather than
          // settling with nothing to show.
          assert.lengthOf(harness.terminalEvents(), 1);

          yield* harness.offerAndWait(wakeAssistant);
          yield* harness.offerAndWait(wakeResult);
          yield* harness.awaitTerminal(2);
          assert.equal(harness.terminalEvents()[1]?.status, "completed");
          assert.lengthOf(harness.continuationRequests, 1);
          assert.isTrue(
            harness.events.some(
              (event) =>
                event.type === "message.updated" &&
                event.message.runId === RunId.make(`run-${wakeAttempt}`) &&
                event.message.text === WAKE_RESULT_TEXT,
            ),
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("streams a background subagent's work while the root turn is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const TASK_ID = "task-live-idle";
        const TOOL_USE_ID = "toolu-live-idle";
        const STRADDLING_BASH = "toolu-live-straddling-bash";
        const IDLE_BASH = "toolu-live-idle-bash";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const latestToolItem = (nativeId: string) =>
          harness.events.findLast(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === nativeId,
          );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-live-idle-1"),
            text: "Audit in the background.",
            attachments: [],
          }),
        );
        for (const frame of [
          makeSubagentTaskStartedFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000951",
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000952",
            bashToolUseId: STRADDLING_BASH,
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000953",
            result: "Auditing in the background.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitTerminal(1);

        for (const frame of [
          makeSubagentToolResultFrame({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000954",
            toolUseId: STRADDLING_BASH,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000955",
            text: "Still auditing.",
            bashToolUseId: IDLE_BASH,
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: TASK_ID,
            description: "Reading the last commits",
            uuid: "00000000-0000-4000-8000-000000000956",
            session_id: WAKE_NATIVE_SESSION,
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.until(() => {
          const event = latestToolItem(IDLE_BASH);
          return event?.type === "turn_item.updated" && event.turnItem.status === "running";
        });
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.progress === "Reading the last commits",
          ),
        );
        const routing = subagentRouting(harness.events, [STRADDLING_BASH, IDLE_BASH]);
        assert.deepEqual(routing.assistantTexts(routing.childThreadId), ["Still auditing."]);
        const straddling = latestToolItem(STRADDLING_BASH);
        const straddlingItem =
          straddling?.type === "turn_item.updated" ? straddling.turnItem : undefined;
        assert.equal(straddlingItem?.status, "completed");
        assert.equal(
          straddlingItem?.type === "command_execution" ? straddlingItem.input : undefined,
          "git log -5",
        );
        assert.equal(harness.continuationRequests.length, 0);

        for (const frame of [
          makeSubagentToolResultFrame({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000957",
            toolUseId: IDLE_BASH,
          }),
          makeSubagentNotificationFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            summary: "Still auditing.",
            uuid: "00000000-0000-4000-8000-000000000958",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitContinuation(1);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000959",
            result: "The auditor finished.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-live-idle-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(2);

        const finalRouting = subagentRouting(harness.events, [STRADDLING_BASH, IDLE_BASH]);
        assert.deepEqual(finalRouting.assistantTexts(finalRouting.childThreadId), [
          "Still auditing.",
        ]);
        for (const nativeId of [STRADDLING_BASH, IDLE_BASH]) {
          assert.deepEqual(
            [...(finalRouting.toolThreadIds.get(nativeId) ?? [])],
            [finalRouting.childThreadId],
          );
          const statuses = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId
              ? [`${event.turnItem.type}:${event.turnItem.status}`]
              : [],
          );
          assert.deepEqual(statuses, ["command_execution:running", "command_execution:completed"]);
        }
        const finalSubagent = harness.events.findLast((event) => event.type === "subagent.updated");
        assert.equal(
          finalSubagent?.type === "subagent.updated" && finalSubagent.subagent.status,
          "completed",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("keeps a nested subagent's launch in order while the root turn is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const OUTER_TASK_ID = "task-idle-outer";
        const OUTER_TOOL_USE_ID = "toolu-idle-outer";
        const NESTED_TASK_ID = "task-idle-nested";
        const NESTED_TOOL_USE_ID = "toolu-idle-nested";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-idle-nested-1"),
            text: "Audit in the background.",
            attachments: [],
          }),
        );
        for (const frame of [
          makeSubagentTaskStartedFrame({
            taskId: OUTER_TASK_ID,
            toolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000971",
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000972",
            result: "Auditing in the background.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitTerminal(1);

        for (const frame of [
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_idle_nested_launch",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: NESTED_TOOL_USE_ID,
                  name: "Agent",
                  input: { description: "Nested check", prompt: "Reply with NESTED_OK" },
                },
              ],
            },
            parent_tool_use_id: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000973",
            session_id: WAKE_NATIVE_SESSION,
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: NESTED_TASK_ID,
            tool_use_id: NESTED_TOOL_USE_ID,
            description: "Nested check",
            subagent_type: "general-purpose",
            is_backgrounded: false,
            spawn_depth: 2,
            task_type: "local_agent",
            prompt: "Reply with NESTED_OK",
            uuid: "00000000-0000-4000-8000-000000000974",
            session_id: WAKE_NATIVE_SESSION,
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: OUTER_TASK_ID,
            description: "Waiting on the nested check",
            uuid: "00000000-0000-4000-8000-000000000984",
            session_id: WAKE_NATIVE_SESSION,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000988",
            messageId: "msg_idle_outer_working",
            text: "OUTER_WORKING",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.until(() =>
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === "OUTER_WORKING",
          ),
        );
        assert.lengthOf(harness.continuationRequests, 0);
        for (const frame of [
          ...makeSubagentAssistantFrames({
            parentToolUseId: NESTED_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000975",
            text: "NESTED_OK",
          }),
          makeSubagentNotificationFrame({
            taskId: NESTED_TASK_ID,
            toolUseId: NESTED_TOOL_USE_ID,
            summary: "NESTED_OK",
            uuid: "00000000-0000-4000-8000-000000000976",
          }),
          makeSubagentToolResultFrame({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000977",
            toolUseId: NESTED_TOOL_USE_ID,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000978",
            text: "OUTER_DONE",
          }),
          makeSubagentNotificationFrame({
            taskId: OUTER_TASK_ID,
            toolUseId: OUTER_TOOL_USE_ID,
            summary: "OUTER_DONE",
            uuid: "00000000-0000-4000-8000-000000000979",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitContinuation(1);
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.progress === "Waiting on the nested check",
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000980",
            result: "The audit finished.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-idle-nested-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(2);

        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === NESTED_TOOL_USE_ID,
          ),
        );
        const finalSubagents = new Map(
          harness.events.flatMap((event) =>
            event.type === "subagent.updated"
              ? [[event.subagent.nativeTaskRef?.nativeId, event.subagent] as const]
              : [],
          ),
        );
        const outer = finalSubagents.get(OUTER_TASK_ID);
        const nested = finalSubagents.get(NESTED_TASK_ID);
        assert.equal(outer?.status, "completed");
        assert.equal(nested?.status, "completed");
        assert.equal(nested?.parentNodeId, outer?.id);
        assert.deepEqual(
          subagentRouting(harness.events, []).assistantTexts(outer?.childThreadId ?? undefined),
          ["OUTER_WORKING", "OUTER_DONE"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("ends an earlier turn's nested subagent while the root turn is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const OUTER_TASK_ID = "task-earlier-outer";
        const OUTER_TOOL_USE_ID = "toolu-earlier-outer";
        const NESTED_TASK_ID = "task-earlier-nested";
        const NESTED_TOOL_USE_ID = "toolu-earlier-nested";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const userTurn = (attemptId: string, providerTurnOrdinal: number) =>
          harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make(attemptId),
              text: "Keep auditing.",
              attachments: [],
              providerTurnOrdinal,
            }),
          );
        yield* userTurn("attempt-claude-earlier-nested-1", 1);
        for (const frame of [
          makeSubagentTaskStartedFrame({
            taskId: OUTER_TASK_ID,
            toolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000a01",
          }),
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_earlier_nested_launch",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: NESTED_TOOL_USE_ID,
                  name: "Agent",
                  input: { description: "Nested check", prompt: "Reply with NESTED_OK" },
                },
              ],
            },
            parent_tool_use_id: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000a02",
            session_id: WAKE_NATIVE_SESSION,
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: NESTED_TASK_ID,
            tool_use_id: NESTED_TOOL_USE_ID,
            description: "Nested check",
            subagent_type: "general-purpose",
            is_backgrounded: false,
            spawn_depth: 2,
            task_type: "local_agent",
            prompt: "Reply with NESTED_OK",
            uuid: "00000000-0000-4000-8000-000000000a03",
            session_id: WAKE_NATIVE_SESSION,
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000a04",
            result: "Auditing in the background.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitTerminal(1);
        yield* userTurn("attempt-claude-earlier-nested-2", 2);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000a05", result: "Still on it." }),
        );
        yield* harness.awaitTerminal(2);

        for (const frame of [
          makeSubagentNotificationFrame({
            taskId: NESTED_TASK_ID,
            toolUseId: NESTED_TOOL_USE_ID,
            summary: "NESTED_OK",
            uuid: "00000000-0000-4000-8000-000000000a06",
          }),
          makeSubagentToolResultFrame({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000a07",
            toolUseId: NESTED_TOOL_USE_ID,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000a08",
            text: "OUTER_AFTER_NESTED",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "message.updated" && event.message.text === "OUTER_AFTER_NESTED",
          ),
        );

        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === NESTED_TOOL_USE_ID,
          ),
        );
        const nested = harness.events.findLast(
          (event) =>
            event.type === "subagent.updated" &&
            event.subagent.nativeTaskRef?.nativeId === NESTED_TASK_ID,
        );
        assert.equal(nested?.type === "subagent.updated" && nested.subagent.status, "completed");
        assert.lengthOf(harness.continuationRequests, 0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each(["exit", "Stop"] as const)(
    "settles a plain background subagent and its open call on %s after the root turn completes",
    (reason) =>
      Effect.scoped(
        Effect.gen(function* () {
          const TOOL_USE_ID = "toolu-idle-exit";
          const BASH = "toolu-idle-exit-bash";
          const harness = yield* makeWakeHarnessWithOptions({ close: Queue.shutdown });
          const now = yield* DateTime.now;
          const bashStatuses = () =>
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === BASH
                ? [`${event.turnItem.type}:${event.turnItem.status}`]
                : [],
            );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-idle-exit"),
              text: "Audit in the background.",
              attachments: [],
            }),
          );
          yield* harness.offerAndWait(
            makeSubagentTaskStartedFrame({
              taskId: "task-idle-exit",
              toolUseId: TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000000981",
            }),
          );
          const started = yield* Queue.take(harness.subagentReceipts);
          assert.equal(started.subagent.status, "running");
          for (const frame of makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000982",
            bashToolUseId: BASH,
          })) {
            yield* harness.offerAndWait(frame);
          }
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000983",
              result: "Auditing in the background.",
            }),
          );
          const terminal = yield* Queue.take(harness.terminalReceipts);
          assert.equal(terminal.status, "completed");
          assert.isTrue(yield* harness.hasPendingBackgroundWork);
          assert.deepEqual(bashStatuses(), ["command_execution:running"]);

          if (reason === "Stop") {
            yield* harness.runtime.interruptTurn({
              providerThread: harness.providerThread,
              providerTurnId: terminal.providerTurnId,
              requestRuntimeRestart: true,
            });
          } else {
            yield* Queue.shutdown(harness.sdkMessages);
          }
          let ended = yield* Queue.take(harness.subagentReceipts);
          while (ended.subagent.status === "running") {
            ended = yield* Queue.take(harness.subagentReceipts);
          }
          assert.equal(ended.subagent.nativeTaskRef?.nativeId, "task-idle-exit");
          assert.equal(ended.subagent.status, reason === "Stop" ? "cancelled" : "failed");
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
          assert.deepEqual(bashStatuses(), [
            "command_execution:running",
            reason === "Stop" ? "command_execution:interrupted" : "command_execution:failed",
          ]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect.each(["before", "after"] as const)(
    "keeps a subagent call's result when the CLI exits before the drain (result %s the nested launch's)",
    (bashResultOrder) =>
      Effect.scoped(
        Effect.gen(function* () {
          const OUTER_TASK_ID = "task-exit-buffered-outer";
          const OUTER_TOOL_USE_ID = "toolu-exit-buffered-outer";
          const NESTED_TASK_ID = "task-exit-buffered-nested";
          const NESTED_TOOL_USE_ID = "toolu-exit-buffered-nested";
          const BASH = "toolu-exit-buffered-bash";
          const harness = yield* makeWakeHarnessWithOptions({ freshQueueOnReopen: true });
          const now = yield* DateTime.now;
          const bashItems = () =>
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === BASH
                ? [
                    `${event.turnItem.type}:${event.turnItem.status}:${JSON.stringify("input" in event.turnItem ? event.turnItem.input : null)}`,
                  ]
                : [],
            );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-exit-buffered-1"),
              text: "Audit in the background.",
              attachments: [],
            }),
          );
          for (const frame of [
            makeSubagentTaskStartedFrame({
              taskId: OUTER_TASK_ID,
              toolUseId: OUTER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001001",
            }),
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000001002",
              result: "Auditing in the background.",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitTerminal(1);

          for (const frame of makeSubagentAssistantFrames({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000001003",
            bashToolUseId: BASH,
          })) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.until(() => bashItems().length === 1);

          const bashResultFrame = makeSubagentToolResultFrame({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000001006",
            toolUseId: BASH,
          });
          for (const frame of [
            claudeSdkFrame({
              type: "assistant",
              message: {
                model: "claude-sonnet-4-6",
                id: "msg_exit_buffered_nested_launch",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: NESTED_TOOL_USE_ID,
                    name: "Agent",
                    input: { description: "Nested check", prompt: "Reply with NESTED_OK" },
                  },
                ],
              },
              parent_tool_use_id: OUTER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001004",
              session_id: WAKE_NATIVE_SESSION,
            }),
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: NESTED_TASK_ID,
              tool_use_id: NESTED_TOOL_USE_ID,
              description: "Nested check",
              subagent_type: "general-purpose",
              is_backgrounded: false,
              spawn_depth: 2,
              task_type: "local_agent",
              prompt: "Reply with NESTED_OK",
              uuid: "00000000-0000-4000-8000-000000001005",
              session_id: WAKE_NATIVE_SESSION,
            }),
            ...(bashResultOrder === "before" ? [bashResultFrame] : []),
            ...makeSubagentAssistantFrames({
              parentToolUseId: NESTED_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001007",
              text: "NESTED_OK",
            }),
            makeSubagentNotificationFrame({
              taskId: NESTED_TASK_ID,
              toolUseId: NESTED_TOOL_USE_ID,
              summary: "NESTED_OK",
              uuid: "00000000-0000-4000-8000-000000001008",
            }),
            makeSubagentToolResultFrame({
              parentToolUseId: OUTER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001009",
              toolUseId: NESTED_TOOL_USE_ID,
            }),
            ...(bashResultOrder === "after" ? [bashResultFrame] : []),
            makeSubagentNotificationFrame({
              taskId: OUTER_TASK_ID,
              toolUseId: OUTER_TOOL_USE_ID,
              summary: "OUTER_DONE",
              uuid: "00000000-0000-4000-8000-000000001010",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitContinuation(1);

          yield* Queue.shutdown(harness.sdkMessages);
          yield* yieldTicks(50);
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-exit-buffered-2"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          assert.equal(harness.processQueues.length, 2);
          yield* Queue.offer(
            harness.processQueues[1]!,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000001011",
              result: "The audit finished.",
            }),
          );
          yield* harness.awaitTerminal(2);

          const input = JSON.stringify("git log -5");
          assert.deepEqual(bashItems(), [
            `command_execution:running:${input}`,
            `command_execution:completed:${input}`,
          ]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect(
    "ends a subagent's SendMessage with its result when the CLI exits while the resume waits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const SENDER_TASK_ID = "task-exit-resume-sender";
          const SENDER_TOOL_USE_ID = "toolu-exit-resume-sender";
          const RESUMED_TASK_ID = "task-exit-resume-target";
          const RESUMED_TOOL_USE_ID = "toolu-exit-resume-target";
          const SEND = "toolu-exit-resume-sendmessage";
          const SEND_INPUT = { to: RESUMED_TASK_ID, message: "Check the last commit again." };
          const harness = yield* makeWakeHarnessWithOptions({ freshQueueOnReopen: true });
          const now = yield* DateTime.now;
          const sendItems = () =>
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === SEND
                ? [
                    `${event.turnItem.type}:${event.turnItem.status}:${JSON.stringify("input" in event.turnItem ? event.turnItem.input : null)}`,
                  ]
                : [],
            );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-exit-resume-1"),
              text: "Run two auditors in the background.",
              attachments: [],
            }),
          );
          for (const frame of [
            makeSubagentTaskStartedFrame({
              taskId: SENDER_TASK_ID,
              toolUseId: SENDER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001101",
            }),
            makeSubagentTaskStartedFrame({
              taskId: RESUMED_TASK_ID,
              toolUseId: RESUMED_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001102",
            }),
            makeSubagentNotificationFrame({
              taskId: RESUMED_TASK_ID,
              toolUseId: RESUMED_TOOL_USE_ID,
              summary: "First answer.",
              uuid: "00000000-0000-4000-8000-000000001103",
            }),
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000001104",
              result: "Auditing in the background.",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitTerminal(1);

          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "assistant",
              message: {
                model: "claude-sonnet-4-6",
                id: "msg_exit_resume_sendmessage",
                type: "message",
                role: "assistant",
                content: [{ type: "tool_use", id: SEND, name: "SendMessage", input: SEND_INPUT }],
              },
              parent_tool_use_id: SENDER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001105",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* harness.until(() => sendItems().length >= 1);

          for (const frame of [
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: RESUMED_TASK_ID,
              tool_use_id: SEND,
              description: "Audit recent commits",
              is_backgrounded: true,
              task_type: "local_agent",
              prompt: SEND_INPUT.message,
              uuid: "00000000-0000-4000-8000-000000001106",
              session_id: WAKE_NATIVE_SESSION,
            }),
            claudeSdkFrame({
              type: "user",
              message: {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: SEND, content: "Message sent." }],
              },
              parent_tool_use_id: SENDER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001107",
              session_id: WAKE_NATIVE_SESSION,
            }),
            makeSubagentNotificationFrame({
              taskId: RESUMED_TASK_ID,
              toolUseId: SEND,
              summary: "Second answer.",
              uuid: "00000000-0000-4000-8000-000000001108",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitContinuation(1);
          const beforeExit = sendItems();

          yield* Queue.shutdown(harness.sdkMessages);
          yield* yieldTicks(50);
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-exit-resume-2"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          assert.equal(harness.processQueues.length, 2);
          yield* Queue.offer(
            harness.processQueues[1]!,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000001109",
              result: "The audit finished.",
            }),
          );
          yield* harness.awaitTerminal(2);

          const input = JSON.stringify(SEND_INPUT);
          assert.deepEqual(beforeExit, [`dynamic_tool:running:${input}`]);
          assert.deepEqual(sendItems(), [
            `dynamic_tool:running:${input}`,
            `dynamic_tool:completed:${input}`,
          ]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect.each([
    ["", "none"],
    [" behind another subagent's start without one", "before"],
    [" when another subagent's start without one arrives between its frames", "between"],
  ] as const)(
    "keeps a subagent's frames in order when a late progress names its tool use while the root is idle%s",
    ([, otherStart]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const TASK_ID = "task-late-owner-idle";
          const TOOL_USE_ID = "toolu-late-owner-idle";
          const BASH = "toolu-late-owner-idle-bash";
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const bashStatuses = () =>
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === BASH
                ? [`${event.turnItem.type}:${event.turnItem.status}`]
                : [],
            );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-late-owner-idle-1"),
              text: "Audit in the background.",
              attachments: [],
            }),
          );
          for (const frame of [
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: TASK_ID,
              description: "Audit recent commits",
              subagent_type: "general-purpose",
              is_backgrounded: true,
              task_type: "local_agent",
              prompt: "Audit the last five commits.",
              uuid: "00000000-0000-4000-8000-000000000a01",
              session_id: WAKE_NATIVE_SESSION,
            }),
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000a02",
              result: "Auditing in the background.",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitTerminal(1);

          const otherStartFrame = claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: "task-late-owner-other",
            description: "Check the changelog",
            subagent_type: "general-purpose",
            is_backgrounded: true,
            task_type: "local_agent",
            prompt: "Check the changelog.",
            uuid: "00000000-0000-4000-8000-000000000a09",
            session_id: WAKE_NATIVE_SESSION,
          });
          const progressFrame = claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: TASK_ID,
            tool_use_id: TOOL_USE_ID,
            description: "Reading the last commits",
            usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
            uuid: "00000000-0000-4000-8000-000000000a04",
            session_id: WAKE_NATIVE_SESSION,
          });
          const bashResultFrame = makeSubagentToolResultFrame({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000a05",
            toolUseId: BASH,
          });
          for (const frame of [
            ...(otherStart === "before" ? [otherStartFrame] : []),
            ...makeSubagentAssistantFrames({
              parentToolUseId: TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000000a03",
              text: "First.",
              bashToolUseId: BASH,
            }),
            ...(otherStart === "between"
              ? [otherStartFrame, bashResultFrame, progressFrame]
              : [progressFrame, bashResultFrame]),
            ...makeSubagentAssistantFrames({
              parentToolUseId: TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000000a06",
              text: "Second.",
            }),
            makeSubagentNotificationFrame({
              taskId: TASK_ID,
              toolUseId: TOOL_USE_ID,
              summary: "Second.",
              uuid: "00000000-0000-4000-8000-000000000a07",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitContinuation(1);
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000a08",
              result: "The auditor finished.",
            }),
          );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-late-owner-idle-2"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* harness.awaitTerminal(2);

          const routing = subagentRouting(harness.events, [BASH]);
          const childTexts = routing.assistantTexts(routing.childThreadId);
          const statuses = bashStatuses();
          const trace = harness.events.flatMap((event) =>
            event.type === "message.updated" &&
            event.message.role === "assistant" &&
            event.message.threadId === routing.childThreadId
              ? [`text:${event.message.text}#${event.message.id}`]
              : event.type === "turn_item.updated" &&
                  event.turnItem.nativeItemRef?.nativeId === BASH
                ? [`bash:${event.turnItem.status}`]
                : [],
          );
          assert.deepEqual(childTexts, ["First.", "Second."], `trace: ${JSON.stringify(trace)}`);
          assert.deepEqual(
            [...(routing.toolThreadIds.get(BASH) ?? [])],
            [routing.childThreadId],
            `trace: ${JSON.stringify(trace)}`,
          );
          assert.deepEqual(
            statuses,
            ["command_execution:running", "command_execution:completed"],
            `trace: ${JSON.stringify(trace)}`,
          );
          assert.isTrue(
            harness.events.some(
              (event) =>
                event.type === "subagent.updated" &&
                event.subagent.progress === "Reading the last commits",
            ),
          );
          assert.lengthOf(harness.continuationRequests, 1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("holds subagent frames that precede task_started and shows its result once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const TASK_ID = "task-early-subagent";
        const TOOL_USE_ID = "toolu-early-subagent";
        const FINAL_REPORT = "Early auditor done.";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-early-subagent"),
            text: "Run an auditor.",
            attachments: [],
          }),
        );
        const frames = [
          // Child frames can precede the task_started that registers their subagent.
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000321",
            text: "Starting early.",
            bashToolUseId: "toolu-early-bash",
          }),
          makeSubagentToolResultFrame({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000322",
            toolUseId: "toolu-early-bash",
          }),
          makeSubagentTaskStartedFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000323",
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000324",
            text: "Still working.",
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: TASK_ID,
            description: "Checking the diffs",
            uuid: "00000000-0000-4000-8000-000000000325",
            session_id: WAKE_NATIVE_SESSION,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000326",
            text: FINAL_REPORT,
          }),
          makeSubagentNotificationFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            summary: FINAL_REPORT,
            uuid: "00000000-0000-4000-8000-000000000327",
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000328",
            result: "The auditor finished.",
          }),
        ];
        for (const frame of frames) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitTerminal(1);

        const routing = subagentRouting(harness.events, ["toolu-early-bash"]);
        assert.isDefined(routing.childThreadId);
        assert.deepEqual(
          [...(routing.toolThreadIds.get("toolu-early-bash") ?? [])],
          [routing.childThreadId],
        );
        assert.deepEqual(routing.assistantTexts(routing.childThreadId), [
          "Starting early.",
          "Still working.",
          FINAL_REPORT,
        ]);
        assert.deepEqual(routing.assistantTexts(harness.threadId), ["The auditor finished."]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([false, true])(
    "drops an idle start superseded by live completion, later resume %s",
    (resume) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const startTurn = (ordinal: number, continuation = false) =>
            harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: DateTime.makeUnsafe(0),
                attemptId: RunAttemptId.make(`attempt-stale-start-${ordinal}`),
                providerTurnOrdinal: ordinal,
                text: "Continue work.",
                attachments: [],
                ...(continuation
                  ? {
                      messageCreatedBy: "agent" as const,
                      messageCreationSource: "provider" as const,
                    }
                  : {}),
              }),
            );
          const started = (taskId: string, suffix: string) =>
            makeSubagentTaskStartedFrame({
              taskId,
              toolUseId: `toolu-${taskId}`,
              uuid: `00000000-0000-4000-8000-${suffix}`,
            });
          const finished = (taskId: string, suffix: string) =>
            makeSubagentNotificationFrame({
              taskId,
              toolUseId: `toolu-${taskId}`,
              summary: "Finished audit.",
              uuid: `00000000-0000-4000-8000-${suffix}`,
            });
          yield* startTurn(1);
          yield* harness.offerAndWait(started("stale-agent", "000000004001"));
          yield* harness.offerAndWait(started("wake-agent", "000000004002"));
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000004003",
              result: "Agents launched.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          yield* harness.offerAndWait(started("stale-agent", "000000004004"));
          yield* startTurn(2);
          yield* harness.offerAndWait(finished("stale-agent", "000000004005"));
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000004006",
              result: "User turn finished.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          if (resume) yield* harness.offerAndWait(started("stale-agent", "000000004007"));
          yield* harness.offerAndWait(finished("wake-agent", "000000004008"));
          yield* Queue.take(harness.continuationReceipts);
          yield* startTurn(3, true);
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000004009",
              result: "Wake finished.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          const latest = harness.events.findLast(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.nativeTaskRef?.nativeId === "stale-agent",
          );
          assert.equal(latest?.type, "subagent.updated");
          if (latest?.type !== "subagent.updated") return;
          assert.equal(latest.subagent.status, resume ? "running" : "completed");
          assert.equal(latest.subagent.result, resume ? null : "Finished audit.");
          assert.equal(latest.subagent.completedAt === null, resume);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  const makeStopFixture = (options?: Parameters<typeof makeWakeHarnessWithOptions>[0]) =>
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<void>();
      const harness = yield* makeWakeHarnessWithOptions({
        ...options,
        stopTask: (id) =>
          Queue.offer(requests, undefined).pipe(
            Effect.andThen(options?.stopTask?.(id) ?? Effect.void),
          ),
      });
      let sequence = 4500;
      const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
      const startTurn = (continuation = false) =>
        harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: DateTime.makeUnsafe(0),
            attemptId: RunAttemptId.make(`attempt-stop-${continuation ? 2 : 1}`),
            providerTurnOrdinal: continuation ? 2 : 1,
            text: "Run an audit.",
            attachments: [],
            ...(continuation
              ? { messageCreatedBy: "agent" as const, messageCreationSource: "provider" as const }
              : {}),
          }),
        );
      const start = (toolUseId = "toolu-stop-agent") =>
        harness.offerAndWait(
          makeSubagentTaskStartedFrame({
            taskId: "stop-agent",
            toolUseId,
            uuid: uuid(),
          }),
        );
      const notify = (
        status: "completed" | "failed" | "stopped",
        summary = "Native outcome.",
        toolUseId = "toolu-stop-agent",
      ) =>
        harness.offerAndWait(
          claudeSdkFrame({
            ...makeSubagentNotificationFrame({
              taskId: "stop-agent",
              toolUseId,
              summary,
              uuid: uuid(),
            }),
            status,
          }),
        );
      const stop = (requestedAt?: DateTime.Utc) =>
        harness.runtime.stopSubagent!({
          providerThread: harness.providerThread,
          nativeTaskId: "stop-agent",
          ...(requestedAt === undefined ? {} : { requestedAt }),
        });
      const finishParent = () =>
        harness
          .offerAndWait(makeResultFrame({ uuid: uuid(), result: "Launched." }))
          .pipe(Effect.andThen(Queue.take(harness.terminalReceipts)));
      yield* startTurn();
      yield* start();
      yield* Queue.take(harness.subagentReceipts);
      return {
        ...harness,
        start,
        notify,
        stop,
        finishParent,
        replay: () => startTurn(true),
        uuid,
        requests,
      };
    });

  it.effect("retains native confirmation after the synchronous Agent tool result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeStopFixture({
          stopTask: () => Effect.die("Task already completed"),
        });
        yield* fixture.notify("completed");
        const completed = yield* Queue.take(fixture.subagentReceipts);
        yield* fixture.offerAndWait(
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "toolu-stop-agent", content: "Tool result." },
              ],
            },
            parent_tool_use_id: null,
            uuid: fixture.uuid(),
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        assert.equal((yield* Queue.take(fixture.subagentReceipts)).subagent.result, "Tool result.");
        assert.deepEqual(yield* fixture.stop(), {
          status: "completed",
          completedAt: completed.subagent.completedAt!,
          result: "Native outcome.",
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([
    [false, "stopped"],
    [true, "stopped"],
    [false, "completed"],
  ] as const)(
    "stops one native subagent while its sibling keeps running, owner settled %s, outcome %s",
    ([ownerSettled, outcome]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const stopped: string[] = [];
          const stopRequested = yield* Deferred.make<void>();
          let closes = 0;
          const harness = yield* makeWakeHarnessWithOptions({
            stopTask: (taskId) =>
              Effect.sync(() => {
                stopped.push(taskId);
              }).pipe(Effect.andThen(Deferred.succeed(stopRequested, undefined))),
            interrupt: Effect.die("A child stop must not interrupt its owner"),
            close: () =>
              Effect.sync(() => {
                closes++;
              }),
          });
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-native-child-stop"),
              text: "Start two agents.",
              attachments: [],
            }),
          );
          for (const [taskId, toolUseId, uuid] of [
            ["agent-stop", "toolu-stop", "00000000-0000-4000-8000-000000000801"],
            ["agent-keep", "toolu-keep", "00000000-0000-4000-8000-000000000802"],
          ]) {
            yield* harness.offerAndWait(
              makeSubagentTaskStartedFrame({ taskId: taskId!, toolUseId: toolUseId!, uuid: uuid! }),
            );
            yield* Queue.take(harness.subagentReceipts);
          }
          if (ownerSettled) {
            yield* harness.offerAndWait(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000000803",
                result: "Agents are working.",
              }),
            );
            yield* Queue.take(harness.terminalReceipts);
          }
          const stop = harness.runtime.stopSubagent;
          assert.isDefined(stop);
          const stopping = yield* stop!({
            providerThread: harness.providerThread,
            nativeTaskId: "agent-stop",
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(stopRequested);
          assert.deepEqual(stopped, ["agent-stop"]);
          yield* harness.offerAndWait(
            claudeSdkFrame({
              ...makeSubagentNotificationFrame({
                taskId: "agent-stop",
                toolUseId: "toolu-stop",
                summary: "Stopped by user",
                uuid: "00000000-0000-4000-8000-000000000804",
              }),
              status: outcome,
            }),
          );
          if (ownerSettled) {
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("attempt-native-child-stop-wake"),
                text: "Background task stopped.",
                attachments: [],
                providerTurnOrdinal: 2,
                messageCreatedBy: "agent",
                messageCreationSource: "provider",
              }),
            );
          }
          yield* Fiber.join(stopping);
          const stoppedEvent = yield* Queue.take(harness.subagentReceipts);
          assert.equal(
            stoppedEvent.subagent.status,
            outcome === "stopped" ? "cancelled" : "completed",
          );
          const tasks = harness.events.filter((event) => event.type === "subagent.updated");
          assert.equal(
            tasks.findLast((event) => event.subagent.nativeTaskRef?.nativeId === "agent-stop")
              ?.subagent.status,
            outcome === "stopped" ? "cancelled" : "completed",
          );
          assert.equal(
            tasks.findLast((event) => event.subagent.nativeTaskRef?.nativeId === "agent-keep")
              ?.subagent.status,
            "running",
          );
          assert.lengthOf(harness.terminalEvents(), ownerSettled ? 1 : 0);
          yield* stop!({ providerThread: harness.providerThread, nativeTaskId: "agent-stop" });
          assert.deepEqual(stopped, ["agent-stop"]);
          assert.equal(closes, 0);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect.each([
    "requested",
    "observed-before",
    "observed-after",
    "synthetic-after",
    "inherit",
    "unknown",
  ] as const)(
    "records the subagent model from %s without inheriting the parent override",
    (source) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const toolUseId = "toolu-subagent-model";
          const parentModel = "claude-opus-4-6";
          // Claude stamps its error frames as "<synthetic>", regardless of the subagent model.
          const observedModel =
            source === "synthetic-after" ? "<synthetic>" : "claude-haiku-4-5-20251001";
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-subagent-model"),
              text: "Spawn a Haiku subagent.",
              attachments: [],
              modelSelection: { ...CLAUDE_TEST_MODEL_SELECTION, model: parentModel },
            }),
          );
          const observed = claudeSdkFrame({
            type: "assistant",
            parent_tool_use_id: toolUseId,
            message: {
              model: observedModel,
              id: "msg_subagent_model_observed",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "Solving." }],
            },
            uuid: "00000000-0000-4000-8000-000000000206",
            session_id: WAKE_NATIVE_SESSION,
          });
          if (source === "observed-before") yield* Queue.offer(harness.sdkMessages, observed);
          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "assistant",
              parent_tool_use_id: null,
              message: {
                model: parentModel,
                id: "msg_subagent_model_launch",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: toolUseId,
                    name: "Agent",
                    input: {
                      description: "Haiku puzzle",
                      subagent_type: "general-purpose",
                      ...(source === "unknown"
                        ? {}
                        : { model: source === "inherit" ? "inherit" : "haiku" }),
                      prompt: "Solve the puzzle.",
                    },
                  },
                ],
              },
              uuid: "00000000-0000-4000-8000-000000000209",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: "task-subagent-model",
              tool_use_id: toolUseId,
              description: "Haiku puzzle",
              task_type: "local_agent",
              uuid: "00000000-0000-4000-8000-000000000207",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          if (source === "observed-after" || source === "synthetic-after") {
            yield* Queue.offer(harness.sdkMessages, observed);
          }
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000208",
              result: "Spawned the subagent.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          const subagents = harness.events.filter((event) => event.type === "subagent.updated");
          const observedSlug = "claude-haiku-4-5";
          const initialModel =
            source === "observed-before"
              ? observedSlug
              : source === "inherit"
                ? parentModel
                : source === "unknown"
                  ? null
                  : "claude-haiku-5-5";
          assert.equal(subagents[0]?.subagent.model, initialModel);
          assert.equal(
            subagents.at(-1)?.subagent.model,
            source.startsWith("observed") ? observedSlug : initialModel,
          );
          const child = harness.events.find((event) => event.type === "app_thread.created");
          assert.equal(child?.appThread.modelSelection?.model, initialModel ?? parentModel);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("resolves a subagent's model and effort against the instance's custom models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const TUNED_TOOL_USE_ID = "toolu-effort-custom-tuned";
        const SHADOW_TOOL_USE_ID = "toolu-effort-custom-shadow";
        const harness = yield* makeWakeHarnessWithOptions({
          settings: CUSTOM_MODEL_CLAUDE_SETTINGS,
        });
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-subagent-custom-effort"),
            text: "Spawn subagents on custom models.",
            attachments: [],
          }),
        );
        for (const frame of [
          claudeSdkFrame({
            type: "assistant",
            parent_tool_use_id: null,
            message: {
              model: CLAUDE_TEST_MODEL_SELECTION.model,
              id: "msg_custom_effort_launch",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: TUNED_TOOL_USE_ID,
                  name: "Agent",
                  input: {
                    description: "Tuned",
                    subagent_type: "general-purpose",
                    model: "claude-custom-tuned",
                    effort: "brutal",
                    prompt: "Check one thing.",
                  },
                },
                {
                  type: "tool_use",
                  id: SHADOW_TOOL_USE_ID,
                  name: "Agent",
                  input: {
                    description: "Shadow",
                    subagent_type: "general-purpose",
                    model: "opus",
                    prompt: "Check another thing.",
                  },
                },
              ],
            },
            uuid: "00000000-0000-4000-8000-000000000231",
            session_id: WAKE_NATIVE_SESSION,
          }),
          ...[TUNED_TOOL_USE_ID, SHADOW_TOOL_USE_ID].map((id, index) =>
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: `task-${id}`,
              tool_use_id: id,
              description: id,
              task_type: "local_agent",
              uuid: `00000000-0000-4000-8000-00000000023${index + 2}`,
              session_id: WAKE_NATIVE_SESSION,
            }),
          ),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000234",
            result: "Spawned the subagents.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* Queue.take(harness.terminalReceipts);

        const selections = Object.fromEntries(
          harness.events.flatMap((event) =>
            event.type === "subagent.updated"
              ? [[event.subagent.nativeTaskRef?.nativeId, event.subagent.modelSelection] as const]
              : [],
          ),
        );
        const instanceId = CLAUDE_TEST_MODEL_SELECTION.instanceId;
        assert.deepEqual(selections, {
          [`task-${TUNED_TOOL_USE_ID}`]: {
            instanceId,
            model: "claude-custom-tuned",
            options: [{ id: "effort", value: "brutal" }],
          },
          [`task-${SHADOW_TOOL_USE_ID}`]: { instanceId, model: "opus" },
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("gives a nested subagent its own effort, else the one its owner runs at", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const OUTER_TOOL_USE_ID = "toolu-effort-outer";
        const INHERITING_TOOL_USE_ID = "toolu-effort-nested-inheriting";
        const OVERRIDING_TOOL_USE_ID = "toolu-effort-nested-overriding";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const parentSelection = {
          instanceId: CLAUDE_TEST_MODEL_SELECTION.instanceId,
          model: "claude-opus-4-6",
          options: [{ id: "effort", value: "high" }],
        } satisfies ModelSelection;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-subagent-nested-effort"),
            text: "Spawn a subagent that spawns two more.",
            attachments: [],
            modelSelection: parentSelection,
          }),
        );
        const agentCall = (id: string, effort?: string) => ({
          type: "tool_use" as const,
          id,
          name: "Agent",
          input: {
            description: id,
            subagent_type: "general-purpose",
            ...(effort === undefined ? {} : { effort }),
            prompt: "Check one thing.",
          },
        });
        const taskStarted = (id: string, uuid: string) =>
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: `task-${id}`,
            tool_use_id: id,
            description: id,
            task_type: "local_agent",
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          });
        for (const frame of [
          claudeSdkFrame({
            type: "assistant",
            parent_tool_use_id: null,
            message: {
              model: parentSelection.model,
              id: "msg_nested_effort_outer_launch",
              type: "message",
              role: "assistant",
              content: [agentCall(OUTER_TOOL_USE_ID, "low")],
            },
            uuid: "00000000-0000-4000-8000-000000000221",
            session_id: WAKE_NATIVE_SESSION,
          }),
          taskStarted(OUTER_TOOL_USE_ID, "00000000-0000-4000-8000-000000000222"),
          claudeSdkFrame({
            type: "assistant",
            parent_tool_use_id: OUTER_TOOL_USE_ID,
            message: {
              model: parentSelection.model,
              id: "msg_nested_effort_inner_launch",
              type: "message",
              role: "assistant",
              content: [
                agentCall(INHERITING_TOOL_USE_ID),
                agentCall(OVERRIDING_TOOL_USE_ID, "max"),
              ],
            },
            uuid: "00000000-0000-4000-8000-000000000223",
            session_id: WAKE_NATIVE_SESSION,
          }),
          taskStarted(INHERITING_TOOL_USE_ID, "00000000-0000-4000-8000-000000000224"),
          taskStarted(OVERRIDING_TOOL_USE_ID, "00000000-0000-4000-8000-000000000225"),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000226",
            result: "Spawned the subagents.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* Queue.take(harness.terminalReceipts);

        const efforts = new Map(
          harness.events.flatMap((event) =>
            event.type === "subagent.updated"
              ? [
                  [
                    event.subagent.nativeTaskRef?.nativeId,
                    getModelSelectionStringOptionValue(event.subagent.modelSelection, "effort"),
                  ] as const,
                ]
              : [],
          ),
        );
        assert.deepEqual(Object.fromEntries(efforts), {
          [`task-${OUTER_TOOL_USE_ID}`]: "low",
          [`task-${INHERITING_TOOL_USE_ID}`]: "low",
          [`task-${OVERRIDING_TOOL_USE_ID}`]: "max",
        });
        const childEfforts = harness.events.flatMap((event) =>
          event.type === "app_thread.created" && event.appThread.id !== harness.threadId
            ? [getModelSelectionStringOptionValue(event.appThread.modelSelection, "effort")]
            : [],
        );
        assert.deepEqual(childEfforts, ["low", "low", "max"]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("extracts text from direct content-block subagent results", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-direct-content-blocks";
        const SUBAGENT_TOOL_USE_ID = "toolu-direct-content-blocks";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const subagentEvents = () =>
          harness.events.filter(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "subagent.updated" }
            > => event.type === "subagent.updated",
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-direct-content-blocks"),
            text: "Delegate this task.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: SUBAGENT_TASK_ID,
            tool_use_id: SUBAGENT_TOOL_USE_ID,
            description: "Delegated task",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Return the result.",
            uuid: "00000000-0000-4000-8000-000000000206",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* harness.until(() => subagentEvents().length === 1);

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: SUBAGENT_TOOL_USE_ID,
                  content: [
                    { type: "text", text: "First line." },
                    { type: "text", text: "Second line." },
                  ],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000207",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* harness.until(() => subagentEvents().at(-1)?.subagent.status === "completed");

        assert.equal(subagentEvents().at(-1)?.subagent.result, "First line.\nSecond line.");

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000208",
            result: "Delegation completed.",
          }),
        );
        yield* harness.awaitTerminal(1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("releases the idle pin when a post-settle subagent stops without completing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-wake-subagent-stopped";
        const subagentTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: "toolu-wake-subagent-stopped",
          description: "Long-running research task",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Investigate the flaky test.",
          uuid: "00000000-0000-4000-8000-000000000301",
          session_id: WAKE_NATIVE_SESSION,
        });
        const subagentStoppedNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: "toolu-wake-subagent-stopped",
          status: "stopped",
          output_file: "/tmp/task-wake-subagent-stopped.output",
          summary: "Agent was stopped before finishing.",
          uuid: "00000000-0000-4000-8000-000000000302",
          session_id: WAKE_NATIVE_SESSION,
        });

        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const subagentEvents = () =>
          harness.events.filter(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "subagent.updated" }
            > => event.type === "subagent.updated",
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-7a"),
            text: "Spawn a background subagent and stop.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, subagentTaskStarted);
        yield* harness.until(() => subagentEvents().length >= 1);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000303",
            result: "Spawned the subagent in the background.",
          }),
        );
        yield* harness.awaitTerminal(1);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(harness.sdkMessages, subagentStoppedNotification);
        yield* harness.awaitContinuation(1);

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000304",
            result: "The subagent was stopped.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-7b"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(2);

        assert.equal(subagentEvents().at(-1)?.subagent.status, "cancelled");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("re-opens a resumed subagent whose task_started races past settle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-resume-postsettle";
        const SUBAGENT_TOOL_USE_ID = "toolu-resume-postsettle";
        const RESUME_TOOL_USE_ID = "toolu-resume-postsettle-sendmessage";
        const FIRST_SUMMARY = "Answered early.";
        const SECOND_SUMMARY = "RESUME_SETTLE_DONE";
        const subagentTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          description: "Sleep then echo done token",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Run the shell command, then return exactly RESUME_SETTLE_DONE.",
          uuid: "00000000-0000-4000-8000-000000000501",
          session_id: WAKE_NATIVE_SESSION,
        });
        const firstNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          status: "completed",
          output_file: "/tmp/task-resume-postsettle.output",
          summary: FIRST_SUMMARY,
          uuid: "00000000-0000-4000-8000-000000000502",
          session_id: WAKE_NATIVE_SESSION,
        });
        const resumeTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: RESUME_TOOL_USE_ID,
          description: "Sleep then echo done token",
          is_backgrounded: true,
          task_type: "local_agent",
          uuid: "00000000-0000-4000-8000-000000000505",
          session_id: WAKE_NATIVE_SESSION,
        });
        const secondNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: RESUME_TOOL_USE_ID,
          status: "completed",
          output_file: "/tmp/task-resume-postsettle.output",
          summary: SECOND_SUMMARY,
          uuid: "00000000-0000-4000-8000-000000000506",
          session_id: WAKE_NATIVE_SESSION,
        });

        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const subagentEvents = () =>
          harness.events.filter(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "subagent.updated" }
            > => event.type === "subagent.updated",
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-9a"),
            text: "Spawn a background subagent and stop.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, subagentTaskStarted);
        yield* harness.until(() => subagentEvents().length >= 1);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000503",
            result: "Spawned the subagent in the background.",
          }),
        );
        yield* harness.awaitTerminal(1);

        yield* Queue.offer(harness.sdkMessages, firstNotification);
        yield* harness.awaitContinuation(1);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000504",
            result: "The subagent answered early.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-9b"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(2);
        assert.equal(subagentEvents().at(-1)?.subagent.status, "completed");
        assert.equal(subagentEvents().at(-1)?.subagent.result, FIRST_SUMMARY);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_resume_postsettle_sendmessage",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: RESUME_TOOL_USE_ID,
                  name: "SendMessage",
                  input: {
                    to: SUBAGENT_TASK_ID,
                    summary: "Resume the subagent",
                    message: "Continue and return the token.",
                  },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000508",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(harness.sdkMessages, resumeTaskStarted);
        const resumeAck = {
          success: true,
          message: `Resuming agent ${SUBAGENT_TASK_ID.slice(0, 7)}`,
          resumedAgentId: SUBAGENT_TASK_ID,
          pin: { id: SUBAGENT_TASK_ID, name: SUBAGENT_TASK_ID, ref: "42ab31" },
        };
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  tool_use_id: RESUME_TOOL_USE_ID,
                  type: "tool_result",
                  content: [
                    {
                      type: "text",
                      text: encodeJsonString(resumeAck),
                    },
                  ],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000509",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: resumeAck,
          }),
        );
        for (const frame of [
          ...makeSubagentAssistantFrames({
            parentToolUseId: SUBAGENT_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000961",
            text: "RESUMED_WORK",
            bashToolUseId: "toolu-resume-postsettle-bash",
          }),
          makeSubagentToolResultFrame({
            parentToolUseId: SUBAGENT_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000962",
            toolUseId: "toolu-resume-postsettle-bash",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* Queue.offer(harness.sdkMessages, secondNotification);
        yield* harness.awaitContinuation(2);
        assert.equal(harness.continuationRequests[1]?.detail, SECOND_SUMMARY);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000507",
            result: "The subagent finished with RESUME_SETTLE_DONE.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-9c"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 3,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(3);

        const statuses = subagentEvents().map((event) => event.subagent.status);
        const firstCompleted = statuses.indexOf("completed");
        const reopenedIndex = statuses.lastIndexOf("running");
        assert.isAbove(reopenedIndex, firstCompleted);
        assert.isNull(subagentEvents()[reopenedIndex]?.subagent.result);
        assert.equal(subagentEvents()[reopenedIndex]?.subagent.runId, "run-attempt-claude-wake-9c");
        const nodeStatuses = harness.events
          .filter(
            (
              event,
            ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "node.updated" }> =>
              event.type === "node.updated" &&
              event.node.kind === "subagent" &&
              event.node.nativeItemRef?.nativeId === SUBAGENT_TASK_ID,
          )
          .map((event) => event.node.status);
        assert.isAbove(nodeStatuses.lastIndexOf("running"), nodeStatuses.indexOf("completed"));
        const finalSubagent = subagentEvents().at(-1)?.subagent;
        assert.equal(finalSubagent?.status, "completed");
        assert.equal(finalSubagent?.result, SECOND_SUMMARY);
        assert.equal(finalSubagent?.runId, "run-attempt-claude-wake-9c");
        const reopenIndex = harness.events.findIndex(
          (event) =>
            event.type === "subagent.updated" &&
            event.subagent.status === "running" &&
            event.subagent.runId === "run-attempt-claude-wake-9c",
        );
        assert.isAtLeast(reopenIndex, 0);
        const resumedWorkIndexes = harness.events.flatMap((event, index) =>
          event.type === "message.updated" && event.message.text === "RESUMED_WORK" ? [index] : [],
        );
        assert.lengthOf(resumedWorkIndexes, 1);
        assert.isAbove(resumedWorkIndexes[0] ?? -1, reopenIndex);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("resets Waiting roster and wake eligibility when the CLI process is replaced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* makeChangeSignal;
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-process-reset-",
        });
        const processQueues: Array<Queue.Queue<SDKMessage>> = [];
        const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
          [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator,
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => {
                continuationRequests.push(request);
              }).pipe(Effect.andThen(changes.notify)),
          },
          queryRunner: {
            allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
            open: () =>
              Effect.gen(function* () {
                const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                processQueues.push(sdkMessages);
                return {
                  messages: Stream.fromQueue(sdkMessages),
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Queue.shutdown(sdkMessages),
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-process-reset");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-process-reset"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }).pipe(Effect.andThen(changes.notify)),
          ),
          Effect.forkScoped,
        );
        if (runtime.hasPendingBackgroundWork === undefined) {
          return yield* Effect.die("Claude adapter runtime must expose hasPendingBackgroundWork.");
        }
        const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
        const now = yield* DateTime.now;

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-process-reset-a"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        assert.equal(processQueues.length, 1);
        const firstProcess = processQueues[0]!;
        yield* Queue.offer(firstProcess, wakeTaskStarted);
        yield* Queue.offer(
          firstProcess,
          claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [],
            uuid: "00000000-0000-4000-8000-000000000603",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(firstProcess, turnOneResult);
        yield* changes.until(() => events.some((event) => event.type === "turn.terminal"));
        assert.isFalse(yield* hasPendingBackgroundWork);

        const alternateModel = CLAUDE_TEST_RESTART_MODEL_SELECTION;
        const activeProviderThread = {
          ...providerThread,
          status: "active" as const,
        } satisfies OrchestrationV2ProviderThread;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread: activeProviderThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-process-reset-b"),
            text: "Continue after process restart.",
            attachments: [],
            providerTurnOrdinal: 2,
            modelSelection: alternateModel,
          }),
        );
        assert.equal(processQueues.length, 2);

        yield* changes.until(() =>
          providerThreadRosterEvents(events).some(
            (event) =>
              event.providerThread.status === "active" &&
              (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0 &&
              event.providerThread.updatedAt !== undefined,
          ),
        );
        assert.isFalse(yield* hasPendingBackgroundWork);
        const emptyActiveRosterEvents = providerThreadRosterEvents(events).filter(
          (event) =>
            event.providerThread.status === "active" &&
            (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0,
        );
        assert.isAtLeast(emptyActiveRosterEvents.length, 1);
        assert.deepEqual(
          emptyActiveRosterEvents.at(-1)?.providerThread.pendingBackgroundTasks ?? [],
          [],
        );
        assert.equal(emptyActiveRosterEvents.at(-1)?.providerThread.status, "active");

        const secondProcess = processQueues[1]!;
        yield* Queue.offer(secondProcess, wakeNotification);
        yield* yieldTicks(50);
        assert.lengthOf(continuationRequests, 0);

        yield* Queue.offer(
          secondProcess,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000602",
            result: "Process restart turn finished.",
          }),
        );
        yield* changes.until(
          () => events.filter((event) => event.type === "turn.terminal").length === 2,
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect(
    "preserves buffered local_bash notification classification across model/policy query replacement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* makeChangeSignal;
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-buffer-replace-",
          });
          const processQueues: Array<Queue.Queue<SDKMessage>> = [];
          const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
          const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
            [];
          const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
            instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
            settings: DEFAULT_CLAUDE_SETTINGS,
            environment: {},
            attachmentsDir,
            fileSystem,
            path: yield* Path.Path,
            crypto: yield* Crypto.Crypto,
            idAllocator,
            continuationRequests: {
              offer: (request) =>
                Effect.sync(() => {
                  continuationRequests.push(request);
                }).pipe(Effect.andThen(changes.notify)),
            },
            queryRunner: {
              allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
              open: () =>
                Effect.gen(function* () {
                  const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                  processQueues.push(sdkMessages);
                  return {
                    messages: Stream.fromQueue(sdkMessages),
                    offer: () => Effect.void,
                    setModel: () => Effect.void,
                    applyFlagSettings: () => Effect.void,
                    setPermissionMode: () => Effect.void,
                    backgroundTasks: () => Effect.succeed(false),
                    stopTask: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(sdkMessages),
                  };
                }),
              forkSession: () => Effect.die("unused forkSession"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          const threadId = ThreadId.make("thread-claude-buffer-replace");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("provider-session-claude-buffer-replace"),
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          yield* runtime.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
              }).pipe(Effect.andThen(changes.notify)),
            ),
            Effect.forkScoped,
          );
          if (runtime.hasPendingBackgroundWork === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWork.",
            );
          }
          const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
          const now = yield* DateTime.now;

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-buffer-replace-a"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 1);
          const firstProcess = processQueues[0]!;
          yield* Queue.offer(firstProcess, wakeTaskStarted);
          yield* Queue.offer(firstProcess, turnOneResult);
          yield* changes.until(() => events.some((event) => event.type === "turn.terminal"));
          assert.isTrue(yield* hasPendingBackgroundWork);

          yield* Queue.offer(firstProcess, wakeNotification);
          yield* yieldTicks(50);
          assert.lengthOf(continuationRequests, 0);

          const alternateModel = CLAUDE_TEST_RESTART_MODEL_SELECTION;
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-buffer-replace-user"),
              text: "Switch model while background work completes.",
              attachments: [],
              providerTurnOrdinal: 2,
              modelSelection: alternateModel,
            }),
          );
          assert.equal(processQueues.length, 2);
          const secondProcess = processQueues[1]!;
          yield* Queue.offer(
            secondProcess,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000701",
              result: "User turn finished after model switch.",
            }),
          );
          yield* changes.until(
            () => events.filter((event) => event.type === "turn.terminal").length === 2,
          );
          assert.isFalse(yield* hasPendingBackgroundWork);
          assert.lengthOf(continuationRequests, 0);

          yield* Queue.offer(secondProcess, wakeResult);
          yield* changes.until(() => continuationRequests.length === 1);
          assert.equal(continuationRequests[0]?.detail, WAKE_SUMMARY);
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-buffer-replace-cont"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 3,
              modelSelection: alternateModel,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* changes.until(
            () => events.filter((event) => event.type === "turn.terminal").length === 3,
          );
          assert.isTrue(
            events.some(
              (event) =>
                event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
            ),
          );
          assert.isFalse(
            events.some(
              (event) =>
                event.type === "subagent.updated" ||
                (event.type === "node.updated" && event.node.kind === "subagent"),
            ),
          );
          assert.isFalse(
            events.some(
              (event) =>
                event.type !== "provider_thread.updated" &&
                JSON.stringify(event).includes(WAKE_TASK_ID),
            ),
          );
          assert.isFalse(yield* hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("refuses a thinking change that would kill a running background subagent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* makeChangeSignal;
        const SUBAGENT_TASK_ID = "task-model-change-running-subagent";
        const SUBAGENT_TOOL_USE_ID = "toolu-model-change-running-subagent";
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-model-change-running-subagent-",
        });
        const processQueues: Array<Queue.Queue<SDKMessage>> = [];
        const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator,
          continuationRequests: { offer: () => Effect.void },
          queryRunner: {
            allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
            open: () =>
              Effect.gen(function* () {
                const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                processQueues.push(sdkMessages);
                return {
                  messages: Stream.fromQueue(sdkMessages),
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Queue.shutdown(sdkMessages),
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-model-change-running-subagent");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-claude-model-change-running-subagent",
          ),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }).pipe(Effect.andThen(changes.notify)),
          ),
          Effect.forkScoped,
        );
        const terminals = () => events.filter((event) => event.type === "turn.terminal");
        const now = yield* DateTime.now;

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-model-change-running-subagent-a"),
            text: "Spawn a background subagent and stop.",
            attachments: [],
          }),
        );
        const firstProcess = processQueues[0]!;
        yield* Queue.offer(
          firstProcess,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: SUBAGENT_TASK_ID,
            tool_use_id: SUBAGENT_TOOL_USE_ID,
            description: "Background research",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Research, then report.",
            uuid: "00000000-0000-4000-8000-000000000901",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          firstProcess,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000902",
            result: "Spawned the subagent in the background.",
          }),
        );
        yield* changes.until(() => terminals().length === 1);
        const settledTurn = terminals()[0]!;

        assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(providerThread));
        assert.isTrue(
          yield* runtime.hasPendingBackgroundWorkForThread!(providerThread, {
            includeSubagents: true,
          }),
        );
        assert.isFalse(
          yield* runtime.hasPendingBackgroundWorkForThread!(
            {
              ...providerThread,
              nativeThreadRef: {
                ...providerThread.nativeThreadRef!,
                nativeId: "sibling-native-session",
              },
            },
            { includeSubagents: true },
          ),
        );

        const alternateModel = CLAUDE_TEST_RESTART_MODEL_SELECTION;
        const switchTurn = (attempt: string) =>
          runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make(attempt),
              text: "Switch model while the subagent runs.",
              attachments: [],
              providerTurnOrdinal: 2,
              modelSelection: alternateModel,
            }),
          );
        const refused = yield* switchTurn("attempt-claude-model-change-running-subagent-b").pipe(
          Effect.flip,
        );
        assert.equal(
          makeProviderFailure({ cause: refused, class: "provider_error" }).message,
          new ClaudeAdapterV2.ClaudeBackgroundWorkBlocksQueryReplacementError().message,
        );
        assert.lengthOf(processQueues, 1);

        yield* runtime.interruptTurn({
          providerThread,
          providerTurnId: settledTurn.providerTurnId,
          requestRuntimeRestart: true,
        });
        yield* switchTurn("attempt-claude-model-change-running-subagent-c");
        assert.lengthOf(processQueues, 2);

        yield* Queue.offer(
          processQueues[1]!,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000903",
            result: "Switched model.",
          }),
        );
        yield* changes.until(() => terminals().length === 2);
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread: { ...providerThread, status: "active" },
            now,
            attemptId: RunAttemptId.make("attempt-claude-model-change-running-subagent-d"),
            text: "Switch back.",
            attachments: [],
            providerTurnOrdinal: 3,
          }),
        );
        assert.lengthOf(processQueues, 3);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  // regression: #20413 an unreadable append file must not tear down the running process
  it.effect("keeps the live process when its replacement cannot read the append file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-append-replacement-",
        });
        const appendFile = NodePath.join(cwd, "rules.md");
        yield* fileSystem.writeFileString(appendFile, "File sentinel\n");
        const processQueues: Array<Queue.Queue<SDKMessage>> = [];
        let closes = 0;
        const firstTurnTerminal = yield* Deferred.make<void>();
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: {
            ...DEFAULT_CLAUDE_SETTINGS,
            launchArgs: "--append-system-prompt-file rules.md",
          },
          environment: {},
          attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-append-replacement-attachments-",
          }),
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          continuationRequests: { offer: () => Effect.void },
          queryRunner: {
            allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
            open: () =>
              Effect.gen(function* () {
                const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                processQueues.push(sdkMessages);
                return {
                  messages: Stream.fromQueue(sdkMessages),
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.sync(() => {
                    closes += 1;
                  }).pipe(Effect.andThen(Queue.shutdown(sdkMessages))),
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd,
        });
        const threadId = ThreadId.make("thread-claude-append-replacement");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-append-replacement"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            event.type === "turn.terminal"
              ? Deferred.succeed(firstTurnTerminal, undefined)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        const now = yield* DateTime.now;

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-append-replacement-a"),
            text: "What is the sentinel?",
            attachments: [],
            runtimePolicy,
          }),
        );
        yield* Queue.offer(
          processQueues[0]!,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000a01",
            result: "File sentinel",
          }),
        );
        yield* Deferred.await(firstTurnTerminal);

        yield* fileSystem.remove(appendFile);
        // A thinking change cannot apply live, so this turn must replace the process.
        const refused = yield* runtime
          .startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-append-replacement-b"),
              text: "Switch model.",
              attachments: [],
              providerTurnOrdinal: 2,
              modelSelection: CLAUDE_TEST_RESTART_MODEL_SELECTION,
              runtimePolicy,
            }),
          )
          .pipe(Effect.flip);
        assert.equal(
          makeProviderFailure({ cause: refused, class: "provider_error" }).message,
          new ClaudeAdapterV2.ClaudeAppendSystemPromptFileError({ path: appendFile }).message,
        );
        assert.lengthOf(processQueues, 1);
        assert.equal(closes, 0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect(
    "keeps the process and its roster when a model change meets a running background shell",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* makeChangeSignal;
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-replace-open-fail-",
          });
          let openCount = 0;
          const processQueues: Array<Queue.Queue<SDKMessage>> = [];
          const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
          const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
            instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
            settings: DEFAULT_CLAUDE_SETTINGS,
            environment: {},
            attachmentsDir,
            fileSystem,
            path: yield* Path.Path,
            crypto: yield* Crypto.Crypto,
            idAllocator,
            continuationRequests: {
              offer: () => Effect.void,
            },
            queryRunner: {
              allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
              open: () => {
                openCount += 1;
                if (openCount === 2) {
                  return Effect.fail(
                    new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                      method: "open",
                      cause: "forced replacement open failure",
                    }),
                  );
                }
                return Effect.gen(function* () {
                  const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                  processQueues.push(sdkMessages);
                  return {
                    messages: Stream.fromQueue(sdkMessages),
                    offer: () => Effect.void,
                    setModel: () => Effect.void,
                    applyFlagSettings: () => Effect.void,
                    setPermissionMode: () => Effect.void,
                    backgroundTasks: () => Effect.succeed(false),
                    stopTask: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(sdkMessages),
                  };
                });
              },
              forkSession: () => Effect.die("unused forkSession"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          const threadId = ThreadId.make("thread-claude-replace-open-fail");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("provider-session-claude-replace-open-fail"),
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          yield* runtime.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
              }).pipe(Effect.andThen(changes.notify)),
            ),
            Effect.forkScoped,
          );
          if (runtime.hasPendingBackgroundWork === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWork.",
            );
          }
          const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
          const now = yield* DateTime.now;

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-replace-open-fail-a"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 1);
          yield* Queue.offer(processQueues[0]!, wakeTaskStarted);
          yield* Queue.offer(processQueues[0]!, turnOneResult);
          yield* changes.until(() => events.some((event) => event.type === "turn.terminal"));
          assert.isTrue(yield* hasPendingBackgroundWork);

          const alternateModel = CLAUDE_TEST_RESTART_MODEL_SELECTION;
          const failedStart = yield* runtime
            .startTurn(
              makeClaudeTestTurnInput({
                threadId,
                providerThread: { ...providerThread, status: "active" },
                now,
                attemptId: RunAttemptId.make("attempt-claude-replace-open-fail-b"),
                text: "Replace process but fail open.",
                attachments: [],
                providerTurnOrdinal: 2,
                modelSelection: alternateModel,
              }),
            )
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(failedStart));
          assert.equal(openCount, 1);
          assert.isTrue(yield* hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  const WORKFLOW_TASK_ID = "task-workflow-run";
  const WORKFLOW_TOOL_USE_ID = "toolu-workflow-run";
  const makeWorkflowHarnessWithOptions = (
    options?: Parameters<typeof makeWakeHarnessWithOptions>[0],
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-wf-" });
      const transcriptDir = NodePath.join(configDir, "projects", "workflow");
      yield* fileSystem.makeDirectory(transcriptDir, { recursive: true });
      yield* fileSystem.writeFileString(
        NodePath.join(transcriptDir, "agent-a1.jsonl"),
        `{"type":"assistant","uuid":"wf-line-1-${options?.nativeSessionId ?? "default"}","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_a1","content":[{"type":"text","text":"A1 from the transcript"}]}}\n`,
      );
      const harness = yield* makeWakeHarnessWithOptions({
        ...options,
        environment: { ...options?.environment, CLAUDE_CONFIG_DIR: configDir },
      });
      return { ...harness, transcriptDir };
    });
  const makeWorkflowHarness = makeWorkflowHarnessWithOptions();

  const workflowToolUse = claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "tool_use",
          id: WORKFLOW_TOOL_USE_ID,
          name: "Workflow",
          input: { script: "alpha.js" },
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000001001",
    session_id: WAKE_NATIVE_SESSION,
  });
  const workflowTaskStarted = claudeSdkFrame({
    type: "system",
    subtype: "task_started",
    task_id: WORKFLOW_TASK_ID,
    tool_use_id: WORKFLOW_TOOL_USE_ID,
    description: "Run the alpha workflow",
    task_type: "local_workflow",
    workflow_name: "probe-wf",
    uuid: "00000000-0000-4000-8000-000000001002",
    session_id: WAKE_NATIVE_SESSION,
  });
  const workflowLaunchAck = (transcriptDir: string) =>
    claudeSdkFrame({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: WORKFLOW_TOOL_USE_ID,
            content: [{ type: "text", text: "Workflow launched." }],
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: "00000000-0000-4000-8000-000000001003",
      session_id: WAKE_NATIVE_SESSION,
      tool_use_result: {
        taskType: "local_workflow",
        runId: "wf_probe",
        transcriptDir,
      },
    });
  const workflowSnapshot = (input: {
    readonly uuid: string;
    readonly state: "queued" | "start" | "done";
    readonly secondState?: "queued" | "start" | "done";
    readonly startedAt?: number;
    readonly lastProgressAt?: number;
    readonly durationMs?: number;
    readonly label?: string;
    readonly prompt?: string;
    readonly model?: string;
    readonly attempt?: number;
    readonly omitResult?: boolean;
  }) =>
    claudeSdkFrame({
      type: "system",
      subtype: "task_progress",
      task_id: WORKFLOW_TASK_ID,
      tool_use_id: WORKFLOW_TOOL_USE_ID,
      description: "Alpha: alpha:one",
      workflow_progress: [
        { type: "workflow_phase", index: 1, title: "Alpha" },
        {
          type: "workflow_agent",
          index: 1,
          label: input.label ?? "alpha:one",
          agentId: "a1",
          state: input.state,
          phaseIndex: 1,
          phaseTitle: "Alpha",
          model: input.model ?? "claude-opus-5[1m]",
          promptPreview: input.prompt ?? "Reply with exactly: A1",
          ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
          ...(input.lastProgressAt === undefined ? {} : { lastProgressAt: input.lastProgressAt }),
          ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
          ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
          ...(input.state === "done" && input.omitResult !== true
            ? { resultPreview: "A1 excerpt" }
            : {}),
        },
        {
          type: "workflow_agent",
          index: 2,
          label: "alpha:two",
          agentId: "a2",
          state: input.secondState ?? input.state,
          phaseIndex: 1,
          phaseTitle: "Alpha",
          promptPreview: "Reply with exactly: A2",
          ...(input.state === "done" ? { resultPreview: "A2 excerpt" } : {}),
        },
      ],
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const workflowNotification = (input: {
    readonly uuid: string;
    readonly status: "completed" | "failed" | "stopped";
  }) =>
    claudeSdkFrame({
      type: "system",
      subtype: "task_notification",
      task_id: WORKFLOW_TASK_ID,
      tool_use_id: WORKFLOW_TOOL_USE_ID,
      status: input.status,
      summary: "Workflow finished.",
      output_file: "/tmp/workflow.output",
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const workflowCoordinatorEvents = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  ) =>
    events.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }> =>
        event.type === "subagent.updated" &&
        event.subagent.nativeTaskRef?.nativeId === WORKFLOW_TASK_ID,
    );
  const workflowMemberEvents = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
    index: number,
  ) =>
    events.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }> =>
        event.type === "subagent.updated" &&
        event.subagent.nativeTaskRef?.nativeId?.endsWith(`:agent:${index}`) === true,
    );
  const threadMessages = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
    threadId: ThreadId | null | undefined,
  ) =>
    events.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "message.updated" }> =>
        event.type === "message.updated" && event.message.threadId === threadId,
    );

  const launchWorkflow = Effect.fnUntraced(function* (input: {
    readonly harness: Effect.Success<typeof makeWorkflowHarness>;
    readonly snapshotUuid: string;
    readonly state?: "queued" | "start";
  }) {
    yield* input.harness.offerAndWait(workflowToolUse);
    yield* input.harness.offerAndWait(workflowTaskStarted);
    yield* input.harness.offerAndWait(workflowLaunchAck(input.harness.transcriptDir));
    yield* input.harness.offerAndWait(
      workflowSnapshot({ uuid: input.snapshotUuid, state: input.state ?? "start" }),
    );
    yield* input.harness.until(() => workflowMemberEvents(input.harness.events, 2).length === 1);
  });

  it.effect.each(["Agent", "Workflow"] as const)(
    "keeps a workflow running after its %s launch reply without an async flag",
    (toolName) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWorkflowHarness;
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`attempt-workflow-launch-${toolName}`),
              text: "Run the workflow.",
              attachments: [],
            }),
          );
          yield* harness.offerAndWait(
            claudeSdkFrame({
              ...workflowToolUse,
              message: {
                model: "claude-sonnet-4-6",
                content: [
                  { type: "tool_use", id: WORKFLOW_TOOL_USE_ID, name: toolName, input: {} },
                ],
              },
            }),
          );
          yield* harness.offerAndWait(workflowTaskStarted);
          yield* harness.offerAndWait(workflowLaunchAck(harness.transcriptDir));
          yield* harness.offerAndWait(
            workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001200", state: "start" }),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001201", result: "Launched." }),
          );
          yield* Queue.take(harness.terminalReceipts);
          assert.equal(
            workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status,
            "running",
          );
          assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "running");
          assert.isTrue(yield* harness.hasPendingBackgroundWork);
          const toolItems = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.nativeItemRef?.nativeId === WORKFLOW_TOOL_USE_ID
              ? [event.turnItem.status]
              : [],
          );
          assert.deepEqual(toolItems, toolName === "Workflow" ? ["running", "completed"] : []);
          yield* harness.offerAndWait(
            workflowNotification({
              uuid: "00000000-0000-4000-8000-000000001202",
              status: "completed",
            }),
          );
          yield* Queue.take(harness.continuationReceipts);
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`attempt-workflow-complete-${toolName}`),
              text: "Workflow finished.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001205", result: "Finished." }),
          );
          yield* Queue.take(harness.terminalReceipts);
          assert.equal(
            workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status,
            "completed",
          );
          assert.equal(
            workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status,
            "completed",
          );
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("marks a workflow coordinator's script prompt and leaves a subagent brief plain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarness;
        const script =
          'export const meta = { name: "probe-wf", description: "Run the alpha workflow" };';
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-workflow-script-prompt"),
            text: "Run the workflow and an auditor.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(workflowToolUse);
        yield* harness.offerAndWait(claudeSdkFrame({ ...workflowTaskStarted, prompt: script }));
        yield* harness.offerAndWait(workflowLaunchAck(harness.transcriptDir));
        yield* harness.offerAndWait(
          workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001289", state: "start" }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: "task-plain-auditor",
            description: "Audit recent commits",
            task_type: "local_agent",
            prompt: "Audit the last five commits.",
            uuid: "00000000-0000-4000-8000-000000001290",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const subagentPrompt = (nativeTaskId: string) => {
          const subagent = harness.events.flatMap((event) =>
            event.type === "subagent.updated" &&
            event.subagent.nativeTaskRef?.nativeId === nativeTaskId
              ? [event.subagent]
              : [],
          )[0];
          const message = threadMessages(harness.events, subagent?.childThreadId).find(
            (event) => event.message.role === "user",
          )?.message;
          const turnItem = harness.events.findLast(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "user_message" &&
              event.turnItem.messageId === message?.id,
          );
          return {
            text: message?.text,
            messageMark: message?.workflowScript,
            itemMark:
              turnItem?.type === "turn_item.updated" && turnItem.turnItem.type === "user_message"
                ? turnItem.turnItem.workflowScript
                : undefined,
          };
        };
        // The user message item lands after the subagent node, so wait on the item itself.
        yield* harness.until(
          () =>
            workflowCoordinatorEvents(harness.events).length > 0 &&
            subagentPrompt(WORKFLOW_TASK_ID).itemMark !== undefined &&
            subagentPrompt("task-plain-auditor").itemMark !== undefined,
        );
        assert.deepEqual(subagentPrompt(WORKFLOW_TASK_ID), {
          text: script,
          messageMark: true,
          itemMark: true,
        });
        assert.deepEqual(subagentPrompt("task-plain-auditor"), {
          text: "Audit the last five commits.",
          messageMark: false,
          itemMark: false,
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("stops only a live workflow task and waits for its stopped notification", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stoppedTasks: Array<string> = [];
        let interrupted = false;
        let closed = false;
        const harness = yield* makeWorkflowHarnessWithOptions({
          stopTask: (taskId) =>
            Effect.sync(() => {
              stoppedTasks.push(taskId);
            }),
          interrupt: Effect.sync(() => {
            interrupted = true;
          }),
          close: () =>
            Effect.sync(() => {
              closed = true;
            }),
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-workflow-stop"),
            text: "Run the workflow.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(workflowToolUse);
        yield* harness.offerAndWait(workflowTaskStarted);
        yield* harness.offerAndWait(workflowLaunchAck(harness.transcriptDir));
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001100",
            state: "start",
          }),
        );
        let member = yield* Queue.take(harness.subagentReceipts);
        while (!member.subagent.nativeTaskRef?.nativeId?.endsWith(":agent:2")) {
          member = yield* Queue.take(harness.subagentReceipts);
        }
        const stopTask = harness.runtime.stopTask!;
        for (const taskId of ["missing-task", `${WORKFLOW_TASK_ID}:agent:1`]) {
          const exit = yield* stopTask({ providerThread: harness.providerThread, taskId }).pipe(
            Effect.exit,
          );
          assert.isTrue(Exit.isFailure(exit));
        }
        const wrongThread = {
          ...harness.providerThread,
          nativeThreadRef: {
            driver: harness.providerThread.driver,
            nativeId: "wrong-session",
            strength: "strong" as const,
          },
        };
        assert.isTrue(
          Exit.isFailure(
            yield* stopTask({
              providerThread: wrongThread,
              taskId: WORKFLOW_TASK_ID,
            }).pipe(Effect.exit),
          ),
        );
        assert.deepEqual(stoppedTasks, []);
        yield* stopTask({ providerThread: harness.providerThread, taskId: WORKFLOW_TASK_ID });
        assert.deepEqual(stoppedTasks, [WORKFLOW_TASK_ID]);
        assert.isFalse(interrupted);
        assert.isFalse(closed);
        assert.equal(workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status, "running");
        yield* harness.offerAndWait(
          workflowNotification({
            uuid: "00000000-0000-4000-8000-000000001101",
            status: "stopped",
          }),
        );
        member = yield* Queue.take(harness.subagentReceipts);
        while (!member.subagent.nativeTaskRef?.nativeId?.endsWith(":agent:2")) {
          member = yield* Queue.take(harness.subagentReceipts);
        }
        assert.equal(
          workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status,
          "cancelled",
        );
        for (const index of [1, 2]) {
          assert.equal(
            workflowMemberEvents(harness.events, index).at(-1)?.subagent.status,
            "cancelled",
          );
        }
        assert.isTrue(
          Exit.isFailure(
            yield* stopTask({
              providerThread: harness.providerThread,
              taskId: WORKFLOW_TASK_ID,
            }).pipe(Effect.exit),
          ),
        );
        assert.deepEqual(stoppedTasks, [WORKFLOW_TASK_ID]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("projects each workflow member as its own subagent thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarness;
        const now = yield* DateTime.now;
        const coordinatorTurnItems = () =>
          harness.events.filter(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "subagent" &&
              event.turnItem.nativeItemRef?.nativeId === WORKFLOW_TASK_ID,
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-members"),
            text: "Run the alpha workflow.",
            attachments: [],
          }),
        );
        yield* launchWorkflow({
          harness,
          snapshotUuid: "00000000-0000-4000-8000-000000001004",
          state: "queued",
        });

        const coordinator = workflowCoordinatorEvents(harness.events).at(-1)?.subagent;
        const first = workflowMemberEvents(harness.events, 1).at(-1)?.subagent;
        const second = workflowMemberEvents(harness.events, 2).at(-1)?.subagent;
        assert.equal(first?.status, "pending");
        assert.isNull(first?.startedAt);
        assert.equal(second?.status, "pending");
        assert.isNull(second?.startedAt);
        const coordinatorThread = harness.events.find(
          (event) =>
            event.type === "app_thread.created" &&
            event.appThread.id === coordinator?.childThreadId,
        );
        assert.equal(
          coordinatorThread?.type === "app_thread.created"
            ? coordinatorThread.appThread.title
            : null,
          "Workflow · probe-wf",
        );
        assert.equal(first?.title, "alpha:one");
        assert.equal(first?.prompt, "Reply with exactly: A1");
        assert.equal(first?.model, "claude-opus-5[1m]");
        assert.equal(first?.threadId, coordinator?.childThreadId);
        assert.equal(second?.threadId, coordinator?.childThreadId);
        assert.notEqual(first?.childThreadId, second?.childThreadId);

        assert.equal(
          harness.events.find(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "app_thread.created" }
            > => event.type === "app_thread.created" && event.appThread.id === first?.childThreadId,
          )?.appThread.title,
          "alpha:one",
        );
        const memberNodes = harness.events.filter(
          (
            event,
          ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "node.updated" }> =>
            event.type === "node.updated" &&
            event.node.nativeItemRef?.nativeId === first?.nativeTaskRef?.nativeId,
        );
        assert.deepEqual(
          memberNodes.map((event) => event.node.kind),
          ["subagent", "root_turn"],
        );
        assert.deepEqual(
          memberNodes.map((event) => [event.node.status, event.node.startedAt]),
          [
            ["pending", null],
            ["pending", null],
          ],
        );
        assert.deepEqual(
          threadMessages(harness.events, first?.childThreadId).map((event) => event.message.text),
          ["Reply with exactly: A1"],
        );
        assert.deepEqual(
          threadMessages(harness.events, second?.childThreadId).map((event) => event.message.text),
          ["Reply with exactly: A2"],
        );

        yield* TestClock.adjust("60 seconds");
        const memberStartedAt = DateTime.add(now, { seconds: 30 });
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001007",
            state: "start",
            secondState: "queued",
            startedAt: DateTime.toEpochMillis(memberStartedAt),
          }),
        );
        let started = yield* Queue.take(harness.subagentReceipts);
        while (started.subagent.id !== first?.id || started.subagent.status !== "running") {
          started = yield* Queue.take(harness.subagentReceipts);
        }
        assert.deepEqual(started.subagent.startedAt, memberStartedAt);
        const startedRoot = harness.events.findLast(
          (event) => event.type === "node.updated" && event.node.threadId === first?.childThreadId,
        );
        assert.equal(
          startedRoot?.type === "node.updated" ? startedRoot.node.status : null,
          "running",
        );
        assert.deepEqual(
          startedRoot?.type === "node.updated" ? startedRoot.node.startedAt : null,
          memberStartedAt,
        );

        const turnItemsBeforeRepeat = coordinatorTurnItems().length;
        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001005",
            state: "start",
            secondState: "queued",
          }),
        );
        yield* harness.until(() => coordinatorTurnItems().length > turnItemsBeforeRepeat);
        assert.lengthOf(workflowMemberEvents(harness.events, 1), 2);
        assert.lengthOf(workflowMemberEvents(harness.events, 2), 1);

        const firstThreadId = first?.childThreadId;
        const firstThreadEvents = () =>
          harness.events.filter(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "app_thread.created" }
            > => event.type === "app_thread.created" && event.appThread.id === firstThreadId,
          );
        const turnItemsBeforeMetadata = coordinatorTurnItems().length;
        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001017",
            state: "start",
            secondState: "queued",
            label: "alpha:review",
            prompt: "Review the change",
            model: "claude-sonnet-4-6",
          }),
        );
        // The member's node and app thread pick up the metadata after the coordinator item.
        yield* harness.until(
          () =>
            coordinatorTurnItems().length > turnItemsBeforeMetadata &&
            workflowMemberEvents(harness.events, 1).at(-1)?.subagent.title === "alpha:review" &&
            firstThreadEvents().at(-1)?.appThread.title === "alpha:review",
        );
        assert.equal(
          workflowMemberEvents(harness.events, 1).at(-1)?.subagent.title,
          "alpha:review",
        );
        assert.equal(
          workflowMemberEvents(harness.events, 1).at(-1)?.subagent.prompt,
          "Review the change",
        );
        assert.equal(
          workflowMemberEvents(harness.events, 1).at(-1)?.subagent.model,
          "claude-sonnet-4-6",
        );
        assert.equal(firstThreadEvents().at(-1)?.appThread.title, "alpha:review");
        assert.equal(
          firstThreadEvents().at(-1)?.appThread.modelSelection.model,
          "claude-sonnet-4-6",
        );
        assert.deepEqual(
          firstThreadEvents().at(-1)?.appThread.createdAt,
          firstThreadEvents()[0]?.appThread.createdAt,
        );
        assert.equal(
          threadMessages(harness.events, firstThreadId).at(-1)?.message.text,
          "Review the change",
        );

        yield* TestClock.adjust("10 seconds");
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001018",
            state: "done",
            secondState: "queued",
            omitResult: true,
          }),
        );
        let finished = yield* Queue.take(harness.subagentReceipts);
        while (finished.subagent.id !== first?.id || finished.subagent.status !== "completed") {
          finished = yield* Queue.take(harness.subagentReceipts);
        }
        const completedAt = finished.subagent.completedAt;
        assert.deepEqual(completedAt, DateTime.add(now, { seconds: 70 }));
        yield* TestClock.adjust("60 seconds");
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001019",
            state: "done",
            secondState: "queued",
          }),
        );
        let excerpt = yield* Queue.take(harness.subagentReceipts);
        while (excerpt.subagent.id !== first?.id || excerpt.subagent.result !== "A1 excerpt") {
          excerpt = yield* Queue.take(harness.subagentReceipts);
        }
        assert.deepEqual(excerpt.subagent.completedAt, completedAt);
        const finishedRoot = harness.events.findLast(
          (event) => event.type === "node.updated" && event.node.threadId === firstThreadId,
        );
        assert.deepEqual(
          finishedRoot?.type === "node.updated" ? finishedRoot.node.completedAt : undefined,
          completedAt,
        );

        yield* harness.offerAndWait(
          workflowNotification({ uuid: "00000000-0000-4000-8000-000000001008", status: "stopped" }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000001006",
            result: "Launched the workflow.",
          }),
        );
        yield* Queue.take(harness.terminalReceipts);
        const stopped = workflowMemberEvents(harness.events, 2).at(-1)?.subagent;
        assert.equal(stopped?.status, "cancelled");
        assert.isNull(stopped?.startedAt);
        const stoppedRoot = harness.events.findLast(
          (event) => event.type === "node.updated" && event.node.threadId === second?.childThreadId,
        );
        assert.equal(
          stoppedRoot?.type === "node.updated" ? stoppedRoot.node.status : null,
          "cancelled",
        );
        assert.isNull(
          stoppedRoot?.type === "node.updated" ? stoppedRoot.node.startedAt : undefined,
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("projects workflow member threads after resuming a restarted session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarnessWithOptions({
          subagentLaunchToolUseId: WORKFLOW_TOOL_USE_ID,
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-resume"),
            text: "Continue the workflow.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...workflowToolUse,
            message: {
              model: "claude-sonnet-4-6",
              content: [
                { type: "tool_use", id: "toolu-resume-workflow", name: "SendMessage", input: {} },
              ],
            },
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...workflowTaskStarted,
            tool_use_id: "toolu-resume-workflow",
            prompt: "Continue the workflow.",
          }),
        );
        yield* harness.offerAndWait(workflowLaunchAck(harness.transcriptDir));
        yield* harness.offerAndWait(
          workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001040", state: "start" }),
        );
        yield* harness.offerAndWait(
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001041", result: "Resumed." }),
        );
        yield* Queue.take(harness.terminalReceipts);
        const member = workflowMemberEvents(harness.events, 1).at(-1)?.subagent;
        const coordinator = workflowCoordinatorEvents(harness.events).at(-1)?.subagent;
        assert.isDefined(member);
        assert.equal(member?.status, "running");
        assert.isTrue(
          harness.events.some(
            (event) =>
              event.type === "app_thread.created" && event.appThread.id === member?.childThreadId,
          ),
        );
        assert.deepEqual(
          threadMessages(harness.events, member?.childThreadId).map((event) => event.message.text),
          ["Reply with exactly: A1", "A1 from the transcript"],
        );
        assert.isDefined(coordinator?.childThreadId);
        const recoveredThreads = harness.events.filter(
          (event) =>
            event.type === "app_thread.created" &&
            event.appThread.id === coordinator?.childThreadId,
        );
        assert.lengthOf(recoveredThreads, 1);
        const recovered = recoveredThreads[0];
        assert.equal(recovered?.type, "app_thread.created");
        if (recovered?.type !== "app_thread.created") throw new Error("Expected recovered thread");
        assert.isTrue(recovered.createOnly);
        assert.deepEqual(recovered.appThread.lineage, {
          parentThreadId: harness.threadId,
          relationshipToParent: "subagent",
          rootThreadId: harness.threadId,
        });
        assert.equal(recovered.appThread.createdBy, "agent");
        assert.equal(recovered.appThread.creationSource, "provider");
        assert.isBelow(
          harness.events.indexOf(recovered),
          harness.events.findIndex(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.childThreadId === coordinator?.childThreadId,
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([
    "root result",
    "resume after root result",
    "completion before buffered start",
  ] as const)("orders %s arriving during workflow transcript replay", (arrival) =>
    Effect.scoped(
      Effect.gen(function* () {
        const digestStarted = yield* Deferred.make<void>();
        const releaseDigest = yield* Deferred.make<void>();
        const liveFrameOffered = yield* Deferred.make<void>();
        let pauseDigest = false;
        yield* Effect.gen(function* () {
          const harness = yield* makeWorkflowHarnessWithOptions({ close: Queue.shutdown });
          const taskId = "task-resumed-during-workflow-replay";
          const taskStart = (toolUseId: string, prompt: string, uuid: string) =>
            claudeSdkFrame({
              ...workflowTaskStarted,
              task_id: taskId,
              task_type: "local_agent",
              is_backgrounded: true,
              subagent_type: "general-purpose",
              spawn_depth: 1,
              workflow_name: undefined,
              tool_use_id: toolUseId,
              prompt,
              uuid,
            });
          const taskFinished = (toolUseId: string, summary: string, uuid: string) =>
            claudeSdkFrame({
              ...workflowNotification({ uuid, status: "completed" }),
              task_id: taskId,
              tool_use_id: toolUseId,
              summary,
            });
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-workflow-replay-launch"),
              text: "Run the workflow and a background subagent.",
              attachments: [],
            }),
          );
          yield* harness.offerAndWait(workflowToolUse);
          yield* harness.offerAndWait(workflowTaskStarted);
          yield* harness.offerAndWait(workflowLaunchAck(harness.transcriptDir));
          yield* harness.offerAndWait(
            workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000003001", state: "start" }),
          );
          if (arrival !== "completion before buffered start") {
            yield* harness.offerAndWait(
              taskStart("toolu-initial", "Initial work.", "00000000-0000-4000-8000-000000003002"),
            );
          }
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000003003",
              result: "Launched both tasks.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          yield* harness.offerAndWait(
            workflowNotification({
              uuid: "00000000-0000-4000-8000-000000003004",
              status: "completed",
            }),
          );
          yield* Queue.take(harness.continuationReceipts);
          if (arrival === "completion before buffered start") {
            yield* harness.offerAndWait(
              taskStart("toolu-initial", "Initial work.", "00000000-0000-4000-8000-000000003005"),
            );
          } else {
            yield* harness.offerAndWait(
              taskFinished(
                "toolu-initial",
                "Initial result.",
                "00000000-0000-4000-8000-000000003005",
              ),
            );
          }
          if (arrival === "root result") {
            yield* harness.offerAndWait(
              claudeSdkFrame({
                type: "system",
                subtype: "init",
                session_id: WAKE_NATIVE_SESSION,
                uuid: "00000000-0000-4000-8000-000000003006",
              }),
            );
          }
          pauseDigest = true;
          const replay = yield* harness.runtime
            .startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("attempt-workflow-replay-continuation"),
                providerTurnOrdinal: 2,
                text: "Continue.",
                attachments: [],
                messageCreatedBy: "agent",
                messageCreationSource: "provider",
              }),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(digestStarted);
          const liveFrames = yield* Effect.gen(function* () {
            if (arrival === "completion before buffered start") {
              yield* harness.offerAndWait(
                taskFinished(
                  "toolu-initial",
                  "Initial result.",
                  "00000000-0000-4000-8000-000000003007",
                ),
                liveFrameOffered,
              );
              return;
            }
            yield* harness.offerAndWait(
              claudeSdkFrame({
                ...makeResultFrame({
                  uuid: "00000000-0000-4000-8000-000000003008",
                  result: "Native wake turn finished.",
                }),
                origin: { kind: "task-notification" },
                num_turns: 1,
              }),
              liveFrameOffered,
            );
            if (arrival === "resume after root result") {
              yield* harness.offerAndWait(
                claudeSdkFrame({
                  type: "system",
                  subtype: "init",
                  session_id: WAKE_NATIVE_SESSION,
                  uuid: "00000000-0000-4000-8000-000000003009",
                }),
              );
              yield* harness.offerAndWait(
                taskStart(
                  "toolu-latest",
                  "Latest live resume.",
                  "00000000-0000-4000-8000-000000003010",
                ),
              );
            }
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(liveFrameOffered);
          yield* Deferred.succeed(releaseDigest, undefined);
          yield* Fiber.join(replay);
          yield* Fiber.join(liveFrames);
          if (arrival === "resume after root result") {
            yield* Queue.take(harness.terminalReceipts);
            yield* Queue.take(harness.continuationReceipts);
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("attempt-workflow-replay-resume-continuation"),
                providerTurnOrdinal: 3,
                text: "Continue.",
                attachments: [],
                messageCreatedBy: "agent",
                messageCreationSource: "provider",
              }),
            );
          }
          if (arrival !== "root result") {
            yield* harness.offerAndWait(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000003011",
                result: "Workflow answer delivered.",
              }),
            );
          }
          yield* Queue.take(harness.terminalReceipts);
          const latest = harness.events
            .flatMap((event) =>
              event.type === "subagent.updated" && event.subagent.nativeTaskRef?.nativeId === taskId
                ? [event.subagent]
                : [],
            )
            .at(-1);
          if (arrival === "resume after root result") {
            assert.equal(latest?.status, "running");
            assert.equal(latest?.prompt, "Latest live resume.");
            assert.isNull(latest?.result);
            assert.isTrue(yield* harness.hasPendingBackgroundWork);
          } else {
            assert.equal(latest?.status, "completed");
            assert.equal(latest?.result, "Initial result.");
            assert.isFalse(yield* harness.hasPendingBackgroundWork);
            assert.lengthOf(harness.continuationRequests, 1);
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("attempt-workflow-replay-next-user"),
                providerTurnOrdinal: 3,
                text: "Next task.",
                attachments: [],
              }),
            );
          }
        }).pipe(
          Effect.provideService(WorkflowAgentTranscriptReadObserver, () =>
            Effect.gen(function* () {
              if (pauseDigest) {
                pauseDigest = false;
                yield* Deferred.succeed(digestStarted, undefined);
                yield* Deferred.await(releaseDigest);
              }
            }),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("preserves buffered workflow outcomes when interrupted during replay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const digestStarted = yield* Deferred.make<void>();
        const releaseDigest = yield* Deferred.make<void>();
        let pauseDigest = false;
        yield* Effect.gen(function* () {
          const harness = yield* makeWorkflowHarnessWithOptions({ close: Queue.shutdown });
          const secondTaskId = "task-workflow-buffered-completion";
          const secondToolUseId = "toolu-workflow-buffered-completion";
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-workflow-buffered-launch"),
              text: "Run both workflows.",
              attachments: [],
            }),
          );
          yield* launchWorkflow({
            harness,
            snapshotUuid: "00000000-0000-4000-8000-000000003100",
          });
          yield* harness.offerAndWait(
            claudeSdkFrame({
              ...workflowTaskStarted,
              task_id: secondTaskId,
              tool_use_id: secondToolUseId,
              uuid: "00000000-0000-4000-8000-000000003101",
            }),
          );
          yield* harness.offerAndWait(
            claudeSdkFrame({
              ...workflowSnapshot({
                uuid: "00000000-0000-4000-8000-000000003102",
                state: "start",
              }),
              task_id: secondTaskId,
              tool_use_id: secondToolUseId,
            }),
          );
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000003103",
              result: "Launched both workflows.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          yield* harness.offerAndWait(
            workflowNotification({
              uuid: "00000000-0000-4000-8000-000000003104",
              status: "completed",
            }),
          );
          yield* Queue.take(harness.continuationReceipts);
          yield* harness.offerAndWait(
            claudeSdkFrame({
              ...workflowNotification({
                uuid: "00000000-0000-4000-8000-000000003105",
                status: "completed",
              }),
              task_id: secondTaskId,
              tool_use_id: secondToolUseId,
            }),
          );
          const continuationInput = makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-workflow-buffered-replay"),
            providerTurnOrdinal: 2,
            text: "Continue.",
            attachments: [],
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          });
          pauseDigest = true;
          const replay = yield* harness.runtime
            .startTurn(continuationInput)
            .pipe(Effect.forkScoped);
          yield* Deferred.await(digestStarted);
          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeTurnId: `turn:${continuationInput.attemptId}`,
            }),
          });
          yield* Deferred.succeed(releaseDigest, undefined);
          yield* Fiber.join(replay);
          const second = harness.events
            .flatMap((event) =>
              event.type === "subagent.updated" &&
              event.subagent.nativeTaskRef?.nativeId === secondTaskId
                ? [event.subagent]
                : [],
            )
            .at(-1);
          assert.equal(second?.status, "completed");
          assert.equal(second?.result, "Workflow finished.");
        }).pipe(
          Effect.provideService(WorkflowAgentTranscriptReadObserver, () =>
            Effect.gen(function* () {
              if (pauseDigest) {
                pauseDigest = false;
                yield* Deferred.succeed(digestStarted, undefined);
                yield* Deferred.await(releaseDigest);
              }
            }),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([
    ["api_error", false, false],
    ["aborted_streaming", false, false],
    ["api_error", true, false],
    ["api_error", false, true],
    ["aborted_streaming", false, true],
  ] as const)(
    "stops the run's live workflow after root result %s, continuation=%s, pending Stop=%s",
    ([terminalReason, continuation, pendingStop]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const stoppedTasks: Array<string> = [];
          const stopRequested = yield* Deferred.make<void>();
          const harness = yield* makeWorkflowHarnessWithOptions({
            stopTask: (taskId) =>
              Effect.sync(() => void stoppedTasks.push(taskId)).pipe(
                Effect.andThen(Deferred.succeed(stopRequested, undefined)),
                Effect.asVoid,
              ),
          });
          const now = yield* DateTime.now;
          const turnInput = {
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-root-failure"),
            text: "Run the workflow.",
            attachments: [],
          };
          yield* harness.runtime.startTurn(makeClaudeTestTurnInput(turnInput));
          yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001050" });
          const stopping = pendingStop
            ? yield* harness.runtime.stopSubagent!({
                providerThread: harness.providerThread,
                nativeTaskId: WORKFLOW_TASK_ID,
              }).pipe(Effect.exit, Effect.forkScoped)
            : undefined;
          if (pendingStop) yield* Deferred.await(stopRequested);
          if (continuation) {
            yield* harness.offerAndWait(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000001051",
                result: "Launched.",
              }),
            );
            yield* Queue.take(harness.terminalReceipts);
            yield* harness.offerAndWait(
              claudeSdkFrame({
                ...workflowTaskStarted,
                uuid: "00000000-0000-4000-8000-000000001052",
              }),
            );
          }
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000001053",
              result: "Root turn ended.",
              terminalReason,
              isError: terminalReason === "api_error",
            }),
          );
          if (continuation) {
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                ...turnInput,
                attemptId: RunAttemptId.make("attempt-claude-workflow-root-failure-wake"),
                providerTurnOrdinal: 2,
                messageCreatedBy: "agent",
                messageCreationSource: "provider",
              }),
            );
          }
          const terminal = yield* Queue.take(harness.terminalReceipts);
          assert.equal(terminal.status, terminalReason === "api_error" ? "failed" : "interrupted");
          assert.equal(terminal.threadDisposition, "reusable");
          const settled = terminalReason === "api_error" ? "failed" : "cancelled";
          assert.deepEqual(
            stoppedTasks,
            pendingStop ? [WORKFLOW_TASK_ID, WORKFLOW_TASK_ID] : [WORKFLOW_TASK_ID],
          );
          if (stopping !== undefined) {
            yield* TestClock.adjust("2 seconds");
            assert.isTrue(Exit.isFailure(yield* Fiber.join(stopping)));
            const retry = yield* harness.runtime.stopSubagent!({
              providerThread: harness.providerThread,
              nativeTaskId: WORKFLOW_TASK_ID,
            }).pipe(Effect.exit, Effect.forkScoped);
            yield* TestClock.adjust("2 seconds");
            assert.isTrue(Exit.isFailure(yield* Fiber.join(retry)));
          }
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
          assert.equal(workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status, settled);
          for (const index of [1, 2]) {
            assert.equal(
              workflowMemberEvents(harness.events, index).at(-1)?.subagent.status,
              settled,
            );
          }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("answers settled workflow members from a transcript, or the snapshot excerpt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-settled"),
            text: "Run the alpha workflow in the background.",
            attachments: [],
          }),
        );
        yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001007" });
        const firstThreadId = workflowMemberEvents(harness.events, 1)[0]?.subagent.childThreadId;
        const secondThreadId = workflowMemberEvents(harness.events, 2)[0]?.subagent.childThreadId;
        const currentAssistantAnswers = () => [
          ...new Map(
            threadMessages(harness.events, firstThreadId)
              .filter((event) => event.message.role === "assistant")
              .map((event) => [event.message.id, event.message.text]),
          ).values(),
        ];
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000001008",
            result: "Launched the workflow.",
          }),
        );
        yield* Queue.take(harness.terminalReceipts);
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-unrelated-failure"),
            text: "Do another task.",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000001014",
            result: "Another task failed.",
            terminalReason: "api_error",
            isError: true,
          }),
        );
        yield* Queue.take(harness.terminalReceipts);
        assert.equal(workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status, "running");
        assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "running");

        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001009", state: "done" }),
        );
        yield* harness.until(() => threadMessages(harness.events, secondThreadId).length === 2);

        const coordinator = workflowCoordinatorEvents(harness.events).at(-1)?.subagent;
        assert.deepEqual(
          coordinator?.workflow?.agents.map((member) => member.state),
          ["completed", "completed"],
        );
        assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "completed");
        assert.equal(workflowMemberEvents(harness.events, 2).at(-1)?.subagent.status, "completed");
        assert.deepEqual(
          workflowMemberEvents(harness.events, 1).at(-1)?.subagent.completedAt,
          yield* DateTime.now,
        );
        assert.deepEqual(
          threadMessages(harness.events, firstThreadId).map((event) => event.message.text),
          ["Reply with exactly: A1", "A1 from the transcript"],
        );
        assert.deepEqual(
          threadMessages(harness.events, secondThreadId).map((event) => event.message.text),
          ["Reply with exactly: A2", "Partial answer from workflow progress:\n\nA2 excerpt"],
        );
        const coordinatorEventsBeforeRepeat = workflowCoordinatorEvents(harness.events).length;
        const memberEventsBeforeRepeat = workflowMemberEvents(harness.events, 2).length;
        NodeFS.appendFileSync(
          NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
          '{"type":"assistant","uuid":"wf-line-4","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_a1","content":[{"type":"text","text":"A1 continued"}]}}\n',
        );
        yield* harness.offerAndWait(
          workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001015", state: "done" }),
        );
        yield* harness.until(
          () => workflowCoordinatorEvents(harness.events).length > coordinatorEventsBeforeRepeat,
        );
        yield* harness.until(
          () =>
            threadMessages(harness.events, firstThreadId).at(-1)?.message.text === "A1 continued",
        );
        assert.lengthOf(workflowMemberEvents(harness.events, 2), memberEventsBeforeRepeat);
        assert.lengthOf(threadMessages(harness.events, secondThreadId), 2);
        assert.deepEqual(currentAssistantAnswers(), ["A1 from the transcript", "A1 continued"]);
        NodeFS.writeFileSync(
          NodePath.join(harness.transcriptDir, "agent-a2.jsonl"),
          '{"type":"assistant","uuid":"wf-line-5","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_a2","content":[{"type":"text","text":"A2 from the transcript"}]}}\n',
        );
        yield* harness.offerAndWait(
          workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001016", state: "done" }),
        );
        yield* harness.until(() => threadMessages(harness.events, secondThreadId).length === 3);
        assert.lengthOf(workflowMemberEvents(harness.events, 2), memberEventsBeforeRepeat);
        assert.equal(
          threadMessages(harness.events, secondThreadId).at(-1)?.message.text,
          "A2 from the transcript",
        );
        const previousStartedAt = workflowMemberEvents(harness.events, 1).at(-1)?.subagent
          .startedAt;
        yield* TestClock.adjust(1_000);
        NodeFS.writeFileSync(
          NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
          [
            '{"type":"assistant","uuid":"wf-line-6","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_first","content":[{"type":"text","text":"First answer"}]}}',
            '{"type":"assistant","uuid":"wf-line-7","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_second","content":[{"type":"text","text":"Second answer"}]}}',
          ].join("\n") + "\n",
        );
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001018",
            state: "done",
            attempt: 2,
            startedAt: 1000,
            durationMs: 500,
            lastProgressAt: 4432,
          }),
        );
        yield* harness.until(() =>
          currentAssistantAnswers().join("\n\n").includes("Second answer"),
        );
        assert.deepEqual(currentAssistantAnswers().slice(-2), ["First answer", "Second answer"]);
        const completedMember = workflowMemberEvents(harness.events, 1).at(-1)?.subagent;
        assert.equal(
          completedMember?.completedAt && DateTime.toEpochMillis(completedMember.completedAt),
          4432,
        );
        assert.notDeepEqual(
          workflowMemberEvents(harness.events, 1).at(-1)?.subagent.startedAt,
          previousStartedAt,
        );
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001019",
            state: "start",
            attempt: 3,
          }),
        );
        assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "running");
        assert.isNull(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.completedAt);
        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001020",
            state: "start",
            attempt: 3,
          }),
        );
        NodeFS.writeFileSync(
          NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
          '{"type":"assistant","uuid":"wf-line-8","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_retry","content":[{"type":"text","text":"A1 retry answer"}]}}\n',
        );
        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001021",
            state: "done",
            attempt: 3,
          }),
        );
        yield* harness.until(
          () =>
            threadMessages(harness.events, firstThreadId).at(-1)?.message.text ===
            "A1 retry answer",
        );
        assert.equal(currentAssistantAnswers().at(-1), "A1 retry answer");
        NodeFS.rmSync(NodePath.join(harness.transcriptDir, "agent-a1.jsonl"));
        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001022",
            state: "start",
            attempt: 4,
          }),
        );
        yield* harness.until(
          () =>
            workflowCoordinatorEvents(harness.events).at(-1)?.subagent.workflow?.agents[0]
              ?.attempt === 4,
        );
        const answersBeforeEmptyAttempt = currentAssistantAnswers();
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001023",
            state: "done",
            attempt: 4,
            omitResult: true,
          }),
        );
        assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "completed");
        assert.deepEqual(
          currentAssistantAnswers(),
          answersBeforeEmptyAttempt,
          "an attempt with no transcript and no excerpt adds nothing",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const transcriptLine = (entry: Record<string, unknown>) =>
    `${JSON.stringify({ isSidechain: true, agentId: "a1", timestamp: "2026-10-17T05:08:07.524Z", ...entry })}\n`;
  const memberAssistantLine = (
    uuid: string,
    messageId: string,
    content: unknown,
    stopReason?: "tool_use" | "end_turn",
  ) =>
    transcriptLine({
      type: "assistant",
      uuid,
      message: {
        model: "claude-opus-5-5",
        id: messageId,
        type: "message",
        role: "assistant",
        content,
        ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
      },
    });
  const memberToolResultLine = (uuid: string, toolUseId: string, output: string) =>
    transcriptLine({
      type: "user",
      uuid,
      message: {
        role: "user",
        content: [{ tool_use_id: toolUseId, type: "tool_result", content: output }],
      },
    });
  const memberTranscript = [
    transcriptLine({
      type: "user",
      uuid: "line-prompt",
      message: { role: "user", content: "Reply with exactly: A1" },
    }),
    transcriptLine({
      type: "attachment",
      uuid: "line-attachment",
      attachment: { type: "skill_listing", content: "- adhd" },
    }),
    transcriptLine({
      type: "user",
      uuid: "line-meta",
      isMeta: true,
      message: { role: "user", content: "<system-reminder>context</system-reminder>" },
    }),
    memberAssistantLine("line-thinking", "msg_a1", [
      { type: "thinking", thinking: "List the files first.", signature: "sig" },
    ]),
    memberAssistantLine("line-bash", "msg_a1", [
      { type: "tool_use", id: "toolu_a1_ls", name: "Bash", input: { command: "ls" } },
    ]),
    memberToolResultLine("line-ls-result", "toolu_a1_ls", "README.md"),
    memberAssistantLine("line-reply", "msg_a1_reply", [
      { type: "text", text: "A1 found README.md" },
    ]),
  ].join("");
  const memberThreadItems = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
    threadId: ThreadId | null | undefined,
  ) =>
    events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.threadId === threadId
        ? [event.turnItem]
        : [],
    );
  const latestMemberThreadItems = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
    threadId: ThreadId | null | undefined,
  ) =>
    [
      ...new Map(memberThreadItems(events, threadId).map((item) => [item.id, item])).values(),
    ].toSorted((left, right) => left.ordinal - right.ordinal);
  const describeItem = (item: ReturnType<typeof memberThreadItems>[number]) =>
    item.type === "reasoning"
      ? `reasoning: ${item.text}`
      : item.type === "command_execution"
        ? `command ${item.status}: ${item.output ?? ""}`
        : item.type === "assistant_message" || item.type === "user_message"
          ? `${item.type}`
          : `${item.type} ${item.status}`;

  it.effect("streams a running workflow member's conversation from its transcript", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reads: Array<{
          readonly startOffset: number;
          readonly endOffset: number;
          readonly lineCount: number;
        }> = [];
        yield* Effect.gen(function* () {
          const harness = yield* makeWorkflowHarness;
          const transcriptPath = NodePath.join(harness.transcriptDir, "agent-a1.jsonl");
          NodeFS.writeFileSync(transcriptPath, memberTranscript);
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-claude-workflow-live-stream"),
              text: "Run the alpha workflow.",
              attachments: [],
            }),
          );
          yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001360" });
          const threadId = workflowMemberEvents(harness.events, 1)[0]?.subagent.childThreadId;
          const running = (uuid: string) => workflowSnapshot({ uuid, state: "start" });

          assert.deepEqual(latestMemberThreadItems(harness.events, threadId).map(describeItem), [
            "user_message",
            "reasoning: List the files first.",
            "command completed: README.md",
            "assistant_message",
          ]);
          assert.deepEqual(
            threadMessages(harness.events, threadId).map((event) => event.message.text),
            ["Reply with exactly: A1", "A1 found README.md"],
          );
          assert.deepEqual(reads.at(-1), {
            startOffset: 0,
            endOffset: Buffer.byteLength(memberTranscript),
            lineCount: 5,
          });

          const itemsBefore = memberThreadItems(harness.events, threadId).length;
          const more = memberAssistantLine("line-more", "msg_a1_more", [
            {
              type: "tool_use",
              id: "toolu_a1_cat",
              name: "Bash",
              input: { command: "cat README.md" },
            },
          ]);
          const half = memberToolResultLine("line-cat-result", "toolu_a1_cat", "hello");
          NodeFS.appendFileSync(transcriptPath, more + half.slice(0, 40));
          yield* harness.offerAndWait(running("00000000-0000-4000-8000-000000001361"));
          assert.deepEqual(reads.at(-1), {
            startOffset: Buffer.byteLength(memberTranscript),
            endOffset: Buffer.byteLength(memberTranscript + more),
            lineCount: 1,
          });
          assert.deepEqual(
            memberThreadItems(harness.events, threadId).slice(itemsBefore).map(describeItem),
            ["command running: "],
            "only the new line is projected; the half-written one waits",
          );

          NodeFS.appendFileSync(transcriptPath, half.slice(40));
          yield* harness.offerAndWait(running("00000000-0000-4000-8000-000000001362"));
          assert.deepEqual(reads.at(-1), {
            startOffset: Buffer.byteLength(memberTranscript + more),
            endOffset: Buffer.byteLength(memberTranscript + more + half),
            lineCount: 1,
          });
          assert.deepEqual(
            memberThreadItems(harness.events, threadId).slice(itemsBefore).map(describeItem),
            ["command running: ", "command completed: hello"],
          );

          const itemsBeforeIdle = memberThreadItems(harness.events, threadId).length;
          yield* harness.offerAndWait(running("00000000-0000-4000-8000-000000001363"));
          assert.equal(reads.at(-1)?.lineCount, 0);
          assert.lengthOf(memberThreadItems(harness.events, threadId), itemsBeforeIdle);

          yield* harness.offerAndWait(
            workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001364", state: "done" }),
          );
          assert.equal(
            workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status,
            "completed",
          );
          assert.deepEqual(
            threadMessages(harness.events, threadId).map((event) => event.message.text),
            ["Reply with exactly: A1", "A1 found README.md"],
            "the settled member adds no second copy of its answer",
          );
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001365", result: "Done." }),
          );
          yield* Queue.take(harness.terminalReceipts);
        }).pipe(
          Effect.provideService(WorkflowAgentTranscriptReadObserver, (read) =>
            Effect.sync(() => {
              if (read.agentId === "a1") {
                reads.push({
                  startOffset: read.startOffset,
                  endOffset: read.endOffset,
                  lineCount: read.lineCount,
                });
              }
            }),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("interrupts the open tool calls of a workflow member that failed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarness;
        NodeFS.writeFileSync(
          NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
          memberAssistantLine("line-bash", "msg_a1", [
            { type: "tool_use", id: "toolu_a1_ls", name: "Bash", input: { command: "ls" } },
          ]),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-member-fails"),
            text: "Run the alpha workflow.",
            attachments: [],
          }),
        );
        yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001370" });
        const threadId = workflowMemberEvents(harness.events, 1)[0]?.subagent.childThreadId;
        assert.deepEqual(latestMemberThreadItems(harness.events, threadId).map(describeItem), [
          "user_message",
          "command running: ",
        ]);
        yield* harness.offerAndWait(
          workflowNotification({ uuid: "00000000-0000-4000-8000-000000001371", status: "failed" }),
        );
        assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "failed");
        assert.deepEqual(latestMemberThreadItems(harness.events, threadId).map(describeItem), [
          "user_message",
          "command interrupted: ",
        ]);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001372", result: "Done." }),
        );
        yield* Queue.take(harness.terminalReceipts);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("reads a settled workflow member's transcript to its end past the read cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarness;
        // Exceeds the launch and settle reads combined, at 512 KB each.
        const filler = "x".repeat(16 * 1024);
        NodeFS.writeFileSync(
          NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
          Array.from({ length: 80 }, (_, index) =>
            memberAssistantLine(`line-early-${index}`, `msg_early_${index}`, [
              { type: "text", text: `${index} ${filler}` },
            ]),
          ).join("") +
            memberAssistantLine("line-final", "msg_final", [
              { type: "text", text: "FINAL ANSWER" },
            ]),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-member-long-transcript"),
            text: "Run the alpha workflow.",
            attachments: [],
          }),
        );
        yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001390" });
        const threadId = workflowMemberEvents(harness.events, 1)[0]?.subagent.childThreadId;
        yield* harness.offerAndWait(
          workflowNotification({
            uuid: "00000000-0000-4000-8000-000000001391",
            status: "completed",
          }),
        );
        const texts = threadMessages(harness.events, threadId)
          .filter((event) => event.message.role === "assistant")
          .map((event) => event.message.text);
        assert.lengthOf(texts, 81);
        assert.equal(texts.at(-1), "FINAL ANSWER", "the answer past the first read is shown");
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001392", result: "Done." }),
        );
        yield* Queue.take(harness.terminalReceipts);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("re-reads a workflow member's transcript after a restart without new items", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runOnce = Effect.fnUntraced(function* (attemptId: string) {
          const harness = yield* makeWorkflowHarness;
          NodeFS.writeFileSync(
            NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
            memberTranscript,
          );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(attemptId),
              text: "Run the alpha workflow.",
              attachments: [],
            }),
          );
          yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001380" });
          const threadId = workflowMemberEvents(harness.events, 1)[0]?.subagent.childThreadId;
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001381", result: "Done." }),
          );
          yield* Queue.take(harness.terminalReceipts);
          assert.deepEqual(latestMemberThreadItems(harness.events, threadId).map(describeItem), [
            "user_message",
            "reasoning: List the files first.",
            "command completed: README.md",
            "assistant_message",
          ]);
          return new Set(memberThreadItems(harness.events, threadId).map((item) => item.id));
        });
        const before = yield* runOnce("attempt-claude-workflow-before-restart");
        const after = yield* runOnce("attempt-claude-workflow-after-restart");
        assert.isAtLeast(before.size, 4);
        assert.deepEqual(
          [...after].filter((id) => !before.has(id)),
          [],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  describe("native goals", () => {
    const syntheticFrame = (uuid: string, text: string) =>
      claudeSdkFrame({
        type: "assistant",
        message: {
          model: "<synthetic>",
          id: uuid,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
        uuid,
        session_id: WAKE_NATIVE_SESSION,
      });
    const stopHookFeedback = (uuid: string, condition: string, reason: string) =>
      claudeSdkFrame({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: `Stop hook feedback:\n[${condition}]: ${reason}` }],
        },
        parent_tool_use_id: null,
        isSynthetic: true,
        uuid,
        session_id: WAKE_NATIVE_SESSION,
      });
    const goalStatuses = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
      events.flatMap((event) =>
        event.type === "provider_thread.updated" && event.providerThread.goal != null
          ? [event.providerThread.goal]
          : [],
      );

    it.effect("tracks a /goal through unmet checks until Claude stops on its own", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const condition = "all tests pass";
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-attempt"),
            text: `/goal ${condition}`,
            attachments: [],
          }),
        );
        for (const frame of [
          syntheticFrame("goal-set", `Goal set: ${condition}`),
          makeAssistantTextFrame({ uuid: "goal-work-1", text: "Fixing the first test." }),
          stopHookFeedback("goal-check-1", condition, "One test still fails."),
          makeAssistantTextFrame({ uuid: "goal-work-2", text: "All tests pass now." }),
          makeResultFrame({ uuid: "goal-result", result: "All tests pass now." }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, "completed");
        assert.deepEqual(goalStatuses(harness.events), [
          { objective: condition, status: "active", checks: 0 },
          {
            objective: condition,
            status: "active",
            checks: 1,
            lastCheck: "One test still fails.",
          },
          { objective: condition, status: "complete", checks: 1 },
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect(
      "defers goal completion until an ambient subagent finishes and Claude checks again",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const condition = "the review finds no bugs";
          const taskId = "task-goal-review";
          const toolUseId = "toolu-goal-review";
          const now = yield* DateTime.now;
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("goal-background-attempt"),
              text: `/goal ${condition}`,
              attachments: [],
            }),
          );
          for (const frame of [
            syntheticFrame("goal-background-set", `Goal set: ${condition}`),
            claudeSdkFrame({
              ...makeSubagentTaskStartedFrame({ taskId, toolUseId, uuid: "goal-review-start" }),
              ambient: true,
              skip_transcript: true,
            }),
            makeAssistantTextFrame({
              uuid: "goal-background-wait",
              text: "Waiting for the review.",
            }),
            makeResultFrame({ uuid: "goal-background-result", result: "Waiting for the review." }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
          assert.deepEqual(goalStatuses(harness.events).at(-1), {
            objective: condition,
            status: "active",
            checks: 0,
          });

          yield* harness.offerAndWait(
            makeSubagentNotificationFrame({
              taskId,
              toolUseId,
              summary: "No bugs found.",
              uuid: "goal-review-done",
            }),
          );
          yield* harness.offerAndWait(wakeTurnInit);
          yield* Queue.take(harness.continuationReceipts);
          assert.equal(goalStatuses(harness.events).at(-1)?.status, "active");
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("goal-background-wake"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* harness.offerAndWait(
            makeAssistantTextFrame({ uuid: "goal-background-wake-work", text: "No bugs found." }),
          );
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "goal-background-wake-result",
              result: "No bugs found.",
              origin: { kind: "task-notification" },
            }),
          );
          assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
          assert.deepEqual(goalStatuses(harness.events).at(-1), {
            objective: condition,
            status: "complete",
            checks: 0,
          });
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
    );

    it.effect.each([
      { taskType: "mcp_task", status: "complete" },
      { taskType: undefined, status: "active" },
    ] as const)("leaves the goal $status with a running $taskType task", ({ taskType, status }) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const condition = "the docs build";
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-task-type-attempt"),
            text: `/goal ${condition}`,
            attachments: [],
          }),
        );
        for (const frame of [
          syntheticFrame("goal-task-type-set", `Goal set: ${condition}`),
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: "task-goal-docs",
            description: "Watch the docs",
            ...(taskType === undefined ? {} : { task_type: taskType }),
            uuid: "goal-task-type-start",
            session_id: WAKE_NATIVE_SESSION,
          }),
          makeAssistantTextFrame({ uuid: "goal-task-type-work", text: "The docs build." }),
          makeResultFrame({ uuid: "goal-task-type-result", result: "The docs build." }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
        assert.equal(goalStatuses(harness.events).at(-1)?.status, status);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect("keeps a goal active after a command turn with no model output", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const condition = "the build is green";
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: {
              ...harness.providerThread,
              goal: { objective: condition, status: "active", checks: 2 },
            },
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-show-attempt"),
            text: "/goal",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          syntheticFrame("goal-show", `Goal active: ${condition} (2 turns)`),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "goal-show-result", result: "", numTurns: 0 }),
        );
        yield* Queue.take(harness.terminalReceipts);
        assert.deepEqual(goalStatuses(harness.events).at(-1), {
          objective: condition,
          status: "active",
          checks: 2,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect("keeps the CLI's goal confirmation out of the conversation", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const condition = "all tests pass";
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: {
              ...harness.providerThread,
              goal: { objective: condition, status: "active", checks: 1 },
            },
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-clear-attempt"),
            text: "/goal clear",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          syntheticFrame("goal-clear", `Goal cleared: ${condition}`),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "goal-clear-result",
            result: `Goal cleared: ${condition}\n`,
            numTurns: 0,
          }),
        );
        yield* Queue.take(harness.terminalReceipts);
        assert.isTrue(
          harness.events.some(
            (event) =>
              event.type === "provider_thread.updated" && event.providerThread.goal === null,
          ),
        );
        assert.isFalse(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.role === "assistant",
          ),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );
  });
});

describe("ClaudeAdapterV2 query message stream", () => {
  it.effect("closes the query when the message stream is interrupted mid-read", () =>
    Effect.gen(function* () {
      let closed = false;
      let releaseRead = () => {};
      const readStarted = Promise.withResolvers<void>();
      // Keep the read pending until close() releases it.
      // oxlint-disable-next-line require-yield
      async function* sdkMessages(): AsyncGenerator<SDKMessage, void> {
        for (;;) {
          if (closed) return;
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
            readStarted.resolve();
          });
        }
      }
      const generator = sdkMessages();
      const close = () => {
        closed = true;
        releaseRead();
      };
      const query = {
        next: () => generator.next(),
        return: async (value?: void) => {
          close();
          return generator.return(value);
        },
        throw: (error?: unknown) => generator.throw(error),
        [Symbol.asyncIterator]: () => generator,
        close,
      } as unknown as ClaudeQuery;

      const scope = yield* Scope.make();
      yield* Stream.fromAsyncIterable(
        ClaudeAdapterV2.claudeQueryMessages(query),
        (cause) => cause,
      ).pipe(
        Stream.runForEach(() => Effect.void),
        Effect.forkIn(scope),
      );
      yield* Effect.promise(() => readStarted.promise);

      // The raw async generator's return() queues behind its pending read and deadlocks scope close.
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(closed);
    }),
  );
});
