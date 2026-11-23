import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { WS_METHODS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import {
  selectRightPanelUnseenGroups,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  answerRpc,
  emitTerminalMetadata,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

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

function resetRightPanelDrawer() {
  useRightPanelStore.setState({
    byThreadKey: {},
    terminalDrawer: { open: false, height: 280 },
    unseenGroupsByThreadKey: {},
    terminalServerObservationByThreadKey: {},
    claimedTerminalIdsByThreadKey: {},
  });
}

function terminalRpcs() {
  const opened: string[] = [];
  const closed: string[] = [];
  const attached: string[] = [];
  const open = answerRpc(WS_METHODS.terminalOpen, (input: { terminalId: string }) => {
    opened.push(input.terminalId);
    return Effect.never;
  });
  const close = answerRpc(WS_METHODS.terminalClose, (input: { terminalId: string }) => {
    closed.push(input.terminalId);
    return Effect.void;
  });
  const attach = answerRpc(WS_METHODS.terminalAttach, (input: { terminalId: string }) => {
    attached.push(input.terminalId);
    return Stream.never;
  });
  return {
    opened,
    closed,
    attached,
    [Symbol.dispose]() {
      open[Symbol.dispose]();
      close[Symbol.dispose]();
      attach[Symbol.dispose]();
    },
  };
}

function terminalSummary(threadId: string, terminalId: string) {
  return {
    threadId,
    terminalId,
    cwd: "/workspace",
    worktreePath: null,
    status: "running" as const,
    pid: 10,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: "",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function renderThreadApp(threads: Parameters<typeof installFakeEnvironment>[0]) {
  await using stack = new AsyncDisposableStack();
  await page.viewport(1280, 800);
  stack.use(
    installFakeEnvironment(threads, {
      keybindings: mergeWithDefaultKeybindings(
        compileResolvedKeybindingsConfig([{ key: "ctrl+j", command: "terminal.toggle" }]),
      ),
    }),
  );
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threads[0]!.id}`] }),
  );
  await router.load();
  // AppRoot brings its own router.
  stack.use(await render(<AppRoot router={router} />, { router: false }));
  const moved = stack.move();
  return { router, [Symbol.asyncDispose]: () => moved.disposeAsync() };
}

it("terminal.toggle with the panel closed opens the panel with the drawer and launches one terminal only when the thread has none", async () => {
  resetRightPanelDrawer();
  const thread = threadWithHistory("thread-terminal-toggle", 1);
  using rpcs = terminalRpcs();
  await using _app = await renderThreadApp([thread]);
  const ref = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  const composer = page.getByTestId("composer-editor");

  await composer.click();
  await userEvent.keyboard("{Control>}j{/Control}");
  await vi.waitFor(() => expect(useRightPanelStore.getState().terminalDrawer.open).toBe(true));
  await vi.waitFor(() => expect(rpcs.opened).toHaveLength(1));
  const opened = useRightPanelStore.getState();
  expect(selectThreadRightPanelState(opened.byThreadKey, ref).isOpen).toBe(true);
  expect(opened.terminalDrawer.open).toBe(true);
  await expect.element(page.getByRole("button", { name: "Collapse terminal" })).toBeVisible();

  await composer.click();
  await userEvent.keyboard("{Control>}j{/Control}");
  await vi.waitFor(() => expect(useRightPanelStore.getState().terminalDrawer.open).toBe(false));
  expect(rpcs.opened).toHaveLength(1);
  expect(rpcs.closed).toEqual([]);
});

it("terminals from the old chat drawer appear as drawer sub-tabs without closing any session", async () => {
  resetRightPanelDrawer();
  const thread = threadWithHistory("thread-terminal-adopt", 1);
  using rpcs = terminalRpcs();
  await using _app = await renderThreadApp([thread]);
  const ref = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  await vi.waitFor(() =>
    emitTerminalMetadata({
      type: "snapshot",
      terminals: [terminalSummary(thread.id, "default"), terminalSummary(thread.id, "term-2")],
    }),
  );

  await vi.waitFor(() =>
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["terminal:default", "terminal:term-2"]),
  );
  const state = useRightPanelStore.getState();
  expect(state.terminalDrawer.open).toBe(false);
  expect(selectRightPanelUnseenGroups(state, ref)).toContain("terminal");
  expect(rpcs.closed).toEqual([]);
  expect(rpcs.opened).toEqual([]);

  // terminal.toggle reuses the adopted sessions instead of launching a new shell.
  await page.getByTestId("composer-editor").click();
  await userEvent.keyboard("{Control>}j{/Control}");
  await vi.waitFor(() => expect(useRightPanelStore.getState().terminalDrawer.open).toBe(true));
  expect(rpcs.opened).toEqual([]);
});

it("switching to a thread with no terminals while the drawer is open launches nothing, and terminal.toggle collapses its empty drawer", async () => {
  resetRightPanelDrawer();
  const first = threadWithHistory("thread-terminal-first", 1);
  const second = threadWithHistory("thread-terminal-second", 1);
  const firstRef = scopeThreadRef(ENVIRONMENT_ID, first.id);
  useRightPanelStore.getState().openTerminal(firstRef, "existing");
  useRightPanelStore.getState().open(scopeThreadRef(ENVIRONMENT_ID, second.id), "diff");
  using rpcs = terminalRpcs();
  await using app = await renderThreadApp([first, second]);

  await act(() => app.router.navigate({ to: `/${ENVIRONMENT_ID}/${second.id}` }));
  await expect.element(page.getByText("No terminal")).toBeVisible();
  expect(useRightPanelStore.getState().terminalDrawer.open).toBe(true);
  expect(rpcs.opened).toEqual([]);
  expect(rpcs.closed).toEqual([]);

  await page.getByTestId("composer-editor").click();
  await userEvent.keyboard("{Control>}j{/Control}");
  await vi.waitFor(() => expect(useRightPanelStore.getState().terminalDrawer.open).toBe(false));
  expect(rpcs.opened).toEqual([]);
});

it("switching away and back keeps a thread's drawer terminal attached, even through a thread with the panel closed", async () => {
  resetRightPanelDrawer();
  const first = threadWithHistory("thread-terminal-kept", 1);
  const second = threadWithHistory("thread-terminal-other", 1);
  const firstRef = scopeThreadRef(ENVIRONMENT_ID, first.id);
  useRightPanelStore.getState().openTerminal(firstRef, "kept");
  // A sub-tab from an earlier session, so it mounts once, when the server lists it.
  useRightPanelStore.setState({ claimedTerminalIdsByThreadKey: {} });
  using rpcs = terminalRpcs();
  await using app = await renderThreadApp([first, second]);
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  await vi.waitFor(() =>
    emitTerminalMetadata({ type: "snapshot", terminals: [terminalSummary(first.id, "kept")] }),
  );
  await vi.waitFor(() => expect(rpcs.attached).toEqual(["kept"]));

  await act(() => app.router.navigate({ to: `/${ENVIRONMENT_ID}/${second.id}` }));
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  await act(() => app.router.navigate({ to: `/${ENVIRONMENT_ID}/${first.id}` }));
  await expect.element(page.getByRole("button", { name: "Collapse terminal" })).toBeVisible();
  await vi.waitFor(() =>
    expect(
      document.querySelector(
        '[data-right-panel-terminal-body] [data-terminal-owner="right-panel"]',
      ),
    ).not.toBeNull(),
  );
  expect(rpcs.attached).toEqual(["kept"]);
  expect(rpcs.opened).toEqual([]);
});

it("with the drawer showing a terminal, returning to the window and opening the panel keep the composer focused", async () => {
  resetRightPanelDrawer();
  const thread = threadWithHistory("thread-terminal-focus", 1);
  const ref = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  useRightPanelStore.getState().openTerminal(ref, "focus");
  useRightPanelStore.getState().close(ref);
  using _rpcs = terminalRpcs();
  await using _app = await renderThreadApp([thread]);
  const composer = page.getByTestId("composer-editor");
  await composer.click();
  await expect.element(composer).toHaveFocus();

  await userEvent.keyboard("{Control>}{Alt>}b{/Alt}{/Control}");
  await vi.waitFor(() =>
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).isOpen).toBe(
      true,
    ),
  );
  await vi.waitFor(() =>
    expect(
      document.querySelector(
        '[data-right-panel-terminal-body] [data-terminal-owner="right-panel"]',
      ),
    ).not.toBeNull(),
  );
  await expect.element(composer).toHaveFocus();

  (document.activeElement as HTMLElement | null)?.blur();
  window.dispatchEvent(new FocusEvent("focus"));
  await expect.element(composer).toHaveFocus();
});

it("a saved sub-tab the server no longer lists starts no shell and offers Restart", async () => {
  resetRightPanelDrawer();
  const first = threadWithHistory("thread-terminal-plain", 1);
  const second = threadWithHistory("thread-terminal-stale", 1);
  const secondRef = scopeThreadRef(ENVIRONMENT_ID, second.id);
  // Saved by an earlier session: no claim from this client, and the server lists nothing.
  useRightPanelStore.getState().openTerminal(secondRef, "stale");
  useRightPanelStore.setState({ claimedTerminalIdsByThreadKey: {} });
  using rpcs = terminalRpcs();
  await using app = await renderThreadApp([first, second]);

  await act(() => app.router.navigate({ to: `/${ENVIRONMENT_ID}/${second.id}` }));
  const restart = page.getByRole("button", { name: "Restart terminal" });
  await expect.element(restart).toBeVisible();
  expect(rpcs.attached).toEqual([]);
  expect(rpcs.opened).toEqual([]);
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, secondRef).surfaces.map(
      (surface) => surface.id,
    ),
  ).toEqual(["terminal:stale"]);

  await restart.click();
  await vi.waitFor(() => expect(rpcs.opened).toEqual(["stale"]));
  await vi.waitFor(() => expect(rpcs.attached).toEqual(["stale"]));
  expect(rpcs.closed).toEqual([]);
});
