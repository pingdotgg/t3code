import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";

// Asks to close twice when told to, and answers only the first teardown, so
// the second one is left to finish on the host's timeout.
const APP_HTML = `<script>
let answered = false;
addEventListener("message", (event) => {
  const message = event.data;
  if (message === "close") {
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" }, "*");
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" }, "*");
  } else if (message === "call-tool") {
    parent.postMessage({ jsonrpc: "2.0", id: "call", method: "tools/call", params: { name: "change", arguments: {} } }, "*");
  } else if (message?.id === "call") {
    parent.postMessage({ toolCallAnswer: message }, "*");
  } else if (message?.method === "ui/resource-teardown" && !answered) {
    answered = true;
    parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
  }
});
parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
</script>`;

vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: `data:text/html,${encodeURIComponent(APP_HTML)}`,
    expiresAt: Date.now() + 60 * 60_000,
  }),
}));

const mocks = vi.hoisted(() => ({
  requestConfirmDialog: vi.fn(async () => false),
}));

vi.mock(import("~/confirmDialog"), async (importOriginal) => ({
  ...(await importOriginal()),
  requestConfirmDialog: mocks.requestConfirmDialog,
}));

// The app's tool is callable from the app and not marked read-only.
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: (() => async () => ({
    _tag: "Success",
    value: { callable: true, readOnly: false, content: [] },
  })) as never,
}));

import { McpAppFrame } from "./McpAppFrame";

const setup = () => {
  mocks.requestConfirmDialog.mockClear();
};

const renderApp = () =>
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

const nextToolCallAnswer = () =>
  new Promise<{ readonly error?: unknown; readonly result?: unknown }>((resolve) => {
    const listen = (event: MessageEvent) => {
      if (event.data?.toolCallAnswer === undefined) return;
      window.removeEventListener("message", listen);
      resolve(event.data.toolCallAnswer);
    };
    window.addEventListener("message", listen);
  });

describe("McpAppFrame", () => {
  it("refuses a non-read-only tool call the app makes without a click, without asking", async () => {
    setup();
    const initialized = nextInitializedFrom();
    await using _screen = await renderApp();
    const app = (await initialized) as Window;

    const answer = nextToolCallAnswer();
    app.postMessage("call-tool", "*");

    expect((await answer).error).toBeDefined();
    expect(mocks.requestConfirmDialog).not.toHaveBeenCalled();
  });

  it("keeps a reopened app when the old document's second teardown finishes late", async () => {
    setup();
    const firstInitialized = nextInitializedFrom();
    await using screen = await renderApp();
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
