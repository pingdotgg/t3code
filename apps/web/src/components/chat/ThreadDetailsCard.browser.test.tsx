import { StrictMode, createRef } from "react";
import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { PopoverCreateHandle } from "../ui/popover";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { THREAD_DETAILS_CARD_GAP } from "./threadDetailsCardLayout";
import { ThreadRepositorySections } from "./ThreadRepositorySections";
import { useThreadRepositoryPinsStore } from "../../threadRepositoryPinsStore";
import "../../index.css";

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: () => ({ data: null, error: null }) as never,
}));

const threadA: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread-a"),
};
const threadB: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread-b"),
};
const container = { width: 1200, height: 800 };
const placement = {
  x: 928 - THREAD_DETAILS_CARD_GAP,
  y: 0,
  right: THREAD_DETAILS_CARD_GAP,
  width: 272,
  height: 400,
} as const;

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
  issueListRows = 0,
}: {
  threadRef: ScopedThreadRef;
  inline: boolean;
  fixture: ReturnType<typeof setup>;
  /** Rows of 100px that no squeeze cuts. */
  rows?: number;
  /** Rows of 100px in an automations list. */
  automationRows?: number;
  /** Rows of 100px that expanded server lists add. */
  serverOverflowRows?: number;
  /** Rows of 100px that expanded linked issues add. */
  issueListRows?: number;
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
          measureDetailsCard: () => {},
          detailsCardTopInset: 0,
          preferredDetailsCard: placement,
          detailsCardPlacement: inline ? placement : null,
        }}
      >
        <ThreadDetailsCard threadRef={threadRef} anchor={fixture.anchor} handle={fixture.handle}>
          {() => (
            <>
              <p style={{ height: rows * 100 }}>Details for {threadRef.threadId}</p>
              {automationRows > 0 ? (
                <section data-thread-automations-panel style={{ height: automationRows * 100 }} />
              ) : null}
              {serverOverflowRows > 0 ? (
                <div
                  data-thread-details-server-overflow
                  style={{ height: serverOverflowRows * 100 }}
                />
              ) : null}
              {issueListRows > 0 ? (
                <div data-thread-details-issue-list style={{ height: issueListRows * 100 }} />
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

it("scrolls content that has no section to cut", async () => {
  using fixture = setup();
  useRightPanelStore.getState().setThreadPanelOpen(threadB, "inline", true);
  await using screen = await render(<Card threadRef={threadB} inline fixture={fixture} rows={6} />);
  const card = page.getByRole("region", { name: "Thread details" });
  const viewport = card.element().querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
  expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
  viewport.scrollTop = viewport.scrollHeight;
  expect(viewport.scrollTop).toBeGreaterThan(0);
  await expect
    .element(page.getByRole("button", { name: "Show all details" }))
    .not.toBeInTheDocument();

  await screen.rerender(<Card threadRef={threadB} inline fixture={fixture} rows={2} />);
  await vi.waitFor(() => expect(viewport.scrollHeight).toBe(viewport.clientHeight));
});

it("keeps every row when many automations make the content tall", async () => {
  using fixture = setup();
  useRightPanelStore.getState().setThreadPanelOpen(threadB, "inline", true);
  await using _screen = await render(
    <Card threadRef={threadB} inline fixture={fixture} rows={2} automationRows={6} />,
  );
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Show all details" }))
    .not.toBeInTheDocument();
});

it("keeps every row while expanded server rows overflow", async () => {
  using fixture = setup();
  useRightPanelStore.getState().setThreadPanelOpen(threadB, "inline", true);
  await using _screen = await render(
    <Card threadRef={threadB} inline fixture={fixture} rows={2} serverOverflowRows={4} />,
  );
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Show all details" }))
    .not.toBeInTheDocument();
});

it("cuts whole sections when squeezed and shows them again from the reveal row", async () => {
  using fixture = setup();
  useRightPanelStore.getState().setThreadPanelOpen(threadB, "inline", true);
  await using _screen = await render(
    <StrictMode>
      <ChatCanvasContext
        value={{
          container,
          lane: { padding: 48, minChatWidth: 640 },
          layout: resolveChatCanvasLayout({ container, preview: null }),
          previewKey: null,
          measureDetailsCard: () => {},
          detailsCardTopInset: 0,
          preferredDetailsCard: placement,
          detailsCardPlacement: placement,
        }}
      >
        <ThreadDetailsCard threadRef={threadB} anchor={fixture.anchor} handle={fixture.handle}>
          {({ cut, reveal }) => (
            <section>
              <p style={{ height: 150 }}>Details for thread-b</p>
              <div data-thread-details-unit="usage" hidden={cut.has("usage")}>
                <p style={{ height: 150 }}>Limits</p>
              </div>
              <div data-thread-details-unit="cards" hidden={cut.has("cards")}>
                <ThreadDetailsControl style={{ height: 150 }}>Lineage</ThreadDetailsControl>
              </div>
              {reveal}
            </section>
          )}
        </ThreadDetailsCard>
      </ChatCanvasContext>
    </StrictMode>,
  );
  const card = page.getByRole("region", { name: "Thread details" });
  const viewport = card.element().querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
  const lineage = page.getByRole("button", { name: "Lineage" });
  const more = page.getByRole("button", { name: "Show all details" });
  // 450px of sections in 400px: the last section goes whole, the rest fits with the reveal row.
  await expect.element(more).toBeVisible();
  await expect.element(lineage).not.toBeInTheDocument();
  await expect.element(page.getByText("Limits")).toBeVisible();
  expect(viewport.scrollHeight).toBe(viewport.clientHeight);

  await more.click();
  await expect.element(lineage).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Show fewer" }))
    .toHaveAttribute("aria-expanded", "true");

  await lineage.click();
  await act(() =>
    lineage.element().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  await expect.element(lineage).not.toBeInTheDocument();
  await expect.element(more).toHaveFocus();
});

it("focuses the requested branch row when opening the details popover", async () => {
  using fixture = setup();
  const branch = createRef<HTMLButtonElement>();
  await using _screen = await render(
    <ThreadDetailsCard
      threadRef={threadB}
      anchor={fixture.anchor}
      handle={fixture.handle}
      onFocusRequest={() => {
        branch.current?.focus();
        return true;
      }}
    >
      {() => <ThreadDetailsControl ref={branch}>feature/current</ThreadDetailsControl>}
    </ThreadDetailsCard>,
  );
  await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadB, "popover", true));
  await expect.element(page.getByRole("button", { name: "feature/current" })).toHaveFocus();
});

it("keeps every row while expanded issue rows overflow", async () => {
  using fixture = setup();
  useRightPanelStore.getState().setThreadPanelOpen(threadB, "inline", true);
  await using _screen = await render(
    <Card threadRef={threadB} inline fixture={fixture} rows={2} issueListRows={6} />,
  );
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Show all details" }))
    .not.toBeInTheDocument();
});

it("keeps the repository list reachable after Show more expands it", async () => {
  using fixture = setup();
  useRightPanelStore.getState().setThreadPanelOpen(threadB, "inline", true);
  for (let index = 1; index <= 30; index++) {
    useThreadRepositoryPinsStore
      .getState()
      .pin(threadB, { repositoryPath: `/repos/repo-${index}`, name: `repo-${index}` });
  }
  await using _screen = await render(
    <StrictMode>
      <ChatCanvasContext
        value={{
          container,
          lane: { padding: 48, minChatWidth: 640 },
          layout: resolveChatCanvasLayout({ container, preview: null }),
          previewKey: null,
          measureDetailsCard: () => {},
          detailsCardTopInset: 0,
          preferredDetailsCard: placement,
          detailsCardPlacement: placement,
        }}
      >
        <ThreadDetailsCard threadRef={threadB} anchor={fixture.anchor} handle={fixture.handle}>
          {() => (
            <ThreadRepositorySections
              environmentId={threadB.environmentId}
              threadId={threadB.threadId}
              projectId={ProjectId.make("project")}
              isServerThread={false}
              threadCwd="/repos"
              taskFolder={null}
              reachesTracked
              onTaskFolderChange={() => {}}
              explainsEmpty={false}
              showActions={false}
            />
          )}
        </ThreadDetailsCard>
      </ChatCanvasContext>
    </StrictMode>,
  );
  await page.getByRole("button", { name: "Show 26 more" }).click();

  await expect.element(page.getByRole("button", { name: "Show fewer" })).toBeVisible();
});
