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
  makeClaudeTestTurnInput,
  options,
  openWith,
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  makeResultFrame,
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
        const openWith = (launchArgs: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeWakeHarnessWithOptions({
                settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath: home, launchArgs },
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
        const open = openWith("");
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
        yield* fileSystem.writeFileString(
          remoteFile,
          JSON.stringify({
            permissions: { disableBypassPermissionsMode: false, disableAutoMode: false },
            disableAutoMode: false,
            managedSourcesBehavior: "merge",
          }),
        );
        const unrestricted = yield* open;
        assert.equal(unrestricted.permissionMode, "bypassPermissions");
        assert.equal(unrestricted.allowDangerouslySkipPermissions, true);
        yield* fileSystem.writeFileString(
          remoteFile,
          JSON.stringify({
            permissions: { disableBypassPermissionsMode: "disable", disableAutoMode: "disable" },
            disableAutoMode: false,
          }),
        );
        const mixed = yield* open;
        assert.equal(mixed.permissionMode, "default");
        assert.isUndefined(mixed.allowDangerouslySkipPermissions);
        yield* fileSystem.writeFileString(
          remoteFile,
          JSON.stringify({ permissions: { disableBypassPermissionsMode: true } }),
        );
        assert.equal((yield* open).permissionMode, "auto");
        yield* fileSystem.remove(remoteFile);
        assert.equal((yield* open).permissionMode, "bypassPermissions");
        const launchRestricted = yield* openWith(
          `--settings '{"permissions":{"disableBypassPermissionsMode":"disable"}}'`,
        );
        assert.equal(launchRestricted.permissionMode, "auto");
        assert.isUndefined(launchRestricted.allowDangerouslySkipPermissions);
        yield* fileSystem.writeFileString(remoteFile, "{ invalid json");
        assert.equal((yield* open).permissionMode, "auto");
        yield* fileSystem.remove(remoteFile);
        yield* fileSystem.makeDirectory(remoteFile);
        assert.equal((yield* open).permissionMode, "auto");
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
    it.effect("drops false bypass switches from --settings before they reach the SDK", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-launch-" });
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-launch-cwd-" });
        const sdk = yield* Effect.promise(() =>
          vi.importActual<typeof ClaudeSdk>("@anthropic-ai/claude-agent-sdk"),
        );
        vi.mocked(ClaudeSdk.resolveSettings).mockImplementation(sdk.resolveSettings);
        const openWith = (settings: Record<string, unknown>) =>
          Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makeWakeHarnessWithOptions({
                settings: {
                  ...DEFAULT_CLAUDE_SETTINGS,
                  homePath: home,
                  launchArgs: `--settings '${JSON.stringify(settings)}'`,
                },
              });
              yield* harness.runtime.startTurn(
                makeClaudeTestTurnInput({
                  threadId: harness.threadId,
                  providerThread: harness.providerThread,
                  now: yield* DateTime.now,
                  attemptId: RunAttemptId.make("attempt-launch-arg-settings"),
                  text: "Run git status.",
                  attachments: [],
                  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    cwd,
                  }),
                }),
              );
              const options = harness.getOpenedOptions()!;
              return {
                permissionMode: options.permissionMode,
                settings: options.settings as {
                  disableAutoMode?: unknown;
                  permissions?: Record<string, unknown>;
                  env?: Record<string, unknown>;
                },
              };
            }),
          );
        const unrestricted = yield* openWith({
          disableAutoMode: false,
          permissions: { disableBypassPermissionsMode: false, disableAutoMode: false, allow: [] },
          env: { KEPT: "1" },
        });
        assert.equal(unrestricted.permissionMode, "bypassPermissions");
        assert.notProperty(unrestricted.settings, "disableAutoMode");
        assert.deepEqual(unrestricted.settings.permissions, { allow: [] });
        assert.equal(unrestricted.settings.env?.KEPT, "1");
        const restricted = yield* openWith({
          disableAutoMode: false,
          permissions: { disableBypassPermissionsMode: "disable", disableAutoMode: "disable" },
        });
        assert.equal(restricted.permissionMode, "default");
        assert.notProperty(restricted.settings, "disableAutoMode");
        assert.deepEqual(restricted.settings.permissions, {
          disableBypassPermissionsMode: "disable",
          disableAutoMode: "disable",
        });
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
        const fallbackDecision = yield* Effect.promise(() =>
          harness.getOpenedOptions()!.canUseTool!(
            "Bash",
            { command: "echo checked" },
            {
              signal: new AbortController().signal,
              toolUseID: "safety-check-after-downgrade",
              requestId: "request-safety-check-after-downgrade",
              decisionReason:
                "Dangerous rm operation not ruled out — the shell may read this command differently than it was parsed",
            },
          ),
        ).pipe(Effect.forkScoped);
        const fallbackFirst = yield* Effect.raceFirst(
          Queue.take(harness.runtimeRequestReceipts).pipe(
            Effect.map((event) => ({ type: "request", event }) as const),
          ),
          Fiber.join(fallbackDecision).pipe(Effect.map(() => ({ type: "decision" }) as const)),
        );
        assert.equal(fallbackFirst.type, "request");
        if (fallbackFirst.type !== "request") return;
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: fallbackFirst.event.runtimeRequest.id,
          decision: "decline",
        });
        assert.equal((yield* Fiber.join(fallbackDecision))?.behavior, "deny");
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
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
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
            Layer.mergeAll(
              IdAllocator.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
              NodeCrypto.layer,
            ),
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
