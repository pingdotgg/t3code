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
const APP_HTML = `<script>
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
</script>`;

vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: `data:text/html,${encodeURIComponent(APP_HTML)}`,
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
});
