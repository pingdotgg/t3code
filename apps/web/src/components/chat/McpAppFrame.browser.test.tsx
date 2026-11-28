import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { injectMcpAppDocumentBootstrap } from "@t3tools/shared/mcpApp";

import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";

const environmentId = EnvironmentId.make("environment");
const project = {
  id: ProjectId.make("project"),
  environmentId,
  repositoryIdentity: {
    provider: "github",
    canonicalKey: "github.com/acme/widgets",
    displayName: "acme/widgets",
  },
};
vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  useProjects: () => [project],
  readProjects: () => [project],
  readThreadShell: () => null,
  useServerConfigs: () =>
    new Map([[environmentId, { environment: { capabilities: { issues: true } } }]]),
}));
vi.mock("~/state/server", async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original<typeof import("~/state/server")>()),
    environmentServerConfigsAtom: Atom.make(new Map([[EnvironmentId.make("environment"), {}]])),
  };
});
// The environment's Linear connection, with the project bound to the WEB team.
vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async () =>
    AsyncResult.success({
      trackers: [
        {
          tracker: IssueTrackerKind.make("linear"),
          displayName: "Linear",
          host: "linear.app",
          scopeNoun: "team",
          credential: { label: "Personal API key", helpUrl: null },
          connected: true,
          account: "sam",
          detail: null,
          workspace: "acme",
          scopes: [],
        },
      ],
      bindings: {
        [ProjectId.make("project")]: { tracker: IssueTrackerKind.make("linear"), scope: "WEB" },
      },
    }),
}));

// Asks to close twice when told to, and answers only the first teardown, so
// the second one is left to finish on the host's timeout.
const APP_HTML = injectMcpAppDocumentBootstrap(`<script>
let answered = false;
addEventListener("message", (event) => {
  const message = event.data;
  if (message === "close") {
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" }, "*");
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" }, "*");
  } else if (message?.openUrl) {
    parent.postMessage({ jsonrpc: "2.0", id: "link", method: "ui/open-link", params: { url: message.openUrl } }, "*");
  } else if (message?.id === "link") {
    parent.postMessage({ linkResponse: message }, "*");
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

// Asks the app to request `url` and resolves with the host's answer.
const requestLink = (app: Window, url: string) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const listen = (event: MessageEvent) => {
      if (event.source !== app || !event.data?.linkResponse) return;
      window.removeEventListener("message", listen);
      resolve(event.data.linkResponse);
    };
    window.addEventListener("message", listen);
    app.postMessage({ openUrl: url }, "*");
  });

describe("McpAppFrame", () => {
  it.each([
    ["https://github.com/acme/widgets/pull/86", { kind: "pull-request", number: 86 }],
    [
      "https://linear.app/acme/issue/WEB-17/fix-it",
      { kind: "issue", tracker: "linear", scope: "WEB", key: "WEB-17" },
    ],
    ["https://example.com/docs", null],
  ] as const)(
    "opens %s from a click in the app where a message link would",
    async (url, surface) => {
      __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, pullRequestLinksOpenInApp: true });
      useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
      setup(APP_HTML);
      const initialized = nextInitializedFrom();
      await using screen = await render(
        <McpAppFrame
          environmentId={environmentId}
          threadId={ThreadId.make("thread")}
          conversationThreadId={ThreadId.make("conversation")}
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
      const app = (await initialized) as Window;
      using external = vi.spyOn(window, "open").mockReturnValue(null);
      expect(await requestLink(app, url)).toMatchObject({
        error: { message: "Links open only from a click in the app." },
      });

      await userEvent.click(screen.getByTitle("Demo app"));
      expect(await requestLink(app, url)).toMatchObject({ result: {} });
      const panel =
        useRightPanelStore.getState().byThreadKey[
          scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make("conversation")))
        ];
      if (surface === null) {
        expect(panel).toBeUndefined();
        expect(external).toHaveBeenCalledExactlyOnceWith(url, "_blank", "noopener,noreferrer");
      } else {
        expect(panel).toMatchObject({ isOpen: true, surfaces: [surface] });
        expect(external).not.toHaveBeenCalled();
      }
    },
  );

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

  it("answers an app whose document carries the bootstrap", async () => {
    setup(injectMcpAppDocumentBootstrap(`<script>${HOST_REQUESTS}</script>`));
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
