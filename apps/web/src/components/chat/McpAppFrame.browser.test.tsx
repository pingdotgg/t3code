import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

// The app asks for full screen from its button. It also focuses its own frame
// and asks on load, right after it is told it left full screen, and whenever
// it loses focus while inline. It reports each answer to the page with a
// message the host ignores.
const APP_HTML = `<!doctype html><button>Open full screen</button><script>
let nextId = 0;
const pending = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    nextId += 1;
    pending.set(nextId, resolve);
    parent.postMessage({ jsonrpc: "2.0", id: nextId, method, params }, "*");
  });
let mode = "inline";
const askFullscreen = async (source) => {
  const answer = await request("ui/request-display-mode", { mode: "fullscreen" });
  mode = answer.mode;
  parent.postMessage({ probe: source + ":" + answer.mode }, "*");
};
const button = document.querySelector("button");
button.onclick = () => askFullscreen("tap");
const refocusAndAsk = (source) => {
  button.focus();
  void askFullscreen(source);
};
addEventListener("message", ({ data }) => {
  if (data === "retry") return refocusAndAsk("retry");
  if (pending.has(data.id)) {
    pending.get(data.id)(data.result);
    pending.delete(data.id);
    return;
  }
  if (data.method !== "ui/notifications/host-context-changed") return;
  const left = mode === "fullscreen" && data.params.displayMode === "inline";
  mode = data.params.displayMode ?? mode;
  if (left) refocusAndAsk("exit");
});
// Focus can only be taken back once the browser has finished moving it away.
addEventListener("blur", () => {
  if (mode === "inline") setTimeout(() => refocusAndAsk("blur"));
});
void request("ui/initialize", { protocolVersion: "2026-01-26", appCapabilities: {} }).then(() => {
  parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
  refocusAndAsk("load");
});
</script>`;

vi.mock(import("../../assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: (() => ({
    _tag: "Success",
    url: `data:text/html,${encodeURIComponent(APP_HTML)}`,
    expiresAt: Date.now() + 60 * 60_000,
  })) as never,
  useAssetUrlRefresh: (() => async () => null) as never,
}));
vi.mock(import("../../state/queries"), async (original) => ({
  ...(await original()),
  useTurnItemDetail: (() => ({ data: undefined })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => async () => ({ _tag: "Failure", cause: undefined })) as never,
}));
vi.mock(import("../../hooks/useHtmlRenderTheme"), async (original) => ({
  ...(await original()),
  useHtmlRenderTheme: (() => ({ appearance: "light", variables: {} })) as never,
}));

import { McpAppFrame } from "./McpAppFrame";

let root: Root | undefined;
let skew = 0;
let answers: string[] = [];
let answered: (() => void) | undefined;
const onProbe = (event: MessageEvent) => {
  const probe = (event.data as { readonly probe?: unknown } | null)?.probe;
  if (typeof probe !== "string") return;
  answers.push(probe);
  answered?.();
};
const nextAnswer = async (action: () => Promise<unknown>) => {
  const seen = answers.length;
  const answer = new Promise<string>((resolve) => {
    answered = () => {
      if (answers.length > seen) resolve(answers[seen]!);
    };
  });
  await action();
  return answer;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  answers = [];
  answered = undefined;
  skew = 0;
  // Advance the host cooldown without manufacturing browser user activation.
  const now = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => now() + skew);
  window.addEventListener("message", onProbe);
});
afterEach(async () => {
  window.removeEventListener("message", onProbe);
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const isFullscreen = () => document.querySelector("[data-mcp-app-fullscreen]") !== null;

const renderApp = async () => {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <McpAppFrame
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("thread")}
        conversationThreadId={ThreadId.make("thread")}
        itemId={TurnItemId.make("item")}
        revision="1"
        app={{ attachmentId: "app", server: "srv", tool: "show", resourceUri: "ui://srv/app" }}
        onSendMessage={undefined}
      />,
    ),
  );
};

const retry = () =>
  nextAnswer(async () => {
    document.querySelector("iframe")!.contentWindow!.postMessage("retry", "*");
  });

it("keeps load and idle retries inline even after the page-input cooldown", async () => {
  expect(await nextAnswer(renderApp)).toBe("load:inline");
  skew += 5_000;
  expect(await retry()).toBe("retry:inline");
  expect(await retry()).toBe("retry:inline");
  expect(isFullscreen()).toBe(false);
});

it("allows an app click immediately after loading on an idle page", async () => {
  expect(await nextAnswer(renderApp)).toBe("load:inline");
  const appButton = page
    .frameLocator(page.getByTitle("srv app"))
    .getByRole("button", { name: "Open full screen" });
  expect(await nextAnswer(() => userEvent.click(appButton))).toBe("tap:fullscreen");
  expect(isFullscreen()).toBe(true);
});

it("opens full screen only from a tap in the app, never from activation the page got elsewhere", async () => {
  const appButton = page
    .frameLocator(page.getByTitle("srv app"))
    .getByRole("button", { name: "Open full screen" });
  const elsewhere = document.body.appendChild(document.createElement("button"));
  elsewhere.textContent = "Elsewhere";
  const tapApp = async () => {
    skew += 5_000;
    expect(await nextAnswer(() => userEvent.click(appButton))).toBe("tap:fullscreen");
    expect(isFullscreen()).toBe(true);
  };

  // The click that opens a thread still activates the page as its app loads.
  const load = nextAnswer(async () => {
    await userEvent.click(elsewhere);
    await renderApp();
  });
  expect(await load).toBe("load:inline");
  expect(isFullscreen()).toBe(false);

  await tapApp();
  const exit = page.getByRole("button", { name: "Exit full screen" });
  expect(await nextAnswer(() => userEvent.click(exit))).toBe("exit:inline");
  expect(isFullscreen()).toBe(false);

  skew += 5_000;
  expect(await nextAnswer(() => userEvent.click(elsewhere))).toBe("blur:inline");
  expect(isFullscreen()).toBe(false);

  // Escape activates nothing, but the tap that opened full screen still does.
  await tapApp();
  (await exit.element()).focus();
  expect(await nextAnswer(() => userEvent.keyboard("{Escape}"))).toBe("exit:inline");
  expect(isFullscreen()).toBe(false);
});
