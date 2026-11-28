import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
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
  emitThreadEvent,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

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

// One input event, where typing a key at a time takes seconds on a loaded CI runner.
const insertText = (text: string) => cdp().send("Input.insertText", { text });

it("/usage-limits saved as a queued-message edit updates the queued message", async () => {
  const history = threadWithHistory("queued-edit-usage-limits", 2);
  const [first, queued] = history.runs;
  const queuedPrompt = history.items[2]!;
  const thread = {
    ...history,
    runs: [
      { ...first!, status: "running" as const, completedAt: null },
      { ...queued!, status: "queued" as const, startedAt: null, completedAt: null },
    ],
    items: [
      history.items[0]!,
      history.items[1]!,
      { ...queuedPrompt, text: "second message", inputIntent: "queued_turn" as const },
    ],
  };
  const provider = {
    ...CODEX_PROVIDER,
    usageLimits: {
      checkedAt: "2026-03-17T19:12:28.000Z",
      windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 40 }],
    },
  };
  using _environment = installFakeEnvironment([thread], {
    acceptCommands: true,
    providers: [provider],
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
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
  // The fake projection serves no messages, so the queued prompt arrives as the server sends it.
  const at = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");
  await act(() =>
    emitThreadEvent(thread.id, {
      type: "message.updated",
      payload: {
        id: queued!.userMessageId,
        threadId: thread.id,
        runId: queued!.id,
        nodeId: null,
        role: "user",
        text: "second message",
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
        createdBy: "user",
        creationSource: "web",
      },
    }),
  );
  const editor = page.getByTestId("composer-editor");
  await userEvent.click(page.getByRole("button", { name: "Edit queued message" }));
  await expect.element(editor).toHaveTextContent("second message");

  await userEvent.click(editor);
  await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
  await insertText("/usage-limits");
  await userEvent.click(page.getByRole("button", { name: "Update queued message" }));

  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({
        type: "queued-run.edit",
        runId: queued!.id,
        text: "/usage-limits",
      }),
    ),
  );
});
