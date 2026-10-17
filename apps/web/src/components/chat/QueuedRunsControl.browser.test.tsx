import { act, createRef, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
  canOperate: true,
  runCommand: (async () => undefined) as (command: unknown, input: unknown) => Promise<unknown>,
}));

vi.mock(import("@t3tools/client-runtime/state/thread-workflows"), async (importOriginal) => ({
  ...(await importOriginal()),
  deriveThreadQueueWorkflowState: (() => state.workflow) as never,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadProjection: (() => state.projection) as never,
}));

vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: (() => state.canOperate) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: ((command: unknown) => (input: unknown) =>
    state.runCommand(command, input)) as never,
}));

vi.mock(import("../../assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrls: ((_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`)) as never,
}));

import { threadEnvironment } from "../../state/threads";
import { formatShortTimestamp } from "../../timestampFormat";
import { QueuedRunsControl, type QueuedRunsControlHandle } from "./QueuedRunsControl";

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  state.canOperate = true;
  state.runCommand = async () => undefined;
});

const baseProps = {
  environmentId: "environment:test" as never,
  optimisticMessages: [],
  threadId: "thread:test" as never,
  editingRunId: null,
  onEditQueuedRun: () => undefined,
  onCancelEdit: () => undefined,
} satisfies ComponentProps<typeof QueuedRunsControl>;

async function render(props: Partial<ComponentProps<typeof QueuedRunsControl>> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<QueuedRunsControl {...baseProps} {...props} />));
  return container;
}

const labels = (container: HTMLElement) =>
  [...container.querySelectorAll("[aria-label]")].map((element) =>
    element.getAttribute("aria-label"),
  );

describe("QueuedRunsControl automatic completion delivery", () => {
  it("does not render a queue control when only hidden delivery remains", async () => {
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

    const view = await render();

    expect(view.childElementCount).toBe(0);
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

  it("renders an attachment thumbnail on the queued row", async () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const view = await render();

    expect(view.querySelector("img")?.getAttribute("src")).toBe("https://assets.test/attachment-1");
    expect(view.textContent).toContain("Queued with a screenshot");
    expect(labels(view)).toContain("Edit queued message");
    expect(labels(view)).toContain("Reorder queued message (drag, or press the arrow keys)");
    expect(labels(view)).not.toContain("Move queued message up");
  });

  it("drops the optimistic pending row once the projection holds its message", async () => {
    state.projection = {
      projection: { messages: [{ id: "message:acknowledged", text: "hello" }] },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const view = await render({
      optimisticMessages: [
        {
          id: "message:acknowledged" as never,
          inputIntent: "queued_turn",
          text: "hello",
          attachments: [],
        },
      ],
    });

    expect(view.childElementCount).toBe(0);
  });

  it("keeps the original queued message visible while editing", async () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const view = await render({ editingRunId: "run:queued" as never });

    expect(view.textContent).toContain("Queued with a screenshot");
  });
});

describe("QueuedRunsControl scheduled messages", () => {
  const releaseAt = "2026-10-17T15:42:00.000Z";
  const scheduledThenOrdinary = (
    queuedRuns: ReadonlyArray<"scheduled" | "ordinary"> = ["scheduled", "ordinary"],
  ) => ({
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: queuedRuns.map((kind) => ({
      run: {
        id: `run:${kind}`,
        userMessageId: `message:${kind}`,
        ...(kind === "scheduled" ? { releaseAt } : {}),
      },
      text: kind === "scheduled" ? "Check the deploy" : "Run the tests",
      attachments: [],
    })),
  });

  const row = (view: HTMLElement, text: string) =>
    [...view.querySelectorAll("li")].find((item) => item.textContent?.includes(text))!;
  const rowButton = (item: HTMLElement, name: string) =>
    [...item.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === name || button.ariaLabel === name,
    );

  it("shows when a scheduled message sends and releases it early with Send now", async () => {
    let finishRelease = () => {};
    const commands = vi.fn((command: unknown) =>
      command === threadEnvironment.releaseQueuedRun
        ? new Promise<void>((resolve) => {
            finishRelease = resolve;
          })
        : Promise.resolve(),
    );
    state.runCommand = commands;
    state.projection = { projection: { messages: [] } };
    state.workflow = scheduledThenOrdinary();

    const view = await render();
    const scheduled = row(view, "Check the deploy");
    const ordinary = row(view, "Run the tests");

    expect(scheduled.textContent).toContain(
      `Sends at ${formatShortTimestamp(releaseAt, "locale")}`,
    );
    expect(rowButton(scheduled, "Steer")).toBeUndefined();
    expect(ordinary.textContent).not.toContain("Sends at");
    expect(rowButton(ordinary, "Send now")).toBeUndefined();

    await userEvent.click(rowButton(scheduled, "Send now")!);

    expect(commands).toHaveBeenCalledExactlyOnceWith(threadEnvironment.releaseQueuedRun, {
      environmentId: "environment:test",
      input: { threadId: "thread:test", runId: "run:scheduled" },
    });
    // Nothing else in the queue can act on it while the release is in flight.
    expect(rowButton(scheduled, "Send now")!.disabled).toBe(true);
    expect(rowButton(ordinary, "Steer")!.disabled).toBe(true);
    expect(rowButton(scheduled, "Remove queued message")!.disabled).toBe(true);

    await act(async () => finishRelease());
    expect(rowButton(ordinary, "Steer")!.disabled).toBe(false);
  });

  it("keeps Send now unavailable without permission to operate the thread", async () => {
    state.canOperate = false;
    state.projection = { projection: { messages: [] } };
    state.workflow = scheduledThenOrdinary();

    const view = await render();

    expect(rowButton(row(view, "Check the deploy"), "Send now")!.disabled).toBe(true);
  });

  it("steers past a scheduled message so the shortcut cannot send it early", async () => {
    const commands = vi.fn(async () => undefined);
    state.runCommand = commands;
    state.projection = { projection: { messages: [] } };
    state.workflow = scheduledThenOrdinary();
    const ref = createRef<QueuedRunsControlHandle>();

    await render({ ref });
    await act(async () => expect(ref.current!.steerNext(false)).toBe(true));

    expect(commands).toHaveBeenCalledExactlyOnceWith(threadEnvironment.promoteQueuedRun, {
      environmentId: "environment:test",
      input: { threadId: "thread:test", queuedRunId: "run:ordinary", targetRunId: "run:active" },
    });

    commands.mockClear();
    state.workflow = scheduledThenOrdinary(["scheduled"]);
    const onlyScheduled = createRef<QueuedRunsControlHandle>();
    await render({ ref: onlyScheduled });

    expect(onlyScheduled.current!.steerNext(false)).toBe(false);
    expect(commands).not.toHaveBeenCalled();
  });
});
