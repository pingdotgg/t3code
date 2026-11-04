import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { buildToolCallExpandedBody } from "./TimelineWorkEntryRow.logic";

it.each([
  {
    status: "completed",
    output: { context: [{ title: "Conventions", text: "Use tabs." }] },
    detail: "Conventions\nUse tabs.",
  },
  {
    status: "failed",
    output: { reason: "The index is offline." },
    detail: "Not added\nThe index is offline.",
  },
] as const)(
  "attributes $status plugin context without exposing invocation input",
  ({ status, output, detail }) => {
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make("plugin-context"),
      threadId: ThreadId.make("thread"),
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "dynamic_tool",
      status,
      title: "Context from Notes",
      toolName: "plugin_context",
      toolSource: { key: "plugin:test.notes", name: "Notes", kind: "integration" },
      input: {
        plugin: {
          id: "test.notes",
          name: "Notes",
          installationId: "INSTALLATION_INPUT",
          generation: 3,
        },
      },
      output:
        "context" in output
          ? { context: output.context.map((block) => ({ ...block })) }
          : { reason: output.reason },
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    };
    const body = buildToolCallExpandedBody(
      {
        id: "entry",
        createdAt: "2026-10-01T00:00:00Z",
        label: "Context from Notes",
        tone: "tool",
        itemType: "dynamic_tool",
        structuredPayload: item,
      },
      "/repo",
      "Context from Notes",
      null,
    );
    expect(body).toBe(`From Notes (test.notes)\n\n${detail}`);
    expect(body).not.toContain("INSTALLATION_INPUT");
  },
);
