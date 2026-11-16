import { createMemoryHistory } from "@tanstack/react-router";
import { WS_METHODS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; importing it here
// keeps that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  answerRpc,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);

/** Accepts every attachment upload without sending its bytes, until disposed. */
function acceptAttachmentUploads(): Disposable {
  const mint = answerRpc(WS_METHODS.attachmentsCreateUploadUrl, () =>
    Effect.succeed({ attachmentId: "upload-1", relativeUrl: "/upload", expiresAt: 0 }),
  );
  // Sending verifies each ready upload still exists on the server.
  const verify = answerRpc(WS_METHODS.assetsCreateUrl, () =>
    Effect.succeed({ relativeUrl: "/upload-1", expiresAt: 0 }),
  );
  const status = vi.spyOn(XMLHttpRequest.prototype, "status", "get").mockReturnValue(200);
  const send = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(function (
    this: XMLHttpRequest,
  ) {
    queueMicrotask(() => this.dispatchEvent(new ProgressEvent("load")));
  });
  return {
    [Symbol.dispose]: () => {
      send.mockRestore();
      status.mockRestore();
      mint[Symbol.dispose]();
      verify[Symbol.dispose]();
    },
  };
}

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
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

function pasteOnPage(fill: (clipboardData: DataTransfer) => void) {
  const clipboardData = new DataTransfer();
  fill(clipboardData);
  document.body.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
  );
}

it("text and screenshots pasted outside the composer send with an Enter right after", async () => {
  const thread = threadWithHistory("paste-to-focus-images", 1);
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
  using _uploads = acceptAttachmentUploads();
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();

  // A dictation tool pastes its transcript, then each screenshot, then presses Enter, while
  // the page holds focus.
  (document.activeElement as HTMLElement | null)?.blur();
  pasteOnPage((data) => data.setData("text/plain", "Check this."));
  pasteOnPage((data) => data.items.add(new File([PNG], "first.png", { type: "image/png" })));
  pasteOnPage((data) => data.items.add(new File([PNG], "second.png", { type: "image/png" })));
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() =>
    expect(dispatchedCommands().map((command) => command.type)).toContain("message.dispatch"),
  );
  const sent = dispatchedCommands().find((command) => command.type === "message.dispatch");
  expect(sent).toMatchObject({ text: expect.stringContaining("Check this.") });
  expect(sent).toMatchObject({
    attachments: [
      expect.objectContaining({ name: "first.png" }),
      expect.objectContaining({ name: "second.png" }),
    ],
  });
});
