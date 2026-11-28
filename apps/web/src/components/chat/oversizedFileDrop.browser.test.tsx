import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; importing it here
// keeps that out of the test's timeout.
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
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx. The app keeps the
// server config it first received, so this file starts its own connection with uploads on.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const MB = 1024 * 1024;

/** An 8 GB archive: only the size decides whether a file uploads, so it needs no real bytes. */
function largeArchive() {
  const archive = new File([new Uint8Array(16)], "device-firmware-build.tar.gz", {
    type: "application/gzip",
  });
  Object.defineProperty(archive, "size", { value: 8192 * MB });
  return archive;
}

async function renderThread(name: string) {
  const thread = threadWithHistory(name, 1);
  await using stack = new AsyncDisposableStack();
  stack.use(
    installFakeEnvironment([thread], {
      acceptCommands: true,
      maxFileUploadBytes: 50 * MB,
    }),
  );
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  stack.use(
    await render(<AppRoot router={router} />, {
      // AppRoot brings its own router.
      router: false,
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
  const editor = page.getByRole("textbox", { name: `Message ${thread.title}`, exact: true });
  const owned = stack.move();
  return {
    editor,
    threadRef: scopeThreadRef(ENVIRONMENT_ID, thread.id),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

/**
 * Drops `file` from the desktop's file manager. The drop reads the desktop bridge while it is
 * dispatched; the rest of the app keeps running as the browser build, which this partial bridge
 * could not serve.
 */
function dropFromDesktop(file: File, bridge: Record<string, unknown>) {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  const dropTarget = document.querySelector('[data-chat-workspace-drop-target="true"]')!;
  const previousBridge = window.desktopBridge;
  Object.assign(window, {
    desktopBridge: {
      getPathForFile: (dropped: File) => `/tmp/t3-demo/${dropped.name}`,
      getLocalEnvironmentBootstraps: () => [],
      getLocalEnvironmentEnabled: () => true,
      ...bridge,
    },
  });
  try {
    dropTarget.dispatchEvent(
      new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }),
    );
  } finally {
    Object.assign(window, { desktopBridge: previousBridge });
  }
}

it("holds send until a WSL path conversion links the dropped file", async () => {
  await using screen = await renderThread("oversized-drop-wsl");
  let finishConversion = () => {};
  const conversion = new Promise<void>((resolve) => {
    finishConversion = resolve;
  });

  dropFromDesktop(largeArchive(), {
    getLocalEnvironmentBootstraps: () => [{ id: "primary", runningDistro: "Ubuntu" }],
    toLocalBackendPath: async (_backendId: string, path: string) => {
      await conversion;
      return `/mnt/c${path}`;
    },
  });
  await userEvent.click(screen.editor);
  await cdp().send("Input.insertText", { text: "list this archive" });
  await userEvent.keyboard("{Enter}");
  // The composer answers the blocked send with this notice instead of dispatching it.
  await expect
    .element(page.getByText("Still bringing attached context into this message."))
    .toBeVisible();
  expect(dispatchedCommands().filter((command) => command.type === "message.dispatch")).toEqual([]);

  await act(async () => finishConversion());
  await vi.waitFor(() =>
    expect(useComposerDraftStore.getState().getComposerDraft(screen.threadRef)?.prompt).toContain(
      "/mnt/c/tmp/t3-demo/device-firmware-build.tar.gz",
    ),
  );
});
