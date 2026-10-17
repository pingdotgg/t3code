// @vitest-environment jsdom

import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
}));

vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: () => ({}) as never,
}));

vi.mock("@t3tools/client-runtime/state/thread-workflows", () => ({
  deriveThreadQueueWorkflowState: () => state.workflow,
}));

vi.mock("../../state/entities", () => ({
  useThreadProjection: () => state.projection,
}));

vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    cancelQueuedRun: Symbol("cancelQueuedRun"),
    promoteQueuedRun: Symbol("promoteQueuedRun"),
    reorderQueuedRun: Symbol("reorderQueuedRun"),
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => undefined,
}));

vi.mock("../../assets/assetUrls", () => ({
  useAssetUrls: (_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`),
}));

import { QueuedRunsControl } from "./QueuedRunsControl";

describe("QueuedRunsControl automatic completion delivery", () => {
  it("does not render a queue control when only hidden delivery remains", () => {
    state.projection = {
      projection: {
        messages: [
          {
            delegatedCompletion: {
              parentRunId: "run:parent",
              generation: 1,
              taskIds: ["task:child"],
            },
            id: "message:completion",
          },
        ],
      },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toBe("");
  });
});

describe("QueuedRunsControl attachments and edit mode", () => {
  const workflowWithAttachment = () => ({
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "Queued with a screenshot",
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 128,
          },
        ],
      },
    ],
  });

  it("renders an attachment thumbnail on the queued row", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toContain("https://assets.test/attachment-1");
    expect(html).toContain("Queued with a screenshot");
    expect(html).toContain("Edit queued message");
    expect(html).toContain("Reorder queued message");
    expect(html).not.toContain("Move queued message up");
  });

  it("drops the optimistic pending row once the projection holds its message", () => {
    state.projection = {
      projection: { messages: [{ id: "message:acknowledged", text: "hello" }] },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[
          {
            id: "message:acknowledged" as never,
            inputIntent: "queued_turn",
            text: "hello",
            attachments: [],
          },
        ]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toBe("");
  });

  it("keeps the original queued message visible while editing", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={"run:queued" as never}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toContain("Queued with a screenshot");
  });
});

describe("QueuedRunsControl assistant quotes", () => {
  const quote = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("environment:test"),
    threadId: ThreadId.make("thread:test"),
    messageId: MessageId.make("message:assistant"),
    text: "Cache the parsed config per worktree.",
    start: 0,
    end: 37,
    prefix: "",
    suffix: "",
  });
  const quoteAndText = `${quote}\n\nWhy per worktree?`;

  async function renderQuotedQueue(onEditQueuedRun: (request: unknown) => void) {
    state.projection = { projection: { messages: [] } };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [
        {
          run: { id: "run:quote-only", userMessageId: "message:quote-only" },
          text: quote,
          attachments: [],
        },
        {
          run: { id: "run:quote-and-text", userMessageId: "message:quote-and-text" },
          text: quoteAndText,
          attachments: [],
        },
      ],
    };
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueuedRunsControl
          environmentId={"environment:test" as never}
          optimisticMessages={[]}
          threadId={"thread:test" as never}
          editingRunId={null}
          onEditQueuedRun={onEditQueuedRun}
          onCancelEdit={() => undefined}
        />,
      );
    });
    const cleanup = async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    };
    return { container, cleanup };
  }

  it("previews quote-only and quote-plus-text items by their quoted text", async () => {
    const { container, cleanup } = await renderQuotedQueue(() => undefined);
    try {
      const [quoteOnlyRow, quoteAndTextRow] = container.querySelectorAll("li");

      expect(quoteOnlyRow?.textContent).toContain("Cache the parsed config per worktree.");
      expect(quoteAndTextRow?.textContent).toContain("Cache the parsed config per worktree.");
      expect(quoteAndTextRow?.textContent).toContain("Why per worktree?");
      expect(container.textContent).not.toContain("t3-citation:");
      expect(container.textContent).not.toContain("Assistant quote");
    } finally {
      await cleanup();
    }
  });

  it("edits the original message so the citation link survives", async () => {
    const onEditQueuedRun = vi.fn();
    const { container, cleanup } = await renderQuotedQueue(onEditQueuedRun);
    try {
      const editButton = container
        .querySelectorAll("li")[1]
        ?.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]');
      await act(async () => editButton?.click());

      expect(onEditQueuedRun).toHaveBeenCalledWith({
        runId: "run:quote-and-text",
        messageId: "message:quote-and-text",
        text: quoteAndText,
        attachments: [],
      });
    } finally {
      await cleanup();
    }
  });
});
