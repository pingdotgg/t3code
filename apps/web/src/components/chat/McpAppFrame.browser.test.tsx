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
  } else if (message?.method === "ui/resource-teardown" && !answered) {
    answered = true;
    parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
  }
});
parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
</script>`;

// Calls a tool as soon as it loads, with no click, and reports the reply.
const CALL_ON_LOAD_HTML = `<script>
addEventListener("message", (event) => {
  if (event.data?.id === "load-call") parent.postMessage({ loadCallReply: event.data }, "*");
});
parent.postMessage(
  { jsonrpc: "2.0", id: "load-call", method: "tools/call", params: { name: "track", arguments: {} } },
  "*",
);
</script>`;

let appHtml = APP_HTML;
const serveAppHtml = (html: string): Disposable => {
  appHtml = html;
  return {
    [Symbol.dispose]: () => {
      appHtml = APP_HTML;
    },
  };
};

vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: `data:text/html,${encodeURIComponent(appHtml)}`,
    expiresAt: Date.now() + 60 * 60_000,
  }),
}));

const { runCommand, requestConfirmDialog } = vi.hoisted(() => ({
  runCommand: vi.fn(async (_command: unknown, _value: unknown) => ({
    _tag: "Success" as const,
    value: { callable: true, readOnly: false, content: [] },
  })),
  requestConfirmDialog: vi.fn(() => Promise.resolve(true)),
}));

vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: ((command: unknown) => (value: unknown) => runCommand(command, value)) as never,
}));

vi.mock(import("~/confirmDialog"), () => ({
  isConfirmDialogActive: () => false,
  requestConfirmDialog: requestConfirmDialog as never,
}));

import { mcpAppEnvironment } from "~/state/mcpApps";
import { McpAppFrame } from "./McpAppFrame";

const nextInitializedFrom = () =>
  new Promise<MessageEventSource>((resolve) => {
    const listen = (event: MessageEvent) => {
      if (event.source === null || event.data?.method !== "ui/notifications/initialized") return;
      window.removeEventListener("message", listen);
      resolve(event.source);
    };
    window.addEventListener("message", listen);
  });

const APP = {
  attachmentId: "attachment",
  server: "Demo",
  tool: "show",
  resourceUri: "ui://demo/app",
};

describe("McpAppFrame", () => {
  it("refuses a tool call made without a click instead of asking for approval", async () => {
    using _html = serveAppHtml(CALL_ON_LOAD_HTML);
    const reply = new Promise<{ readonly error?: { readonly message: string } }>((resolve) => {
      const listen = (event: MessageEvent) => {
        if (event.data?.loadCallReply === undefined) return;
        window.removeEventListener("message", listen);
        resolve(event.data.loadCallReply);
      };
      window.addEventListener("message", listen);
    });
    await using _screen = await render(
      <McpAppFrame
        environmentId={EnvironmentId.make("environment")}
        threadId={ThreadId.make("thread")}
        conversationThreadId={ThreadId.make("thread")}
        itemId={TurnItemId.make("item")}
        revision="1"
        app={APP}
        onSendMessage={undefined}
      />,
    );

    expect((await reply).error?.message).toBe("This tool runs only from a click in the app.");
    expect(requestConfirmDialog).not.toHaveBeenCalled();
    expect(runCommand.mock.calls.map(([command]) => command)).not.toContain(
      mcpAppEnvironment.callTool,
    );
  });

  it("keeps a reopened app when the old document's second teardown finishes late", async () => {
    const firstInitialized = nextInitializedFrom();
    await using screen = await render(
      <McpAppFrame
        environmentId={EnvironmentId.make("environment")}
        threadId={ThreadId.make("thread")}
        conversationThreadId={ThreadId.make("thread")}
        itemId={TurnItemId.make("item")}
        revision="1"
        app={APP}
        onSendMessage={undefined}
      />,
    );
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
