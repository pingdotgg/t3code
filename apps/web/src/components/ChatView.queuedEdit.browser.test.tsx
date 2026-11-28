import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const PROVIDER_WITH_LIMITS = {
  ...CODEX_PROVIDER,
  usageLimits: { checkedAt: "2026-03-17T19:12:28.000Z", windows: [] },
};

// Its own file: the app's server config subscription outlives a test, and it must offer limits.
it("updating a queued message to /usage-limits saves it as the queued text", async () => {
  const history = threadWithHistory("thread-queued-limits", 2);
  const [active, queued] = history.runs;
  const thread = {
    ...history,
    runs: [
      { ...active!, status: "running" as const, completedAt: null },
      { ...queued!, status: "queued" as const, startedAt: null, completedAt: null },
    ],
    items: history.items.slice(0, 2),
  };
  using _environment = installFakeEnvironment([thread], {
    acceptCommands: true,
    providers: [PROVIDER_WITH_LIMITS],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });

  await page.getByRole("button", { name: "Edit queued message" }).click();
  const editor = page.getByTestId("composer-editor");
  await expect.element(editor).toHaveTextContent("Queued message");
  await userEvent.click(editor);
  await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}/usage-limits");
  await expect.element(editor).toHaveTextContent("/usage-limits");
  await page.getByRole("button", { name: "Update queued message" }).click();

  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({
        type: "queued-run.edit",
        threadId: thread.id,
        runId: queued!.id,
        text: "/usage-limits",
      }),
    ),
  );
});
