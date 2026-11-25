import "~/index.css";

import { StrictMode } from "react";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { PopoverCreateHandle } from "../ui/popover";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { ThreadDetailsIssueRows } from "./ThreadDetailsIssueRows";

vi.mock(import("~/state/issues"), () => ({ useLinkedIssueDetail: () => null }));

const threadA: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread-a"),
};
const threadB: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread-b"),
};
const container = { width: 1200, height: 800 };
const placement = { x: 908, y: 0, right: 12, width: 280, height: 400 } as const;

function setup() {
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  const anchor = document.createElement("div");
  document.body.append(anchor);
  return {
    anchor: { current: anchor },
    handle: PopoverCreateHandle(),
    [Symbol.dispose]: () => anchor.remove(),
  };
}

const popoverOpen = (threadRef: ScopedThreadRef) =>
  selectThreadPanelOpen(
    useRightPanelStore.getState().threadPanelVisibilityByThreadKey,
    threadRef,
    "popover",
  );

function Card({
  threadRef,
  inline,
  fixture,
  rows = 1,
  automationRows = 0,
  serverOverflowRows = 0,
  issues = [],
}: {
  threadRef: ScopedThreadRef;
  inline: boolean;
  fixture: ReturnType<typeof setup>;
  /** Rows of 100px shown at full density. Compact always takes 50px. */
  rows?: number;
  /** Rows of 100px in an automations list shown at full density. */
  automationRows?: number;
  /** Rows of 100px that expanded server lists add, which density ignores. */
  serverOverflowRows?: number;
  /** Linked issues, rendered at every density like the Version Control section. */
  issues?: ReadonlyArray<ThreadIssueLink>;
}) {
  return (
    // The web root renders in StrictMode, which re-runs ref callbacks on every mount.
    <StrictMode>
      <ChatCanvasContext
        value={{
          container,
          lane: { padding: 48, minChatWidth: 640 },
          layout: resolveChatCanvasLayout({ container, preview: null }),
          previewKey: null,
          registerTimeline: () => {},
          measureDetailsCard: () => {},
          detailsCardTopInset: 0,
          preferredDetailsCard: placement,
          detailsCardPlacement: inline ? placement : null,
        }}
      >
        <ThreadDetailsCard
          threadRef={threadRef}
          anchor={fixture.anchor}
          handle={fixture.handle}
          contentKey={String(rows)}
        >
          {(density) => (
            <>
              <p style={{ height: density === "full" ? rows * 100 : 50 }}>
                Details for {threadRef.threadId}
              </p>
              {density === "full" && automationRows > 0 ? (
                <section data-thread-automations-panel style={{ height: automationRows * 100 }} />
              ) : null}
              {density === "full" && serverOverflowRows > 0 ? (
                <div
                  data-thread-details-server-overflow
                  style={{ height: serverOverflowRows * 100 }}
                />
              ) : null}
              {issues.length > 0 ? (
                <ThreadDetailsIssueRows links={issues} threadRef={threadRef} />
              ) : null}
            </>
          )}
        </ThreadDetailsCard>
      </ChatCanvasContext>
    </StrictMode>
  );
}

it("stays open once opened", async () => {
  using fixture = setup();
  await using _screen = await render(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadB, "popover", true));
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
  expect(popoverOpen(threadB)).toBe(true);
});

it("closes a popup left open when the card switches inline, and reopens from the flag", async () => {
  using fixture = setup();
  await using screen = await render(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  const setOpen = (open: boolean) =>
    act(() => useRightPanelStore.getState().setThreadPanelOpen(threadB, "popover", open));
  await setOpen(true);
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();

  useRightPanelStore.getState().setThreadPanelOpen(threadB, "inline", false);
  await screen.rerender(<Card threadRef={threadB} inline fixture={fixture} />);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();
  await setOpen(false);

  await screen.rerender(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();
  await setOpen(true);
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
});

it("does not reopen the popover when the card returns from inline mode", async () => {
  using fixture = setup();
  await using screen = await render(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadB, "popover", true));
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();

  useRightPanelStore.getState().setThreadPanelOpen(threadB, "inline", false);
  await screen.rerender(<Card threadRef={threadB} inline fixture={fixture} />);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();

  await screen.rerender(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();
  expect(popoverOpen(threadB)).toBe(false);
});

it("removes the leaving thread's popup on a thread switch", async () => {
  using fixture = setup();
  await using screen = await render(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadB, "popover", true));
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();

  await screen.rerender(<Card threadRef={threadA} inline={false} fixture={fixture} />);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();
  await expect.element(page.getByText("Details for thread-a")).not.toBeInTheDocument();
});

it("reopens after a normal close", async () => {
  using fixture = setup();
  await using _screen = await render(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  const setOpen = (open: boolean) =>
    act(() => useRightPanelStore.getState().setThreadPanelOpen(threadB, "popover", open));
  await setOpen(true);
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
  await setOpen(false);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();
  await setOpen(true);
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
});

it("returns to full density when hidden items make the content fit", async () => {
  using fixture = setup();
  await using screen = await render(<Card threadRef={threadB} inline fixture={fixture} rows={6} />);
  const card = page.getByRole("region", { name: "Thread details" });
  await expect.element(card).toHaveAttribute("data-density", "compact");

  await screen.rerender(<Card threadRef={threadB} inline fixture={fixture} rows={2} />);
  await expect.element(card).toHaveAttribute("data-density", "full");
});

it("keeps full density when many automations make the content tall", async () => {
  using fixture = setup();
  await using _screen = await render(
    <Card threadRef={threadB} inline fixture={fixture} rows={2} automationRows={6} />,
  );
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
  await expect
    .element(page.getByRole("region", { name: "Thread details" }))
    .toHaveAttribute("data-density", "full");
});

it("stays full while expanded server rows overflow", async () => {
  using fixture = setup();
  await using _screen = await render(
    <Card threadRef={threadB} inline fixture={fixture} rows={2} serverOverflowRows={4} />,
  );
  await expect
    .element(page.getByRole("region", { name: "Thread details" }))
    .toHaveAttribute("data-density", "full");
});

it("stays full while expanded linked issues overflow, and after they collapse", async () => {
  using fixture = setup();
  const issues = Array.from({ length: 7 }, (_, index): ThreadIssueLink => ({
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "owner/repo",
    key: String(100 + index),
    projectId: ProjectId.make("project"),
    url: `https://github.com/owner/repo/issues/${100 + index}`,
    source: "manual",
    linkedAt: "2026-11-25T00:00:00.000Z",
    displayKey: `#${100 + index}`,
    title: `Linked issue ${index}`,
  }));
  await using screen = await render(
    <Card threadRef={threadB} inline fixture={fixture} rows={2} issues={issues} />,
  );
  const card = page.getByRole("region", { name: "Thread details" });
  await expect.element(page.getByText("Linked issue 0")).toBeVisible();
  await expect.element(card).toHaveAttribute("data-density", "full");

  await screen.getByRole("button", { name: "Show 6 more" }).click();
  await expect.element(page.getByText("Linked issue 6")).toBeVisible();
  await expect.element(card).toHaveAttribute("data-density", "full");

  await screen.getByRole("button", { name: "Show less" }).click();
  await expect.element(page.getByText("Linked issue 6")).not.toBeInTheDocument();
  await expect.element(card).toHaveAttribute("data-density", "full");
});
