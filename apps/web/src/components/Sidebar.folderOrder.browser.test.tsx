import { createMemoryHistory } from "@tanstack/react-router";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
// The thread route loads ChatView lazily; its first transform would eat the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useUiStateStore } from "~/uiStateStore";
import {
  dispatchedCommands,
  emitThreadShell,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";
import { THREAD_CONTEXT_DROP_EVENT } from "./chat/threadContextDrag";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const pointerEvent = (type: string, { x, y }: { readonly x: number; readonly y: number }) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
  });

const pressPoint = (element: Element) => {
  const bounds = element.getBoundingClientRect();
  return { x: bounds.x + 16, y: bounds.y + bounds.height / 2 };
};

/** Presses `element`, moves in steps to `to`, and releases there. */
async function dragTo(element: Element, to: { readonly x: number; readonly y: number }) {
  const from = pressPoint(element);
  await act(() => {
    element.dispatchEvent(pointerEvent("pointerdown", from));
    document.dispatchEvent(pointerEvent("pointermove", { x: from.x, y: from.y + 10 }));
  });
  for (const step of [0.5, 1]) {
    await act(() =>
      document.dispatchEvent(
        pointerEvent("pointermove", {
          x: from.x + (to.x - from.x) * step,
          y: from.y + (to.y - from.y) * step,
        }),
      ),
    );
  }
  await act(() => document.dispatchEvent(pointerEvent("pointerup", to)));
}

const folderHeader = (name: string) => page.getByRole("button", { name: new RegExp(`^${name}`) });

/** The titles of a folder's thread rows, top to bottom. */
function folderTitles(name: string) {
  const folder = folderHeader(name).element().closest("[data-sidebar-folder-group]")!;
  return Array.from(
    folder.querySelectorAll('[data-testid="sidebar-row-folder"]'),
    (row) => row.textContent?.match(/Thread [a-z]+/)?.[0],
  );
}

const folderNames = () =>
  Array.from(
    document.querySelectorAll("[data-sidebar-folder-group] button[data-sidebar-row]"),
    (button) => button.textContent?.match(/render|other/)?.[0],
  );

const threadRow = (title: string) =>
  page.getByTestId("sidebar-row-folder").filter({ hasText: title }).element();

const activeReorders = () =>
  dispatchedCommands().filter((command) => command.type === "thread.active.reorder");

// One flow, since the app keeps its environment connection for the whole file.
it("keeps boring folders and their threads where the user put them", async () => {
  await page.viewport(1400, 900);
  const alpha = threadWithHistory("alpha", 1);
  const bravo = threadWithHistory("bravo", 1);
  const charlie = threadWithHistory("charlie", 1);
  const delta = { ...threadWithHistory("delta", 1), projectId: ProjectId.make("project-other") };
  using _environment = installFakeEnvironment([alpha, bravo, charlie, delta], {
    acceptCommands: true,
    extraProjects: [{ id: delta.projectId, title: "other" }],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    boringSidebarEnabled: true,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  using _order = { [Symbol.dispose]: () => useUiStateStore.setState({ projectOrder: [] }) };
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${alpha.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(folderHeader("other")).toBeVisible();
  await vi.waitFor(() =>
    expect(folderTitles("render")).toEqual(["Thread alpha", "Thread bravo", "Thread charlie"]),
  );

  // A thread only reorders within its own folder.
  await dragTo(threadRow("Thread delta"), pressPoint(threadRow("Thread alpha")));
  expect(folderTitles("other")).toEqual(["Thread delta"]);
  expect(folderTitles("render")).toEqual(["Thread alpha", "Thread bravo", "Thread charlie"]);
  expect(activeReorders()).toEqual([]);

  await dragTo(threadRow("Thread charlie"), pressPoint(threadRow("Thread alpha")));
  await vi.waitFor(() =>
    expect(folderTitles("render")).toEqual(["Thread charlie", "Thread alpha", "Thread bravo"]),
  );
  const [reorder] = activeReorders();
  expect(activeReorders()).toEqual([
    expect.objectContaining({ threadId: ThreadId.make("charlie") }),
  ]);
  // The server saves the key and sends the thread back with it.
  await emitThreadShell(charlie, {
    activeOrderKey: reorder?.type === "thread.active.reorder" ? reorder.orderKey : null,
  });

  // Dragging a folder row out of the list still mentions it in the composer.
  const composer = document.querySelector("[data-thread-context-drop]")!;
  const mentioned = vi.fn();
  composer.addEventListener(THREAD_CONTEXT_DROP_EVENT, (event) =>
    mentioned((event as CustomEvent).detail),
  );
  await dragTo(threadRow("Thread bravo"), pressPoint(composer));
  expect(mentioned).toHaveBeenCalledWith([{ environmentId: ENVIRONMENT_ID, threadId: bravo.id }]);
  expect(activeReorders()).toHaveLength(1);

  // Sending in the bottom thread and its run finishing only change its status, not its place.
  const sentAt = DateTime.makeUnsafe("2026-03-18T09:00:00.000Z");
  const sent = {
    latestUserMessageAt: sentAt,
    latestUserAuthoredMessageAt: sentAt,
    latestRunRequestedAt: sentAt,
    latestRunStartedAt: sentAt,
  };
  await emitThreadShell(bravo, { ...sent, status: "running", updatedAt: sentAt });
  await vi.waitFor(() => expect(threadRow("Thread bravo").textContent).toMatch(/Working/));
  expect(folderTitles("render")).toEqual(["Thread charlie", "Thread alpha", "Thread bravo"]);
  const finishedAt = DateTime.makeUnsafe("2026-03-18T09:05:00.000Z");
  await emitThreadShell(bravo, {
    ...sent,
    status: "completed",
    latestRunCompletedAt: finishedAt,
    updatedAt: finishedAt,
  });
  await vi.waitFor(() => expect(threadRow("Thread bravo").textContent).toMatch(/Done/));
  expect(folderTitles("render")).toEqual(["Thread charlie", "Thread alpha", "Thread bravo"]);

  // A dragged folder keeps its new place, which needs the manual project order.
  const [top, bottom] = folderNames() as [string, string];
  await dragTo(folderHeader(bottom).element(), pressPoint(folderHeader(top).element()));
  await vi.waitFor(() => expect(folderNames()).toEqual([bottom, top]));
  expect(getClientSettings().sidebarProjectSortOrder).toBe("manual");
  expect(useUiStateStore.getState().projectOrder[0]).toBe(`${ENVIRONMENT_ID}:/workspace/${bottom}`);
});
