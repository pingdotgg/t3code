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
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
  makeWakeHarnessWithOptions,
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

describe("ClaudeAdapterV2 background wake turns", () => {
  describe("Claude settings restrictions", () => {
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
          launchArgs = "",
        ) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* fileSystem.writeFileString(path.join(home, "settings.json"), settingsJson);
              const harness = yield* makeWakeHarnessWithOptions({
                settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath: home, launchArgs },
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
        // --settings beats local, project, and user settings.
        assert.equal(
          yield* openedToolSearch(
            '{"env":{"ENABLE_TOOL_SEARCH":"auto"}}',
            CLAUDE_TEST_RUNTIME_POLICY.cwd,
            undefined,
            `--settings '{"env":{"ENABLE_TOOL_SEARCH":"false"}}'`,
          ),
          "false",
        );

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
});
