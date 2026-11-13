// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";
import type {
  ElicitationRequest,
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
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
  type ResolvedProviderInstanceEnvironment,
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
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import * as PortScanner from "../../preview/PortScanner.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { WorkflowAgentTranscriptReadObserver } from "../workflowAgentTranscript.ts";
import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH } from "@t3tools/provider-core/server/orchestrationInstructions";
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

import {
  DEFAULT_CLAUDE_SETTINGS,
  AUTO_COMPACT_CLAUDE_SETTINGS,
  CLAUDE_TEST_MODEL_SELECTION,
  T3_MCP_SERVERS,
  mcpSessionFor,
  options,
  append,
} from "./ClaudeAdapterV2-fixtures.testkit.ts";

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

describe("ClaudeAdapterV2 runtime query policy", () => {
  it.each([
    "-- --thinking-display omitted",
    "--thinking-display summarized -- --thinking-display omitted",
  ])("does not treat operands after -- as SDK flags: %s", (launchArgs) => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "thinking-thread",
      resume: false,
      cwd: "/workspace",
      settings: { ...DEFAULT_CLAUDE_SETTINGS, launchArgs },
    });
    assert.deepEqual(options.thinking, { type: "adaptive", display: "summarized" });
    assert.equal(options.extraArgs?.["thinking-display"], "summarized");
  });

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

  it("passes every --add-dir launch directory to Claude", () => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "native-add-dir",
      resume: false,
      cwd: "/workspace",
      attachmentsDir: "/attachments",
      settings: {
        ...AUTO_COMPACT_CLAUDE_SETTINGS,
        launchArgs: "--add-dir ../apps ../lib --verbose --add-dir=/shared",
      },
    });
    assert.deepEqual(options.additionalDirectories, [
      "/workspace",
      "/attachments",
      "../apps",
      "../lib",
      "/shared",
    ]);
    assert.isUndefined(options.extraArgs?.["add-dir"]);
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
    assert.notInclude(systemPrompt.append ?? "", "## T3 Code devices");
    const logged = ClaudeAdapterV2.loggedClaudeQueryOptions(options);
    assert.equal(logged.hasMcpServers, true);
    assert.notInclude(JSON.stringify(logged), "secret-claude-token");
  });

  it("logs --settings key names without their values", () => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "native-thread-claude-settings-log",
      resume: false,
      cwd: "/workspace",
      sdkSettings: { env: { ANTHROPIC_API_KEY: "secret-settings-key" } },
    });
    const logged = ClaudeAdapterV2.loggedClaudeQueryOptions(options);
    assert.deepEqual(logged.settingKeys, ["env", "showThinkingSummaries"]);
    assert.notInclude(JSON.stringify(logged), "secret-settings-key");
  });
});
describe("ClaudeAdapterV2 device instructions", () => {
  const options = (input: { readonly mcp: boolean; readonly deviceToolsAvailable: boolean }) =>
    ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
      },
      nativeThreadId: "native-thread-claude-devices",
      resume: false,
      cwd: "/workspace",
      ...(input.mcp
        ? { mcpServers: { "t3-code": { type: "http" as const, url: "http://127.0.0.1/mcp" } } }
        : {}),
      deviceToolsAvailable: input.deviceToolsAvailable,
      environment: {},
    });
  const append = (input: { readonly mcp: boolean; readonly deviceToolsAvailable: boolean }) =>
    (options(input).systemPrompt as { readonly append?: string }).append ?? "";

  it("gives a session with device access the device block and the ToolSearch line to load it", () => {
    const text = append({ mcp: true, deviceToolsAvailable: true });
    assert.include(text, T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH);
    assert.include(text, "Use `delegate_task`");
  });

  it("leaves the device block out without device access or without T3 tools", () => {
    assert.notInclude(append({ mcp: true, deviceToolsAvailable: false }), "## T3 Code devices");
    assert.notInclude(append({ mcp: false, deviceToolsAvailable: true }), "## T3 Code devices");
  });

  it("gives native subagents the device block only in a session with device access", async () => {
    // Subagents start from their task prompt, not the parent's system prompt.
    const subagentContext = (input: {
      readonly mcp: boolean;
      readonly deviceToolsAvailable: boolean;
    }) =>
      Promise.all(
        (options(input).hooks?.SubagentStart ?? []).flatMap((matcher) =>
          matcher.hooks.map((hook) =>
            hook(
              {
                hook_event_name: "SubagentStart",
                agent_id: "agent-1",
                agent_type: "general-purpose",
                session_id: "native-thread-claude-devices",
                transcript_path: "/transcript.jsonl",
                cwd: "/workspace",
              },
              undefined,
              { signal: new AbortController().signal },
            ),
          ),
        ),
      );
    assert.deepEqual(await subagentContext({ mcp: true, deviceToolsAvailable: true }), [
      {
        hookSpecificOutput: {
          hookEventName: "SubagentStart",
          additionalContext: T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
        },
      },
    ]);
    assert.deepEqual(await subagentContext({ mcp: true, deviceToolsAvailable: false }), []);
    assert.deepEqual(await subagentContext({ mcp: false, deviceToolsAvailable: true }), []);
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
      null,
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
