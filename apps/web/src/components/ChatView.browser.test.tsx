import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useRightPanelStore } from "~/rightPanelStore";
import { WELCOME_GUIDE_SEEN_STORAGE_KEY } from "./onboarding/WelcomeGuideDialog";
import { seedWhatsNewForNewInstall, WHATS_NEW_SEEN_STORAGE_KEY } from "./onboarding/WhatsNewDialog";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer, Effect, Stream] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
    import("effect/Effect"),
    import("effect/Stream"),
  ]);
  const configWithSideChats = (config: import("@t3tools/contracts").ServerConfig) => ({
    ...config,
    environment: {
      ...config.environment,
      capabilities: { ...config.environment.capabilities, sideChats: true, lessonSideChats: true },
    },
  });
  return {
    ...actual,
    layer: Layer.succeed(actual.ConnectionDriver, {
      ...fakeDriver,
      connect: (...args: Parameters<FakeDriver["connect"]>) =>
        fakeDriver.connect(...args).pipe(
          Effect.map((lease) => ({
            ...lease,
            session: {
              ...lease.session,
              subscribeServerConfig: () =>
                lease.session
                  .subscribeServerConfig()
                  .pipe(
                    Stream.map((event) =>
                      event.type === "snapshot"
                        ? { ...event, config: configWithSideChats(event.config) }
                        : event,
                    ),
                  ),
            },
          })),
        ),
    }),
  };
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

it("offers lesson side chats while hiding upstream side chat entry points", async () => {
  const seenAt = localStorage.getItem(WELCOME_GUIDE_SEEN_STORAGE_KEY);
  localStorage.setItem(WELCOME_GUIDE_SEEN_STORAGE_KEY, JSON.stringify("2026-01-01T00:00:00.000Z"));
  seedWhatsNewForNewInstall();
  using _welcomeGuide = {
    [Symbol.dispose]: () => {
      localStorage.removeItem(WHATS_NEW_SEEN_STORAGE_KEY);
      if (seenAt === null) localStorage.removeItem(WELCOME_GUIDE_SEEN_STORAGE_KEY);
      else localStorage.setItem(WELCOME_GUIDE_SEEN_STORAGE_KEY, seenAt);
    },
  };
  const thread = threadWithHistory("lesson-side-chats", 1);
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  useRightPanelStore.setState({ byThreadKey: {} });
  await page.viewport(1400, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(screen.getByTestId("composer-editor")).toBeVisible();
  await expect.element(screen.getByText("Answer 0 for lesson-side-chats.")).toBeVisible();
  await userEvent.fill(screen.getByTestId("composer-editor"), "/");
  await expect.element(page.getByRole("listbox", { name: "Commands" })).toBeVisible();
  await expect.element(page.getByText("/side", { exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByText("/btw", { exact: true })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");

  await act(() =>
    useRightPanelStore.getState().open(scopeThreadRef(ENVIRONMENT_ID, thread.id), "files"),
  );
  await userEvent.click(screen.getByRole("button", { name: "Add panel surface" }));
  await expect.element(page.getByRole("menuitem", { name: /^Terminal/ })).toBeVisible();
  await expect
    .element(page.getByRole("menuitem", { name: /^Side chat(?:\s|$)/ }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("menuitem", { name: /^Side-chat map/ })).toBeVisible();
});
