import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { Sidebar, SidebarProvider, SidebarTrigger, useSidebar } from "../ui/sidebar";
import { type SidebarRouteReveal, useActiveRowReveal } from "./routeReveal";

const ROW_HEIGHT_PX = 24;

function RevealList(props: {
  readonly reveal: SidebarRouteReveal;
  readonly rowKeys: ReadonlyArray<string>;
  readonly activeKey: string | null;
}) {
  const revealActiveRow = useActiveRowReveal(props.reveal, props.activeKey);
  return (
    <ul aria-label="Threads" style={{ height: ROW_HEIGHT_PX * 4, overflowY: "auto", margin: 0 }}>
      {props.rowKeys.map((key) => (
        <li
          key={key}
          ref={key === props.activeKey ? (row) => revealActiveRow(row, key) : undefined}
          tabIndex={-1}
          style={{ height: ROW_HEIGHT_PX }}
        >
          {key}
        </li>
      ))}
    </ul>
  );
}

// Reads the sidebar context like the real thread list, so opening the sheet re-renders it.
function SheetRevealList(props: Parameters<typeof RevealList>[0]) {
  useSidebar();
  return <RevealList {...props} />;
}

const rowKeys = (count: number) => Array.from({ length: count }, (_, index) => `thread-${index}`);
const newReveal = (): SidebarRouteReveal => ({ observedKey: null, pendingKey: null });

describe("useActiveRowReveal", () => {
  it("scrolls an off-screen row into view when the route opens its thread", async () => {
    const reveal = newReveal();
    const keys = rowKeys(50);
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-0" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    const target = screen.getByText("thread-40", { exact: true });
    await expect.element(target).not.toBeInViewport();

    await screen.rerender(<RevealList reveal={reveal} rowKeys={keys} activeKey="thread-40" />);

    await expect.element(target).toBeInViewport();
  });

  it("leaves the list where it is when the user clicked the row that opened the thread", async () => {
    const reveal = newReveal();
    const keys = rowKeys(50);
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-0" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    await userEvent.hover(screen.getByText("thread-2", { exact: true }));
    // Even a no-op scroll forces a layout of the thread being opened.
    using scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");

    await screen.rerender(<RevealList reveal={reveal} rowKeys={keys} activeKey="thread-2" />);

    await vi.waitFor(() => expect(reveal.pendingKey).toBeNull());
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("reveals a focused row scrolled out of view when the keyboard opens its thread", async () => {
    const reveal = newReveal();
    const keys = rowKeys(50);
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-0" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    const target = screen.getByText("thread-40", { exact: true });
    target.element().focus({ preventScroll: true });
    await expect.element(target).not.toBeInViewport();

    await screen.rerender(<RevealList reveal={reveal} rowKeys={keys} activeKey="thread-40" />);

    await expect.element(target).toBeInViewport();
  });

  it("reveals the active row when it mounts after the shells arrive", async () => {
    const reveal = newReveal();
    // The route already names the thread, but its environment's shells have not
    // listed it yet.
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={rowKeys(5)} activeKey="thread-40" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    await expect.element(screen.getByText("thread-4", { exact: true })).toBeInTheDocument();

    await screen.rerender(
      <RevealList reveal={reveal} rowKeys={rowKeys(50)} activeKey="thread-40" />,
    );

    await expect.element(screen.getByText("thread-40", { exact: true })).toBeInViewport();
  });

  it("reveals a thread reopened after a thread whose row never mounted", async () => {
    const reveal = newReveal();
    const keys = rowKeys(50);
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-40" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    const target = screen.getByText("thread-40", { exact: true });
    await expect.element(target).toBeInViewport();
    screen.getByRole("list", { name: "Threads" }).element().scrollTop = 0;
    await expect.element(target).not.toBeInViewport();

    // The route moves to a thread the list does not hold yet, then back.
    await screen.rerender(<RevealList reveal={reveal} rowKeys={keys} activeKey="thread-99" />);
    await screen.rerender(<RevealList reveal={reveal} rowKeys={keys} activeKey="thread-40" />);

    await expect.element(target).toBeInViewport();
  });

  it("reveals the open thread again when the sidebar remounts on the same route", async () => {
    const reveal = newReveal();
    const keys = rowKeys(50);
    {
      await using screen = await render(
        <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-40" />,
        // No router: the route arrives as the activeKey prop.
        { router: false },
      );
      await expect.element(screen.getByText("thread-40", { exact: true })).toBeInViewport();
    }

    // A remount starts the list at the top; the record outlives it with no reveal pending.
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-40" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    await expect.element(screen.getByText("thread-40", { exact: true })).toBeInViewport();
  });

  it("stops watching a hidden active row once it unmounts", async () => {
    const reveal = newReveal();
    using observe = vi.spyOn(ResizeObserver.prototype, "observe");
    using unobserve = vi.spyOn(ResizeObserver.prototype, "unobserve");
    using disconnect = vi.spyOn(ResizeObserver.prototype, "disconnect");
    await using screen = await render(
      <div hidden>
        <RevealList reveal={reveal} rowKeys={rowKeys(50)} activeKey="thread-40" />
      </div>,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    const row = screen.getByText("thread-40", { exact: true }).element();
    expect(observe).toHaveBeenCalledWith(row);

    // A widening viewport unmounts the closed sheet before it ever opens.
    await screen.rerender(<div hidden />);

    expect(
      unobserve.mock.calls.some(([target]) => target === row) || disconnect.mock.calls.length > 0,
    ).toBe(true);
  });

  it("reveals the open thread when the closed narrow sheet opens", async () => {
    await page.viewport(390, 844);
    const reveal = newReveal();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar>
          <SheetRevealList reveal={reveal} rowKeys={rowKeys(50)} activeKey="thread-40" />
        </Sidebar>
        <SidebarTrigger />
      </SidebarProvider>,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );

    await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));

    await expect.element(page.getByText("thread-40", { exact: true })).toBeInViewport();
  });
});
