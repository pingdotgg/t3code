import { MessageId, RunId } from "@t3tools/contracts";
import { type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import type { TimelineEntry } from "../../session-logic";
import { ThreadActivityAnnouncer } from "./ThreadActivityAnnouncer";

const run = RunId.make("run-1");
const at = "2026-01-01T00:00:00.000Z";

const message = (id: string, role: "user" | "assistant", streaming = false): TimelineEntry => ({
  kind: "message",
  id,
  createdAt: at,
  message: {
    id: MessageId.make(id),
    role,
    text: id,
    runId: role === "assistant" ? run : null,
    streaming,
    createdAt: at,
    updatedAt: at,
  },
});
const command = (program: string): TimelineEntry => ({
  kind: "work",
  id: program,
  createdAt: at,
  entry: {
    id: program,
    createdAt: at,
    runId: run,
    label: program,
    tone: "tool",
    itemType: "command_execution",
    command: program,
    toolLifecycleStatus: "inProgress",
  },
});
const prompt = message("prompt", "user");

const announcer = (props: Partial<ComponentProps<typeof ThreadActivityAnnouncer>>) => (
  <ThreadActivityAnnouncer
    threadKey="thread-1"
    status="working"
    requestId={null}
    runId={run}
    runStatus="running"
    detailBehind={false}
    level="everything"
    entries={[prompt]}
    workspaceRoot={undefined}
    {...props}
  />
);

const regions = (container: HTMLElement) => {
  const [detail, status] = container.querySelectorAll<HTMLElement>('[aria-live="polite"]');
  return { detail: detail!, status: status! };
};

describe("ThreadActivityAnnouncer", () => {
  it("drops a waiting step once the agent has moved on", async () => {
    // The announcer reads no route.
    await using screen = await render(announcer({ status: "idle", runStatus: "completed" }), {
      router: false,
    });
    const { detail, status } = regions(screen.container);
    {
      // Restored before the assertions, which poll on real timers.
      using _timers = fakeTimers();
      await screen.rerender(announcer({}));
      await screen.rerender(announcer({ entries: [prompt, command("git")] }));
      await screen.rerender(
        announcer({ entries: [prompt, command("git"), message("reply", "assistant", true)] }),
      );
      await act(() => vi.advanceTimersByTime(5_000));
    }

    await expect.element(status).toHaveTextContent("Working");
    await expect.element(detail).toBeEmptyDOMElement();
  });

  it("holds a waiting step while the thread's detail is behind, then reads it", async () => {
    // The announcer reads no route.
    await using screen = await render(announcer({ status: "idle", runStatus: "completed" }), {
      router: false,
    });
    const { detail } = regions(screen.container);
    const entries = [prompt, command("git")];
    const heard: string[] = [];
    {
      // Restored before the assertion, which polls on real timers.
      using _timers = fakeTimers();
      await screen.rerender(announcer({}));
      await screen.rerender(announcer({ entries }));
      await screen.rerender(announcer({ entries, detailBehind: true }));
      await act(() => vi.advanceTimersByTime(5_000));
      heard.push(detail.textContent);
      await screen.rerender(announcer({ entries }));
      await act(() => vi.advanceTimersByTime(2_000));
    }

    expect(heard).toEqual([""]);
    await expect.element(detail).toHaveTextContent("Running git");
  });

  it("keeps a message beside the status that follows it, then reads the newest step", async () => {
    // The announcer reads no route.
    await using screen = await render(announcer({ status: "idle", runStatus: "completed" }), {
      router: false,
    });
    const { detail, status } = regions(screen.container);
    const entries = [prompt, message("Checking the repo", "assistant"), command("git")];
    const heard: Array<[status: string, detail: string]> = [];
    using _timers = fakeTimers();
    for (const props of [
      {},
      { entries },
      { entries, status: "approval", requestId: "request-1" },
      { entries: [...entries, command("rg")] },
    ] satisfies ReadonlyArray<Partial<ComponentProps<typeof ThreadActivityAnnouncer>>>) {
      await screen.rerender(announcer(props));
      heard.push([status.textContent, detail.textContent]);
    }
    await act(() => vi.advanceTimersByTime(2_000));
    heard.push([status.textContent, detail.textContent]);

    expect(heard).toEqual([
      ["Working", ""],
      ["Working", "T3 Code: Checking the repo"],
      ["Needs approval", "T3 Code: Checking the repo"],
      ["Needs approval", "T3 Code: Checking the repo"],
      ["Needs approval", "Running rg"],
    ]);
  });

  it("reads a status that lands with a message as the message's last sentence", async () => {
    // The announcer reads no route.
    await using screen = await render(announcer({ status: "idle", runStatus: "completed" }), {
      router: false,
    });
    const { detail, status } = regions(screen.container);
    await screen.rerender(announcer({}));
    await screen.rerender(
      announcer({
        entries: [prompt, message("Checking the repo", "assistant"), command("git")],
        status: "approval",
        requestId: "request-1",
      }),
    );

    await expect.element(detail).toHaveTextContent("T3 Code: Checking the repo. Needs approval");
    await expect.element(status).toHaveTextContent("Working");
  });
});
