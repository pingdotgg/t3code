import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CheckpointId,
  CodexSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderSetupError,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as CodexError from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as FileSystem from "effect/FileSystem";
import { MCP_APP_OUTPUT_KEY, readMcpAppReference } from "@t3tools/shared/mcpApp";
import { toolOutputImages } from "@t3tools/shared/toolOutput";
import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import packageJson from "../../../package.json" with { type: "json" };
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ModelManifest from "../../provider/ModelManifest.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import { resolveProviderCompatibility } from "../../provider/providerCompatibility.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";
import * as CodexAdapterV2Testkit from "./CodexAdapterV2.testkit.ts";

import { makeCodexTestTurnInput, makeCodexReplayTurn, codexReplayPreamble, makeCodexReplayTranscript, makeCodexReplayHarness, nativeThreadId, request, nativeTurnId, prompt, addA, updateB, renameC, deleteE, fileChange, approval, turnCompleted, startApprovalTurn, approvalItem } from "./CodexAdapterV2-fixtures.testkit.ts";
import {  } from "./CodexAdapterV2-fixtures.testkit.ts";
import type { FileUpdateChange } from "./CodexAdapterV2-fixtures.testkit.ts";

describe("CodexAdapterV2 post-settle continuation", () => {
  describe("Codex file-change approval paths", () => {
    const nativeThreadId = "file-approval-thread";
    const nativeTurnId = "file-approval-turn";
    const prompt = "Edit the files.";
    type FileUpdateChange = CodexSchema.V2ItemStartedNotification__FileUpdateChange;
    const addA: FileUpdateChange = { path: "/w/a.ts", kind: { type: "add" }, diff: "export {};" };
    const updateB: FileUpdateChange = {
      path: "/w/b.ts",
      kind: { type: "update", move_path: null },
      diff: "@@",
    };
    const renameC: FileUpdateChange = {
      path: "/w/c.ts",
      kind: { type: "update", move_path: "/w/d.ts" },
      diff: "@@",
    };

    const deleteE: FileUpdateChange = { path: "/w/e.ts", kind: { type: "delete" }, diff: "gone" };

    const fileChange = (
      phase: "started" | "completed",
      turnId: string,
      itemId: string,
      changes: ReadonlyArray<FileUpdateChange>,
    ): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label: `${phase} ${itemId}`,
      frame: {
        method: `item/${phase}`,
        params: {
          threadId: nativeThreadId,
          turnId,
          ...(phase === "started" ? { startedAtMs: 1 } : { completedAtMs: 3 }),
          item: {
            type: "fileChange",
            id: itemId,
            status: phase === "started" ? "inProgress" : "completed",
            changes,
          },
        },
      },
    });

    const approval = (input: {
      readonly id: number;
      readonly turnId: string;
      readonly itemId: string;
    }): Array<CodexReplay.CodexAppServerReplayEntry> => [
      {
        type: "emit_inbound",
        label: `approval ${input.itemId}`,
        frame: {
          id: input.id,
          method: "item/fileChange/requestApproval",
          params: {
            threadId: nativeThreadId,
            turnId: input.turnId,
            itemId: input.itemId,
            startedAtMs: 2,
            reason: null,
            grantRoot: null,
          },
        },
      },
      {
        type: "expect_outbound",
        label: `approval ${input.itemId}`,
        frame: { id: input.id, result: { decision: "accept" } },
      },
    ];

    const turnCompleted = (turnId: string): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label: `complete ${turnId}`,
      frame: {
        method: "turn/completed",
        params: {
          threadId: nativeThreadId,
          turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
        },
      },
    });

    const startApprovalTurn = (
      scenario: string,
      entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
    ) =>
      Effect.gen(function* () {
        const pending = yield* Queue.unbounded<OrchestrationV2RuntimeRequest>();
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario,
            entries: [...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }), ...entries],
          }),
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
              ? Queue.offer(pending, event.runtimeRequest)
              : Effect.void,
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`${scenario}-attempt`),
            text: prompt,
          }),
        );
        return {
          harness,
          answerNext: Queue.take(pending).pipe(
            Effect.tap((request) =>
              harness.runtime.respondToRuntimeRequest({
                requestId: request.id,
                decision: "accept",
              }),
            ),
          ),
        };
      });

    const approvalItem = (
      events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
      request: OrchestrationV2RuntimeRequest,
    ) =>
      events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "approval_request" &&
        event.turnItem.requestId === request.id
          ? [event.turnItem]
          : [],
      )[0];

    it.effect("answers without waiting for late paths or borrowing another item's paths", () =>
      Effect.gen(function* () {
        const { harness, answerNext } = yield* startApprovalTurn("file-approval-after", [
          fileChange("started", nativeTurnId, "other-patch", [updateB]),
          // Late details cannot arrive until the approval response has been sent.
          ...approval({ id: 0, turnId: nativeTurnId, itemId: "patch-a" }),
          fileChange("started", nativeTurnId, "patch-a", [addA]),
          fileChange("completed", nativeTurnId, "patch-a", [addA]),
          fileChange("completed", nativeTurnId, "other-patch", [updateB]),
          turnCompleted(nativeTurnId),
        ]);
        const request = yield* answerNext;
        yield* harness.firstTerminal;

        const items = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "approval_request" &&
          event.turnItem.requestId === request.id
            ? [event.turnItem]
            : [],
        );
        assert.equal(request.nativeRequestRef?.nativeId, "patch-a");
        assert.isNotEmpty(items);
        for (const item of items) {
          assert.equal(item.requestKind, "file-change");
          assert.isUndefined(item.prompt);
        }
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed"],
        );
      }).pipe(
        Effect.scoped,
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

    it.effect("matches file paths to items approved out of order", () =>
      Effect.gen(function* () {
        const { harness, answerNext } = yield* startApprovalTurn("file-approval-concurrent", [
          fileChange("started", nativeTurnId, "patch-a", [renameC, deleteE, addA]),
          fileChange("started", nativeTurnId, "patch-b", [updateB]),
          ...approval({ id: 0, turnId: nativeTurnId, itemId: "patch-b" }),
          fileChange("completed", nativeTurnId, "patch-b", [updateB]),
          ...approval({ id: 1, turnId: nativeTurnId, itemId: "patch-a" }),
          fileChange("completed", nativeTurnId, "patch-a", [renameC, deleteE, addA]),
          turnCompleted(nativeTurnId),
        ]);
        const first = yield* answerNext;
        const second = yield* answerNext;
        yield* harness.firstTerminal;

        assert.deepEqual(
          [first, second].map((request) => [
            request.nativeRequestRef?.nativeId,
            approvalItem(harness.events, request)?.prompt,
          ]),
          [
            ["patch-b", "update /w/b.ts"],
            ["patch-a", "add /w/a.ts\nupdate /w/c.ts -> /w/d.ts\ndelete /w/e.ts"],
          ],
        );
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed"],
        );
      }).pipe(
        Effect.scoped,
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

    it.effect("keeps every path of a completed multi-file patch", () =>
      Effect.gen(function* () {
        const { harness } = yield* startApprovalTurn("file-change-multi-path", [
          fileChange("started", nativeTurnId, "patch-a", [renameC, deleteE, addA]),
          fileChange("completed", nativeTurnId, "patch-a", [renameC, deleteE, addA]),
          turnCompleted(nativeTurnId),
        ]);
        yield* harness.firstTerminal;

        const fileChanges = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "file_change"
            ? [event.turnItem]
            : [],
        );
        assert.lengthOf(fileChanges, 1);
        assert.equal(fileChanges[0]?.fileName, "/w/c.ts");
        assert.deepEqual(fileChanges[0]?.changes, [
          { operation: "update", path: "/w/d.ts", oldPath: "/w/c.ts" },
          { operation: "delete", path: "/w/e.ts" },
          { operation: "add", path: "/w/a.ts" },
        ]);
      }).pipe(
        Effect.scoped,
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

    it.effect("classifies permission requests that only list sandbox entries", () =>
      Effect.gen(function* () {
        const permissionRequest = (
          id: number,
          itemId: string,
          entries: CodexSchema.PermissionsRequestApprovalParams__AdditionalFileSystemPermissions["entries"],
        ): Array<CodexReplay.CodexAppServerReplayEntry> => [
          {
            type: "emit_inbound",
            label: `permissions ${itemId}`,
            frame: {
              id,
              method: "item/permissions/requestApproval",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                itemId,
                cwd: "/w",
                startedAtMs: 2,
                permissions: { fileSystem: { entries } },
              },
            },
          },
          {
            type: "expect_outbound",
            label: `permissions ${itemId}`,
            frame: { id, result: { permissions: { fileSystem: { entries } }, scope: "turn" } },
          },
        ];
        const { harness, answerNext } = yield* startApprovalTurn("permission-entries", [
          ...permissionRequest(0, "write-glob", [
            { access: "read", path: { type: "path", path: "/w/src" } },
            { access: "write", path: { type: "glob_pattern", pattern: "/w/out/**" } },
          ]),
          ...permissionRequest(1, "read-glob", [
            { access: "read", path: { type: "glob_pattern", pattern: "/w/docs/**" } },
          ]),
          turnCompleted(nativeTurnId),
        ]);
        const write = yield* answerNext;
        const read = yield* answerNext;
        yield* harness.firstTerminal;

        assert.deepEqual(
          [write, read].map((request) => [
            request.kind,
            approvalItem(harness.events, request)?.requestKind,
          ]),
          [
            ["file-change", "file-change"],
            ["file-read", "file-read"],
          ],
        );
      }).pipe(
        Effect.scoped,
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
