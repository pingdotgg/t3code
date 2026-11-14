import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
// The thread route loads ChatView lazily; its first transform would eat the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { act, fakeTimers, render } from "../../../test/render";
import { readThreadVisits } from "./recentThreadVisitsStore";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// The defaults are desktop-only; the browser test binds the same keys everywhere.
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "ctrl+tab", command: "thread.recent.next" },
    { key: "ctrl+shift+tab", command: "thread.recent.previous" },
    { key: "ctrl+s", command: "composer.stash" },
  ]);
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(keybindings) };
});

const [threadA, threadB, threadC] = ["thread-a", "thread-b", "thread-c"].map((name) =>
  threadWithHistory(name, 1),
) as [
  ReturnType<typeof threadWithHistory>,
  ReturnType<typeof threadWithHistory>,
  ReturnType<typeof threadWithHistory>,
];
const pathOf = (thread: { readonly id: string }) => `/${ENVIRONMENT_ID}/${thread.id}`;
const threadKeyOf = (thread: { readonly id: ThreadId }) =>
  scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, thread.id));

/** Visits A, B and C in turn, then focuses C's composer. */
async function renderAfterVisitingThreeThreads() {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1400, 900);
  const router = getRouter(createMemoryHistory({ initialEntries: [pathOf(threadA)] }));
  await router.load();
  await using stack = new AsyncDisposableStack();
  stack.use(
    await render(<AppRoot router={router} />, {
      // AppRoot brings its own router.
      router: false,
    }),
  );
  for (const thread of [threadA, threadB, threadC]) {
    if (thread !== threadA) {
      await act(() =>
        router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: ENVIRONMENT_ID, threadId: thread.id },
        }),
      );
    }
    await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
  }
  const composer = page.getByTestId("composer-editor");
  await userEvent.click(composer);
  return { router, composer, app: stack.move() };
}

const recentThreads = () => page.getByRole("listbox", { name: "Recent threads" });

it("taps back to the previous thread without drawing the list", async () => {
  using _environment = installFakeEnvironment([threadA, threadB, threadC]);
  const { router, app } = await renderAfterVisitingThreeThreads();
  await using _app = app;
  using _timers = fakeTimers();

  await userEvent.keyboard("{Control>}{Tab}");
  await act(() => vi.advanceTimersByTime(199));
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  await userEvent.keyboard("{/Control}");
  await act(() => vi.advanceTimersByTime(300));

  await vi.waitFor(() => expect(router.history.location.pathname).toBe(pathOf(threadB)));
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});

it("shows the list on a held second Tab and opens the highlighted thread on release", async () => {
  using _environment = installFakeEnvironment([threadA, threadB, threadC]);
  const { router, composer, app } = await renderAfterVisitingThreeThreads();
  await using _app = app;
  await userEvent.keyboard("draft");
  const keysReachingComposer: string[] = [];
  composer.element().addEventListener("keydown", (event) => {
    if (event instanceof KeyboardEvent) keysReachingComposer.push(event.key);
  });

  await userEvent.keyboard("{Control>}{Tab}{Tab}");
  await expect.element(recentThreads()).toBeVisible();
  // The composer's stash scope registers after the switcher's, so it would run first.
  await userEvent.keyboard("s");
  expect(keysReachingComposer).toEqual(["Control"]);
  expect(composer.element().textContent).toContain("draft");
  const options = recentThreads().getByRole("option");
  await expect.element(options.nth(2)).toHaveAttribute("aria-selected", "true");
  await expect.element(options.nth(2)).toHaveAccessibleName(/Thread thread-a/);
  await userEvent.keyboard("{/Control}");

  await vi.waitFor(() => expect(router.history.location.pathname).toBe(pathOf(threadA)));
  await expect.element(recentThreads()).not.toBeInTheDocument();
});

it("cancels on Escape, window blur and a press before the list shows", async () => {
  using _environment = installFakeEnvironment([threadA, threadB, threadC]);
  const { router, app } = await renderAfterVisitingThreeThreads();
  await using _app = app;

  await userEvent.keyboard("{Control>}{Tab}{Tab}");
  await expect.element(recentThreads()).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(recentThreads()).not.toBeInTheDocument();
  await userEvent.keyboard("{/Control}");
  expect(router.history.location.pathname).toBe(pathOf(threadC));

  await userEvent.keyboard("{Control>}{Tab}{Tab}");
  await expect.element(recentThreads()).toBeVisible();
  await act(() => window.dispatchEvent(new Event("blur")));
  await expect.element(recentThreads()).not.toBeInTheDocument();
  await userEvent.keyboard("{/Control}");
  expect(router.history.location.pathname).toBe(pathOf(threadC));

  using _timers = fakeTimers();
  await userEvent.keyboard("{Control>}{Tab}");
  await act(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  await userEvent.keyboard("{/Control}");
  expect(router.history.location.pathname).toBe(pathOf(threadC));
});

it("returns to the starting thread on two taps before the first switch resolves", async () => {
  using _environment = installFakeEnvironment([threadA, threadB, threadC]);
  const { router, app } = await renderAfterVisitingThreeThreads();
  await using _app = app;
  const paths: string[] = [];
  using _history = {
    [Symbol.dispose]: router.history.subscribe(({ location }) => paths.push(location.pathname)),
  };
  const tap = () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", code: "Tab", ctrlKey: true, bubbles: true }),
    );
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control", code: "ControlLeft" }));
  };

  let visitedBeforeResolving: readonly string[] = [];
  await act(() => {
    tap();
    visitedBeforeResolving = readThreadVisits().slice(0, 2);
    tap();
  });

  // The visit counts as soon as the switch starts, so the second tap sees where the first went.
  expect(visitedBeforeResolving).toEqual([threadKeyOf(threadB), threadKeyOf(threadC)]);

  await vi.waitFor(() => expect(paths).toEqual([pathOf(threadB), pathOf(threadC)]));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe(pathOf(threadC)));
});
