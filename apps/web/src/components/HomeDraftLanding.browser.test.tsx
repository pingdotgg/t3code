import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { AppRoot } from "~/AppRoot";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import stylesheet from "~/index.css?inline";
import { getRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

const configVisible = Atom.make(false).pipe(Atom.keepAlive);

vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentServerConfigsAtom: Atom.make((get) => {
      if (!get(configVisible)) return new Map();
      const config = get(actual.environmentServerConfigsAtom).get(ENVIRONMENT_ID);
      if (config === undefined) return new Map();
      return new Map([
        [
          ENVIRONMENT_ID,
          {
            ...config,
            settings: { ...config.settings, defaultThreadEnvMode: "worktree" as const },
          },
        ],
      ]);
    }),
  };
});

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (original) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    original<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

function setup() {
  appAtomRegistry.set(configVisible, false);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  return installFakeEnvironment([threadWithHistory("home-settings", 1)]);
}

it("stays recoverable while the most recent project's settings are unavailable", async () => {
  using _environment = setup();
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  await using screen = await render(
    <>
      <style>{stylesheet}</style>
      <AppRoot router={router} />
    </>,
    { router: false },
  );

  const retry = screen.getByRole("button", { name: "Try again", exact: true });
  await expect.element(retry).toBeVisible();
  await expect.element(screen.getByText("Environment settings are still loading")).toBeVisible();
  expect(router.state.location.pathname).toBe("/");

  await retry.click();
  await expect.element(retry).toBeVisible();
  expect(router.state.location.pathname).toBe("/");

  await act(() => appAtomRegistry.set(configVisible, true));
  await vi.waitFor(() => expect(router.state.location.pathname).toMatch(/^\/draft\//));
  const draftId = DraftId.make(
    decodeURIComponent(router.state.location.pathname.split("/").at(-1)!),
  );
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.envMode).toBe("worktree");
});
