import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

// Its own file: the connection keeps the first provider snapshot it sees for the whole file.
const { showInteractionModeToggle: _declared, ...UNDECLARED_PROVIDER } = CODEX_PROVIDER;

it("a provider that does not declare plan support gets no toggle and sends in build mode", async () => {
  const thread = { ...threadWithHistory("mode-undeclared", 1), interactionMode: "plan" as const };
  using _environment = installFakeEnvironment([thread], {
    acceptCommands: true,
    providers: [UNDECLARED_PROVIDER],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    planModeEnabled: true,
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  // AppRoot brings its own router.
  await using _app = await render(<AppRoot router={router} />, { router: false });

  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Plan mode" })).not.toBeInTheDocument();
  await page.getByTestId("composer-editor").click();
  await cdp().send("Input.insertText", { text: "Work through the next step" });
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => {
    expect(dispatchedCommands()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thread.interaction-mode.set",
          threadId: thread.id,
          interactionMode: "default",
        }),
        expect.objectContaining({ type: "message.dispatch", threadId: thread.id }),
      ]),
    );
  });
});
