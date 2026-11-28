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

// Its own file: the app's server config subscription outlives a test, and it must offer usage limits.
it("Enter in a queued-message edit saves /usage-limits as its text", async () => {
  const history = threadWithHistory("limits-edit", 2);
  const queued = { ...history.runs[1]!, status: "queued" as const, completedAt: null };
  const thread = { ...history, runs: [history.runs[0]!, queued] };
  using _environment = installFakeEnvironment([thread], {
    acceptCommands: true,
    providers: [
      {
        ...CODEX_PROVIDER,
        slashCommands: [{ name: "usage-limits" }],
        usageLimits: {
          checkedAt: "2026-03-17T19:12:28.000Z",
          windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 40 }],
        },
      },
    ],
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
  await expect.element(page.getByRole("button", { name: "Update queued message" })).toBeVisible();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}/usage-limits");
  const suggestion = page.getByRole("option", { name: /^\/usage-limits/ });
  await expect.element(suggestion).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.element(suggestion).not.toBeInTheDocument();
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({ type: "queued-run.edit", runId: queued.id, text: "/usage-limits" }),
    ),
  );
});
