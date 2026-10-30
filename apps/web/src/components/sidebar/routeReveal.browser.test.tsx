import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { PERSISTED_STATE_KEY, useUiStateStore } from "../../uiStateStore";
import {
  type SidebarRouteReveal,
  useActiveRowReveal,
  useSidebarScopeRoutePersistence,
} from "./routeReveal";

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
          style={{ height: ROW_HEIGHT_PX }}
        >
          {key}
        </li>
      ))}
    </ul>
  );
}

const rowKeys = (count: number) => Array.from({ length: count }, (_, index) => `thread-${index}`);
const newReveal = (): SidebarRouteReveal => ({ observedKey: null, pendingKey: null });

function PersistScopeRoute({ routeKey }: { readonly routeKey: string | null }) {
  useSidebarScopeRoutePersistence({ routeKey, widensScope: false });
  return null;
}

it("releases the persisted group hold after navigation leaves its thread", async () => {
  const previous = useUiStateStore.getState();
  const persisted = localStorage.getItem(PERSISTED_STATE_KEY);
  using _state = {
    [Symbol.dispose]() {
      useUiStateStore.setState(previous);
      if (persisted === null) localStorage.removeItem(PERSISTED_STATE_KEY);
      else localStorage.setItem(PERSISTED_STATE_KEY, persisted);
    },
  };
  useUiStateStore.setState({ projectCollections: [{ id: "group", name: "Group", members: [] }] });
  useUiStateStore.getState().selectProjectCollection("group", "env:t");
  await using screen = await render(<PersistScopeRoute routeKey="env:t" />, { router: "/env/t" });
  expect(useUiStateStore.getState().sidebarScopeRouteKey).toBe("env:t");
  await screen.rerender(<PersistScopeRoute routeKey={null} />);
  expect(useUiStateStore.getState().sidebarScopeRouteKey).toBe("env:t");
  for (const [navigation, routeKey] of [
    [{ to: "/$environmentId/$threadId", params: { environmentId: "env", threadId: "u" } }, "env:u"],
    [{ to: "/" }, null],
    [{ to: "/draft/$draftId", params: { draftId: "new" } }, null],
    [{ to: "/settings" }, null],
  ] as const) {
    await act(() =>
      screen.router!.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: "env", threadId: "t" },
      }),
    );
    await screen.rerender(<PersistScopeRoute routeKey="env:t" />);
    await act(() => useUiStateStore.getState().selectProjectCollection("group", "env:t"));
    await act(() => screen.router!.navigate(navigation));
    await screen.rerender(<PersistScopeRoute routeKey={routeKey} />);
    expect(useUiStateStore.getState().sidebarScopeRouteKey).toBeNull();
    expect(JSON.parse(localStorage.getItem(PERSISTED_STATE_KEY) ?? "{}")).toMatchObject({
      sidebarScopeRouteKey: null,
    });
    expect(useUiStateStore.getState().activeProjectCollectionId).toBe("group");
  }
});

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
});
