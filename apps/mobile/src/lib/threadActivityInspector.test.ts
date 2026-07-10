import { EMPTY_V2_ITEM_SUPPORT } from "@t3tools/client-runtime/state/item-support";
import {
  CheckpointId,
  CheckpointScopeId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadFeed, type ThreadFeedActivity } from "./threadActivity";
import { buildThreadActivityInspector } from "./threadActivityInspector";

const threadId = ThreadId.make("thread-1");
const sourceThreadId = ThreadId.make("thread-source");
const runId = RunId.make("run-1");
const nodeId = NodeId.make("node-1");
const startedAt = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const completedAt = DateTime.makeUnsafe("2026-06-20T00:00:02.000Z");

function itemBase(id: string) {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt,
    completedAt,
    updatedAt: completedAt,
  };
}

function activityFor(item: OrchestrationV2TurnItem): ThreadFeedActivity {
  const row: OrchestrationV2ProjectedTurnItem = {
    position: 0,
    visibility: "inherited",
    sourceThreadId,
    sourceItemId: item.id,
    item,
  };
  const group = buildThreadFeed([row])[0];
  if (group?.type !== "activity-group" || !group.activities[0]) {
    throw new Error("Expected an activity group");
  }
  return group.activities[0];
}

describe("buildThreadActivityInspector", () => {
  it("presents command lifecycle, execution support, output, and exit state", () => {
    const item: OrchestrationV2TurnItem = {
      ...itemBase("command"),
      type: "command_execution",
      input: "vp check",
      output: "all checks passed",
      exitCode: 0,
    };
    const support = {
      ...EMPTY_V2_ITEM_SUPPORT,
      item,
      run: { status: "completed" } as never,
      attempts: [
        {
          id: "attempt-1",
          attemptOrdinal: 1,
          status: "superseded",
          reason: "initial",
        },
        {
          id: "attempt-2",
          attemptOrdinal: 2,
          status: "completed",
          reason: "steering_restart",
        },
      ] as never,
      node: { kind: "tool_call", status: "completed" } as never,
      providerSession: {
        status: "ready",
        model: "gpt-5.4",
        cwd: "/workspace/project",
      } as never,
    };

    const model = buildThreadActivityInspector(activityFor(item), support);
    expect(model.fields).toEqual(
      expect.arrayContaining([
        { label: "Duration", value: "2.0s" },
        { label: "Run", value: "completed" },
        { label: "Working directory", value: "/workspace/project" },
        { label: "Visibility", value: "inherited" },
      ]),
    );
    expect(model.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Command", value: "vp check" }),
        expect.objectContaining({ label: "Output", value: "all checks passed" }),
        expect.objectContaining({ label: "Exit", value: "Process exited with code 0" }),
        expect.objectContaining({ label: "Attempt history" }),
      ]),
    );
  });

  it("exposes file and web result provenance plus dynamic structured data", () => {
    const fileSearch: OrchestrationV2TurnItem = {
      ...itemBase("file-search"),
      type: "file_search",
      pattern: "resolveSession",
      results: [{ fileName: "src/session.ts", line: 42, preview: "function resolveSession()" }],
    };
    const fileModel = buildThreadActivityInspector(activityFor(fileSearch), EMPTY_V2_ITEM_SUPPORT);
    expect(fileModel.fileLinks).toEqual([
      {
        label: "src/session.ts — function resolveSession()",
        path: "src/session.ts",
        line: 42,
      },
    ]);

    const webSearch: OrchestrationV2TurnItem = {
      ...itemBase("web-search"),
      type: "web_search",
      patterns: ["Effect Schema docs"],
      results: [
        { title: "Schema", url: "https://effect.website/docs/schema", snippet: "Typed schemas" },
      ],
    };
    const webModel = buildThreadActivityInspector(activityFor(webSearch), EMPTY_V2_ITEM_SUPPORT);
    expect(webModel.webLinks).toEqual([
      { label: "Schema", url: "https://effect.website/docs/schema" },
    ]);
    expect(webModel.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Schema", value: "Typed schemas" }),
      ]),
    );

    const dynamicTool: OrchestrationV2TurnItem = {
      ...itemBase("dynamic"),
      type: "dynamic_tool",
      toolName: "custom",
      input: { nested: { value: 1 } },
      output: { ok: true },
    };
    const dynamicModel = buildThreadActivityInspector(
      activityFor(dynamicTool),
      EMPTY_V2_ITEM_SUPPORT,
    );
    expect(dynamicModel.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Input", value: expect.stringContaining('"nested"') }),
        expect.objectContaining({ label: "Output", value: expect.stringContaining('"ok"') }),
      ]),
    );
    expect(dynamicModel.structuredDetails).toContain('"type": "dynamic_tool"');
  });

  it("enables rollback only for the matching ready checkpoint", () => {
    const checkpointId = CheckpointId.make("checkpoint-1");
    const scopeId = CheckpointScopeId.make("scope-1");
    const item: OrchestrationV2TurnItem = {
      ...itemBase("checkpoint"),
      type: "checkpoint",
      checkpointId,
      scopeId,
      files: [{ path: "src/main.ts", kind: "modified", additions: 2, deletions: 1 }],
    };
    const checkpoint = { id: checkpointId, scopeId, status: "ready" } as never;
    const model = buildThreadActivityInspector(activityFor(item), {
      ...EMPTY_V2_ITEM_SUPPORT,
      item,
      checkpoint,
    });

    expect(model.canRollback).toBe(true);
    expect(model.rollbackTarget).toEqual({
      threadId: sourceThreadId,
      checkpointId,
      scopeId,
    });
  });

  it("prefers live subagent progress from supporting state", () => {
    const item: OrchestrationV2TurnItem = {
      ...itemBase("subagent"),
      type: "subagent",
      subagentId: nodeId,
      origin: "provider_native",
      driver: ProviderDriverKind.make("claude"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      childThreadId: null,
      prompt: "Audit the reducer",
      progress: "Starting",
      result: null,
    };
    const model = buildThreadActivityInspector(activityFor(item), {
      ...EMPTY_V2_ITEM_SUPPORT,
      item,
      subagent: {
        origin: "provider_native",
        status: "running",
        progress: "Reading projection tests",
        result: null,
      } as never,
    });

    expect(model.fields).toContainEqual({
      label: "Delegated task",
      value: "provider native · running",
    });
    expect(model.blocks).toContainEqual({
      label: "Progress",
      value: "Reading projection tests",
      monospaced: false,
    });
  });

  it("shows the live Codex subagent result without reading child-thread events", () => {
    const item: OrchestrationV2TurnItem = {
      ...itemBase("codex-subagent"),
      type: "subagent",
      subagentId: nodeId,
      origin: "provider_native",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: ThreadId.make("thread-codex-subagent"),
      prompt: "Explain test isolation",
      result: "Projected result",
    };
    const model = buildThreadActivityInspector(activityFor(item), {
      ...EMPTY_V2_ITEM_SUPPORT,
      item,
      subagent: {
        origin: "provider_native",
        status: "completed",
        result: "Tests should be independent and isolated.",
      } as never,
    });

    expect(model.blocks).toContainEqual({
      label: "Result",
      value: "Tests should be independent and isolated.",
      monospaced: false,
    });
    expect(model.blocks).not.toContainEqual(
      expect.objectContaining({ label: "Result", value: "Projected result" }),
    );
  });
});
