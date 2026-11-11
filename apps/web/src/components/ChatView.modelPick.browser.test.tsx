import { createMemoryHistory } from "@tanstack/react-router";
import { ProviderInstanceId } from "@t3tools/contracts";
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
  const stored = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const thread = { ...threadWithHistory("thread-model-pick", 1), modelSelection: stored };
  const aliasThread = {
    ...threadWithHistory("thread-model-alias", 1),
    modelSelection: { ...stored, model: "gpt-5-codex" },
  };
  using _environment = installFakeEnvironment([thread, aliasThread], { acceptCommands: true });
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

  const modelSets = () =>
    dispatchedCommands().filter((command) => command.type === "thread.model-selection.set");

  // With no options remembered in this browser, the thread's own model keeps its stored ones.
  await page.getByRole("button", { name: "GPT-5.4", exact: true }).click();
  await page.getByRole("option", { name: /GPT-5\.4/ }).click();
  await vi.waitFor(() =>
    expect(modelSets()).toEqual([
      expect.objectContaining({ threadId: thread.id, modelSelection: stored }),
    ]),
  );

  // The picker stays open beside its effort column.
  await page.getByRole("option", { name: /GPT-5\.5/ }).click();
  await vi.waitFor(() =>
    expect(modelSets().at(-1)).toEqual(
      expect.objectContaining({
        threadId: thread.id,
        modelSelection: { instanceId: "codex", model: "gpt-5.5" },
      }),
    ),
  );

  // A thread stored under an alias keeps its options when its canonical model is picked.
  await userEvent.keyboard("{Escape}");
  await router.navigate({ href: `/${ENVIRONMENT_ID}/${aliasThread.id}` });
  await expect.element(page.getByText("Answer 0 for thread-model-alias.")).toBeVisible();
  await page.getByRole("button", { name: "GPT-5.4", exact: true }).click();
  await page.getByRole("option", { name: /GPT-5\.4/ }).click();
  await vi.waitFor(() =>
    expect(modelSets().at(-1)).toEqual(
      expect.objectContaining({ threadId: aliasThread.id, modelSelection: stored }),
    ),
  );
});
