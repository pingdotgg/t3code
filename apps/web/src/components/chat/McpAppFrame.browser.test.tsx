import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";

// Asks to close twice when told to, and answers only the first teardown, so
// the second one is left to finish on the host's timeout. Like Excalidraw, it
// saves a checkpoint through a write tool whenever its display mode changes.
const APP_HTML = `<button onclick="request('ui/request-display-mode', { mode: 'fullscreen' })">Expand</button><script>
let answered = false;
let nextId = 100;
let mode;
const saving = new Set();
const request = (method, params) => {
  parent.postMessage({ jsonrpc: "2.0", id: nextId, method, params }, "*");
  return nextId++;
};
addEventListener("message", (event) => {
  const message = event.data;
  if (message?.id === 1 && message.result?.hostContext) {
    mode = message.result.hostContext.displayMode;
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
  } else if (
    message?.method === "ui/notifications/host-context-changed" &&
    message.params.displayMode !== undefined &&
    message.params.displayMode !== mode
  ) {
    mode = message.params.displayMode;
    saving.add(request("tools/call", { name: "save_checkpoint", arguments: { mode } }));
  } else if (saving.delete(message?.id) && saving.size === 0) {
    parent.postMessage({ type: "saved" }, "*");
  } else if (message === "close") {
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" }, "*");
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" }, "*");
  } else if (message?.method === "ui/resource-teardown" && !answered) {
    answered = true;
    parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
  }
});
parent.postMessage({
  jsonrpc: "2.0",
  id: 1,
  method: "ui/initialize",
  params: { appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } },
}, "*");
</script>`;

vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: `data:text/html,${encodeURIComponent(APP_HTML)}`,
    expiresAt: Date.now() + 60 * 60_000,
  }),
}));

const mocks = vi.hoisted(() => ({
  confirmations: [] as string[],
  calls: [] as string[],
}));

vi.mock(import("~/confirmDialog"), async (importOriginal) => ({
  ...(await importOriginal()),
  requestConfirmDialog: (message: string) => {
    mocks.confirmations.push(message);
    return Promise.resolve(true);
  },
}));

// toolInfo is the only command called without arguments.
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: () => async (value: unknown) => {
    const { input } = value as { readonly input: Record<string, unknown> };
    if (input.arguments === undefined) {
      return {
        _tag: "Success",
        value: { callable: true, readOnly: false, title: "save_checkpoint" },
      } as never;
    }
    mocks.calls.push(String(input.name));
    return { _tag: "Success", value: { content: [] } } as never;
  },
}));

const setup = () => {
  mocks.confirmations.length = 0;
  mocks.calls.length = 0;
};

import { McpAppFrame } from "./McpAppFrame";

const renderFrame = () =>
  render(
    <McpAppFrame
      environmentId={EnvironmentId.make("environment")}
      threadId={ThreadId.make("thread")}
      conversationThreadId={ThreadId.make("thread")}
      itemId={TurnItemId.make("item")}
      revision="1"
      app={{
        attachmentId: "attachment",
        server: "Demo",
        tool: "show",
        resourceUri: "ui://demo/app",
      }}
      onSendMessage={undefined}
    />,
  );

const nextInitializedFrom = () =>
  new Promise<MessageEventSource>((resolve) => {
    const listen = (event: MessageEvent) => {
      if (event.source === null || event.data?.method !== "ui/notifications/initialized") return;
      window.removeEventListener("message", listen);
      resolve(event.source);
    };
    window.addEventListener("message", listen);
  });

describe("McpAppFrame", () => {
  it("asks once when an app saves its state on expanding to full screen", async () => {
    setup();
    const initialized = nextInitializedFrom();
    await using screen = await renderFrame();
    await initialized;
    // The runner's own activation at load counts as recent input elsewhere in T3.
    const now = performance.now.bind(performance);
    using _now = vi.spyOn(performance, "now").mockImplementation(() => now() + 10_000);

    const saved = new Promise<void>((resolve) => {
      const listen = (event: MessageEvent) => {
        if (event.data?.type !== "saved") return;
        window.removeEventListener("message", listen);
        resolve();
      };
      window.addEventListener("message", listen);
    });

    await page.frameLocator(screen.getByTitle("Demo app")).getByRole("button").click();
    await saved;

    expect(mocks.calls).toContain("save_checkpoint");
    expect(mocks.confirmations).toHaveLength(1);
  });

  it("keeps a reopened app when the old document's second teardown finishes late", async () => {
    const firstInitialized = nextInitializedFrom();
    await using screen = await renderFrame();
    const firstApp = await firstInitialized;
    using _timers = fakeTimers();

    (firstApp as Window).postMessage("close", "*");
    await userEvent.click(screen.getByRole("button", { name: "Show app" }));
    await expect.element(screen.getByTitle("Demo app")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByRole("button", { name: "Show app" }).query()).toBeNull();
    await expect.element(screen.getByTitle("Demo app")).toBeInTheDocument();
  });
});
