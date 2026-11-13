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
  CLAUDE_TEST_MODEL_SELECTION,
  makeClaudeTestTurnInput,
  options,
  append,
  startTurnWithLaunchArgs,
  appendSystemPrompt,
  form,
  captureSdkExecutablePaths,
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

    // Under an administrator's ceiling a suggested mode switch is dropped; the rule stays.
    const managed = ClaudeAdapterV2.permissionResultFromDecision({
      toolName: "Edit",
      decision: "acceptForSession",
      toolInput: {},
      toolUseID: "tool-2",
      managedCeiling: true,
      suggestions: [
        { type: "setMode", mode: "acceptEdits", destination: "session" },
        {
          type: "addRules",
          rules: [{ toolName: "Edit" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    });
    assert.deepEqual(managed.behavior === "allow" ? managed.updatedPermissions : undefined, [
      {
        type: "addRules",
        rules: [{ toolName: "Edit" }],
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
          random: yield* SecureRandom.SecureRandom,
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
          Stream.takeUntil(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const command = { command: "node -e 'console.log(42)'" };
        const decision = yield* Effect.promise(() =>
          canUseTool!("Bash", command, {
            signal: new AbortController().signal,
            toolUseID: "tool-bash-accept-edits",
            requestId: "request-bash-accept-edits",
            description: "Check the Node runtime",
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
        const event = first.event.find((event) => event.type === "runtime_request.updated");
        assert.equal(event?.runtimeRequest.kind, "command");
        const approval = first.event.findLast((event) => event.type === "turn_item.updated");
        assert.equal(
          approval?.turnItem.type === "approval_request" ? approval.turnItem.prompt : undefined,
          command.command,
        );

        yield* runtime.respondToRuntimeRequest({
          requestId: event!.runtimeRequest.id,
          decision: "accept",
        });
        assert.equal((yield* Fiber.join(decision))?.behavior, "allow");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
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
      random: yield* SecureRandom.SecureRandom,
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
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  // regression: #15073 the SDK replaced the --settings launch argument with T3's settings
  it.effect.each([
    `--settings '{"skillOverrides":{"lint":"off"},"showThinkingSummaries":false}'`,
    "--settings user-settings.json",
  ])("merges %s beneath T3's settings", (launchArgs) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-settings-" });
        yield* fileSystem.writeFileString(
          NodePath.join(cwd, "user-settings.json"),
          '{"skillOverrides":{"lint":"off"},"showThinkingSummaries":false}',
        );
        const { exit, opened } = yield* startTurnWithLaunchArgs(launchArgs, cwd);
        assert.isTrue(Exit.isSuccess(exit));
        assert.deepInclude(opened[0]!.settings, {
          skillOverrides: { lint: "off" },
          showThinkingSummaries: true,
        });
        assert.isUndefined(opened[0]!.extraArgs?.["settings"]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
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
    [
      "--settings missing.json",
      (cwd: string) =>
        new ClaudeAdapterV2.ClaudeSettingsLaunchArgError({
          path: NodePath.join(cwd, "missing.json"),
        }).message,
    ],
    ["--settings '{not json}'", () => new ClaudeAdapterV2.ClaudeSettingsLaunchArgError({}).message],
    // Without a closing brace this must not become a file path that echoes the secret.
    [
      `--settings '{"env":{"ANTHROPIC_API_KEY":"secret-settings-key"},'`,
      () => new ClaudeAdapterV2.ClaudeSettingsLaunchArgError({}).message,
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
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
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
describe("ClaudeAdapterV2 MCP elicitation acceptance", () => {
  const form = (
    properties: Record<string, unknown>,
    required?: ReadonlyArray<string>,
  ): ElicitationRequest => ({
    serverName: "deploys",
    message: "Deploy web?",
    mode: "form",
    requestedSchema: { type: "object", properties, ...(required ? { required } : {}) },
  });

  it("answers an empty-properties form with empty content", () => {
    assert.deepEqual(ClaudeAdapterV2.claudeMcpElicitationAcceptance(form({})), {
      action: "accept",
      content: {},
    });
  });

  it("picks the one-time choice however the server spells it", () => {
    for (const choice of [
      "allow_once",
      "Allow",
      "accept_once",
      "Approve once",
      "allow_this_time",
      "allow_once_only",
    ]) {
      assert.deepEqual(
        ClaudeAdapterV2.claudeMcpElicitationAcceptance(
          form({ decision: { type: "string", enum: ["disallow", choice, "always"] } }, [
            "decision",
          ]),
        ),
        { action: "accept", content: { decision: choice } },
      );
    }
  });

  it("answers a persistence toggle with false", () => {
    assert.deepEqual(
      ClaudeAdapterV2.claudeMcpElicitationAcceptance(
        form({ remember: { type: "boolean", title: "Always allow" } }, ["remember"]),
      ),
      { action: "accept", content: { remember: false } },
    );
  });

  it("leaves out optional fields the card does not show", () => {
    assert.deepEqual(
      ClaudeAdapterV2.claudeMcpElicitationAcceptance(
        form({ scope: { type: "string", enum: ["once", "always"], default: "always" } }),
      ),
      { action: "accept", content: { scope: "once" } },
    );
    assert.deepEqual(
      ClaudeAdapterV2.claudeMcpElicitationAcceptance(
        form({ limit: { type: "number", default: 500 } }),
      ),
      { action: "accept", content: {} },
    );
  });

  it("has no answer for URL mode or a form asking for a value", () => {
    for (const request of [
      { serverName: "deploys", message: "Sign in", mode: "url", url: "https://example.com" },
      form({ reason: { type: "string" } }, ["reason"]),
      form({ grant: { type: "string", enum: ["always", "session"] } }, ["grant"]),
      form({ grant: { type: "string", enum: ["deny", "always"], default: "always" } }, ["grant"]),
      form({ limit: { type: "number", default: 500 } }, ["limit"]),
      { serverName: "deploys", message: "Deploy web?", mode: "form" },
    ] satisfies ReadonlyArray<ElicitationRequest>) {
      assert.isUndefined(ClaudeAdapterV2.claudeMcpElicitationAcceptance(request));
    }
  });
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
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );
});
