import { describe, expect, it } from "vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";

import { buildWorkflowContextArtifact, renderWorkflowContextArtifact } from "./workflowContext.ts";

const parent = {
  id: ThreadId.make("parent"),
  messages: [
    {
      id: MessageId.make("first"),
      role: "user" as const,
      text: "Do not expose this message.",
      turnId: null,
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: MessageId.make("selected"),
      role: "assistant" as const,
      text: "Use this scoped handoff.",
      turnId: null,
      streaming: false,
      createdAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    },
  ],
} as const;

describe("workflow context artifacts", () => {
  it("never copies parent messages without an explicit selected-message policy", () => {
    const artifact = buildWorkflowContextArtifact({
      parent,
      policy: "summary",
      summary: "Investigate the selected implementation concern.",
    });

    expect(artifact).toMatchObject({
      contextPolicy: "summary",
      messages: [],
      summary: "Investigate the selected implementation concern.",
    });
  });

  it("keeps only selected messages and renders a worker handoff", () => {
    const artifact = buildWorkflowContextArtifact({
      parent,
      policy: "selected-messages",
      selectedMessageIds: new Set(["selected"]),
    });

    expect(artifact.messages).toEqual([
      expect.objectContaining({ messageId: "selected", text: "Use this scoped handoff." }),
    ]);
    expect(renderWorkflowContextArtifact(artifact)).toContain(
      "[assistant] Use this scoped handoff.",
    );
    expect(renderWorkflowContextArtifact(artifact)).not.toContain("Do not expose");
  });
});
