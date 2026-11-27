import { createMemoryHistory } from "@tanstack/react-router";
import { MessageId, ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import appCss from "~/index.css?inline";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  answerRpc,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";
import { closeThreadFind, openThreadFindOnQuery, useThreadFindStore } from "./chat/threadFindStore";

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

it("dismisses a previous sidebar message find when the sidebar search changes or clears", async () => {
  await page.viewport(1400, 900);
  using styles = new DisposableStack();
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  styles.defer(() => style.remove());
  const thread = threadWithHistory("sidebar-search", 1);
  const messageId = MessageId.make(`${thread.id}-assistant-0`);
  using _environment = installFakeEnvironment([thread], {
    config: { threadFind: true },
  });
  using _searchThreads = answerRpc(
    ORCHESTRATION_V2_WS_METHODS.searchThreads,
    ({ query }: { readonly query: string }) =>
      Effect.succeed({
        matches:
          query === "Sidebar.tsx"
            ? [
                {
                  threadId: thread.id,
                  projectId: PROJECT_ID,
                  source: "assistant",
                  snippet: "checked Sidebar.tsx",
                  messageId,
                  messageCreatedAt: null,
                },
              ]
            : [],
      }),
  );
  using _searchThread = answerRpc(ORCHESTRATION_V2_WS_METHODS.searchThread, () =>
    Effect.succeed({
      snapshotSequence: 1,
      totalMatches: 1,
      activeIndex: 0,
      match: { entryId: messageId, runId: thread.runs[0]!.id, occurrence: 0 },
    }),
  );
  closeThreadFind();
  using _find = { [Symbol.dispose]: closeThreadFind };
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const search = screen.getByRole("combobox", { name: "Search threads" });
  await expect.element(search).toBeVisible();
  const find = screen.getByRole("searchbox", { name: "Find in thread" });
  const assertFindClosed = async () => {
    await expect.element(find).not.toBeInTheDocument();
    expect(CSS.highlights.has("t3-thread-find")).toBe(false);
    expect(CSS.highlights.has("t3-thread-find-active")).toBe(false);
  };
  const selectMessageResult = async () => {
    await userEvent.fill(search, "Sidebar.tsx");
    await userEvent.click(screen.getByRole("option", { name: new RegExp(thread.title) }));
    await expect.element(find).toHaveValue("Sidebar.tsx");
    await vi.waitFor(() => expect(CSS.highlights.get("t3-thread-find-active")?.size).toBe(1));
  };
  const openMessageFind = () =>
    act(() =>
      openThreadFindOnQuery(`${ENVIRONMENT_ID}:${thread.id}`, { query: "Sidebar.tsx" }, "sidebar"),
    );

  await selectMessageResult();
  await userEvent.fill(search, thread.title);
  await assertFindClosed();

  await openMessageFind();
  await userEvent.click(screen.getByRole("button", { name: "Clear thread search" }));
  await expect.element(search).toHaveValue("");
  await assertFindClosed();

  await userEvent.fill(search, thread.title);
  await openMessageFind();
  await userEvent.click(search);
  await userEvent.keyboard("{Escape}");
  await expect.element(search).toHaveValue("");
  await assertFindClosed();

  await userEvent.fill(search, thread.title);
  await openMessageFind();
  await userEvent.clear(search);
  await expect.element(search).toHaveValue("");
  await assertFindClosed();

  await selectMessageResult();
  expect(useThreadFindStore.getState().query).toBe("Sidebar.tsx");
});
