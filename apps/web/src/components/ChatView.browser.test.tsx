import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { NoProjectsHero } from "~/components/NoProjectsHero";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

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

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});

it("marks the window's main areas with the region names plugin styles target", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-regions");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make("thread-regions"),
    });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();

  // Plugins style these by name, so renaming or moving one breaks them. The sidebar, thread
  // details, terminal and command palette tests check the other names the SDK README lists.
  expect(document.querySelector('[data-slot="sidebar-inset"]')).toHaveAttribute(
    "data-t3-region",
    "main",
  );
  await expect
    .element(page.getByRole("region", { name: "Conversation" }))
    .toHaveAttribute("data-t3-region", "timeline");

  // A region sits on the element that paints its area, so a plugin's plain rule recolors it.
  const pluginSheet = document.createElement("style");
  pluginSheet.textContent = '[data-t3-region="composer"] { background: rgb(1, 2, 3); }';
  document.head.append(pluginSheet);
  using _pluginSheet = { [Symbol.dispose]: () => pluginSheet.remove() };
  const composerBox = document.querySelector("[data-chat-composer-main-surface]");
  expect(composerBox && getComputedStyle(composerBox).backgroundColor).toBe("rgb(1, 2, 3)");

  await userEvent.click(page.getByRole("button", { name: "Toggle right panel" }));
  await expect
    .element(page.getByRole("region", { name: "Workspace panel" }))
    .toHaveAttribute("data-t3-region", "right-panel");

  await router.navigate({ to: "/settings/general" });
  await expect
    .element(page.getByRole("region", { name: "Settings content" }))
    .toHaveAttribute("data-t3-region", "settings");
  await expect
    .element(page.getByRole("navigation", { name: "Settings sections" }))
    .toHaveAttribute("data-t3-region", "settings-nav");

  await router.navigate({ to: "/pull-requests", search: { involvement: "all", state: "open" } });
  await expect
    .element(page.getByRole("region", { name: "Pull requests" }))
    .toHaveAttribute("data-t3-region", "pull-requests");
});

it("marks the home page with the region name plugin styles target", async () => {
  await using _screen = await render(<NoProjectsHero />);
  const homeTitle = page.getByText("What should we work on?");
  await expect.element(homeTitle).toBeInTheDocument();
  expect(homeTitle.element().closest("[data-t3-region]")).toHaveAttribute("data-t3-region", "home");
});
