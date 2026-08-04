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
    editQueuedRun: Symbol("editQueuedRun"),
    promoteQueuedRun: Symbol("promoteQueuedRun"),
    reorderQueuedRun: Symbol("reorderQueuedRun"),
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => undefined,
}));

import { QueuedRunsControl } from "./QueuedRunsControl";

function buttonTag(html: string, ariaLabel: string) {
  return html.match(new RegExp(`<button[^>]*aria-label="${ariaLabel}"[^>]*>`))?.[0];
}

function buttonWithText(html: string, text: string) {
  return html.match(new RegExp(`<button[^>]*>[\\s\\S]*?${text}</button>`))?.[0];
}

function expectDisabled(button: string | undefined) {
  expect(button).toMatch(/\sdisabled(?:=|\s|>)/);
}

function expectEnabled(button: string | undefined) {
  expect(button).not.toMatch(/\sdisabled(?:=|\s|>)/);
}

describe("QueuedRunsControl automatic completion delivery", () => {
  it("locks server-owned delivery controls while keeping dismissal available", () => {
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
      queuedRuns: [
        {
          run: { id: "run:completion", userMessageId: "message:completion" },
          text: "A delegated task reached a terminal state.",
        },
      ],
    };

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
      />,
    );

    expect(html).toContain("Automatic completion delivery");
    expectDisabled(buttonTag(html, "Edit queued message"));
    expectDisabled(buttonTag(html, "Move queued message up"));
    expectDisabled(buttonTag(html, "Move queued message down"));
    expectDisabled(buttonWithText(html, "Steer"));
    expect(html).toContain("Automatic completion deliveries are always queued");
    expectEnabled(buttonTag(html, "Dismiss automatic completion delivery"));
  });
});
