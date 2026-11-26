import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { injectMcpAppDocumentBootstrap } from "@t3tools/shared/mcpApp";

import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";

// Asks to close twice when told to, and answers only the first teardown, so
// the second one is left to finish on the host's timeout.
const APP_HTML = injectMcpAppDocumentBootstrap(`<script>
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
</script>`);

const sizeChanged = (height: number) =>
  `parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: ${height} } }, "*");`;
// What the app's frame shows after the app follows a link: another page in the same window.
// Its nested frame keeps `load`, which stops the app, from firing before its message arrives.
const REPLACEMENT_URL = `data:text/html,${encodeURIComponent(`<script>${sizeChanged(777)}</script><iframe srcdoc="x"></iframe>`)}`;
// Served as the server serves an app: the document bootstrap is its first script.
const NAVIGATING_APP_HTML = injectMcpAppDocumentBootstrap(`<script>
addEventListener("message", (event) => {
  if (event.data === "leave") location.href = ${JSON.stringify(REPLACEMENT_URL)};
  else if (event.data?.id === "init") ${sizeChanged(321)}
});
parent.postMessage({ jsonrpc: "2.0", id: "init", method: "ui/initialize", params: {} }, "*");
</script>`);

// What an app asks its host for: a resource, a tool call and a model-context update.
const HOST_REQUESTS = `
const ask = (id, method, params) => parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
ask("init", "ui/initialize", {});
ask(1, "resources/read", { uri: "ui://demo/other" });
ask(2, "tools/call", { name: "list", arguments: {} });
ask(3, "ui/update-model-context", { content: [{ type: "text", text: "note" }] });
${sizeChanged(777)}`;
const REQUESTING_URL = `data:text/html,${encodeURIComponent(`<script>${HOST_REQUESTS}</script><iframe srcdoc="x"></iframe>`)}`;

const asset = vi.hoisted(() => ({ html: "" }));
const commands = vi.hoisted(() => ({ labels: [] as Array<string> }));
const setup = (html: string) => {
  asset.html = html;
  commands.labels = [];
};

vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: ((command: { readonly label: string }) => async () => {
    commands.labels.push(command.label);
    return {
      _tag: "Success",
      value: { callable: true, readOnly: true, content: [], contents: [] },
    };
  }) as never,
}));

vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: `data:text/html,${encodeURIComponent(asset.html)}`,
    expiresAt: Date.now() + 60 * 60_000,
  }),
}));

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

describe("McpAppFrame", () => {
  it("keeps a reopened app when the old document's second teardown finishes late", async () => {
    setup(APP_HTML);
    const firstInitialized = nextInitializedFrom();
    await using screen = await render(
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
    const firstApp = await firstInitialized;
    using _timers = fakeTimers();

    (firstApp as Window).postMessage("close", "*");
    await userEvent.click(screen.getByRole("button", { name: "Show app" }));
    await expect.element(screen.getByTitle("Demo app")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByRole("button", { name: "Show app" }).query()).toBeNull();
    await expect.element(screen.getByTitle("Demo app")).toBeInTheDocument();
  });

  it("ignores a page the app's frame navigated to", async () => {
    setup(NAVIGATING_APP_HTML);
    const element = () => (
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
      />
    );
    await using screen = await render(element());
    const frame = screen.getByTitle("Demo app").element() as HTMLIFrameElement;
    const row = frame.parentElement!.parentElement!;
    // The app resizes only after the host's answer reached it, so the bridge works both ways.
    await expect.element(row).toHaveStyle({ height: "321px" });

    // A tool update hands the row an equal app in a new object, which re-attaches the host.
    await screen.rerender(element());
    frame.contentWindow!.postMessage("leave", "*");
    await expect
      .element(screen.getByText("The Demo app left its page and was stopped"))
      .toBeInTheDocument();
    expect(row.style.height).toBe("321px");
  });

  // A server that predates the document bootstrap serves the app without it.
  it.each([
    ["the app's own page", `<script>${HOST_REQUESTS}</script>`],
    [
      "a page the app navigated to",
      `<script>location.href = ${JSON.stringify(REQUESTING_URL)};</script>`,
    ],
  ])("gives no bridge to %s when the document bootstrap is missing", async (_page, html) => {
    setup(html);
    await using screen = await render(
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

    await expect
      .element(
        screen.getByText(
          "The Demo app needs a newer T3 Code server on this environment. Update the server to use it.",
        ),
      )
      .toBeInTheDocument();
    expect(screen.getByTitle("Demo app").query()).toBeNull();
    expect(commands.labels).toEqual([]);
  });

  it.each([
    ["carries the bootstrap", ""],
    // Stands in for the script AdGuard's local proxy adds to a page served over HTTP.
    [
      "gets a filtering proxy's script ahead of the bootstrap",
      `<script>parent.postMessage("proxy-handshake", "*", [new MessageChannel().port2]);</script>`,
    ],
  ])("answers an app whose document %s", async (_document, ahead) => {
    setup(`${ahead}${injectMcpAppDocumentBootstrap(`<script>${HOST_REQUESTS}</script>`)}`);
    await using screen = await render(
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
    const frame = screen.getByTitle("Demo app").element() as HTMLIFrameElement;
    await expect.element(frame.parentElement!.parentElement!).toHaveStyle({ height: "777px" });
    await vi.waitFor(() =>
      expect(commands.labels.toSorted()).toEqual([
        "environment-command:mcp-apps:call-tool",
        "environment-command:mcp-apps:read-resource",
        "environment-command:mcp-apps:tool-info",
        "environment-command:mcp-apps:update-model-context",
      ]),
    );
  });
});
