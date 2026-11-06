import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
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

// Its own file: the app's shell subscription outlives a test, and it must list this thread.
it("a model picked for an existing thread reaches the server before any message is sent", async () => {
  const thread = threadWithHistory("thread-model-pick", 1);
  using _environment = installFakeEnvironment([thread], { acceptCommands: true });
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
  await expect.element(page.getByText("Answer 0 for thread-model-pick.")).toBeVisible();

  const threadKey = scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, thread.id));
  const modelSets = () =>
    dispatchedCommands().filter((command) => command.type === "thread.model-selection.set");

  // Every explicit pick waits for acceptance, even when the optimistic shell already shows it.
  await page.getByRole("button", { name: "GPT-5.4", exact: true }).click();
  await page.getByRole("option", { name: /GPT-5\.4/ }).click();
  await vi.waitFor(() =>
    expect(useComposerDraftStore.getState().draftsByThreadKey[threadKey]).toBeUndefined(),
  );
  expect(modelSets()).toEqual([
    expect.objectContaining({
      threadId: thread.id,
      modelSelection: expect.objectContaining({ instanceId: "codex", model: "gpt-5.4" }),
    }),
  ]);

  // The picker stays open after a pick.
  await page.getByRole("option", { name: /GPT-5\.5/ }).click();
  await vi.waitFor(() =>
    expect(modelSets().slice(1)).toEqual([
      expect.objectContaining({
        threadId: thread.id,
        modelSelection: expect.objectContaining({ instanceId: "codex", model: "gpt-5.5" }),
      }),
    ]),
  );
  // The accepted pick leaves the draft, and the thread shows it until its event arrives.
  await vi.waitFor(() =>
    expect(useComposerDraftStore.getState().draftsByThreadKey[threadKey]).toBeUndefined(),
  );
  await expect.element(page.getByRole("button", { name: "GPT-5.5", exact: true })).toBeVisible();
});
