import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import * as primaryAuth from "~/environments/primary/auth";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("~/environments/primary/auth", { spy: true });
vi.mock("~/components/ThreadRouteView", () => ({ ThreadRouteView: () => null }));

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

it("keeps sidebar search results while opening threads until explicitly cleared", async () => {
  const first = threadWithHistory("search-first", 1);
  const second = threadWithHistory("search-second", 1);
  using _environment = installFakeEnvironment([first, second]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  using _auth = vi
    .spyOn(primaryAuth, "resolveInitialServerAuthGateState")
    .mockResolvedValue({ status: "authenticated" });
  await page.viewport(1400, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${second.id}`] }),
  );
  await router.load();
  // AppRoot owns the application router.
  await using screen = await render(<AppRoot router={router} />, { router: false });
  const search = screen.getByRole("combobox", { name: "Search threads" });
  const results = screen.getByRole("listbox", { name: "Thread search results" });
  await vi.waitFor(() => {
    expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${second.id}`);
  });
  await userEvent.fill(search, "search-");
  await expect.element(results.getByRole("option")).toHaveLength(2);

  await results.getByRole("option", { name: new RegExp(first.title) }).click();
  await vi.waitFor(() => {
    expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${first.id}`);
  });
  await expect.element(search).toHaveValue("search-");
  await expect.element(results.getByRole("option")).toHaveLength(2);

  await search.click();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await vi.waitFor(() => {
    expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${second.id}`);
  });
  await expect.element(search).toHaveValue("search-");
  await expect.element(results.getByRole("option")).toHaveLength(2);

  await screen.getByRole("button", { name: "Clear thread search" }).click();
  await expect.element(search).toHaveValue("");
  await expect.element(results).not.toBeInTheDocument();

  await userEvent.fill(search, "search-");
  await expect.element(results.getByRole("option")).toHaveLength(2);
  await userEvent.keyboard("{Escape}");
  await expect.element(search).toHaveValue("");
  await expect.element(results).not.toBeInTheDocument();
});
