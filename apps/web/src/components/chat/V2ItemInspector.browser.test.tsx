import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as DateTime from "effect/DateTime";
import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { V2ItemInspector } from "./V2ItemInspector";

const asset = vi.hoisted(() => ({ url: "" }));
vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: asset.url,
    expiresAt: Date.now() + 60 * 60_000,
  }),
}));

function setup() {
  asset.url = "";
}

function projectedHtml(
  html: string,
  updatedAt: string,
  status: "completed" | "failed" = "completed",
  isError = false,
): OrchestrationV2ProjectedTurnItem {
  const threadId = ThreadId.make("thread-html");
  const id = TurnItemId.make("preview-html");
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: id,
    item: {
      id,
      threadId,
      type: "dynamic_tool",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status,
      title: null,
      toolName: "mcp__t3-code__html_preview",
      input: { html, width: 728 },
      output: {
        ...(isError ? { isError: true } : {}),
        content: [
          {
            type: "text",
            text:
              status === "failed" || isError ? "Viewport height rejected" : "Console: no errors",
          },
        ],
      },
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe(updatedAt),
    },
  };
}

it("renders HTML tool details in the existing sandbox and fits the page", async () => {
  setup();
  using urls = new DisposableStack();
  const serve = (html: string) => {
    const url = URL.createObjectURL(
      new Blob([injectHtmlRenderBootstrap(html)], { type: "text/html" }),
    );
    urls.defer(() => URL.revokeObjectURL(url));
    asset.url = url;
  };
  const loaded: unknown[] = [];
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type === "html-preview-ready") loaded.push(event.data);
  };
  window.addEventListener("message", onMessage);
  using _listener = { [Symbol.dispose]: () => window.removeEventListener("message", onMessage) };
  const html = `<!doctype html><html><body><h1>Release status</h1><div style="height:600px"></div>
    <script>document.addEventListener("DOMContentLoaded", function () {
      var isolated = false;
      try { window.parent.document.body; } catch (error) { isolated = true; }
      window.parent.postMessage({ type: "html-preview-ready", text: document.querySelector("h1").textContent, isolated: isolated }, "*");
    });</script></body></html>`;
  const inspector = (source: string, updatedAt: string) => (
    <V2ItemInspector
      projectedItem={projectedHtml(source, updatedAt)}
      environmentId={EnvironmentId.make("environment-html")}
    />
  );
  serve(html);
  await using screen = await render(inspector(html, "2026-10-20T00:00:00Z"));

  await expect
    .poll(() => loaded)
    .toEqual([{ type: "html-preview-ready", text: "Release status", isolated: true }]);
  await expect
    .poll(() => screen.container.querySelector("iframe")?.clientHeight ?? 0)
    .toBeGreaterThan(600);
  expect(screen.container.textContent).toContain("width 728");
  expect(screen.container.textContent).toContain("Console: no errors");
  expect(screen.container.textContent).not.toContain("<!doctype");

  const updatedHtml = html.replace("Release status", "Updated status");
  serve(updatedHtml);
  await screen.rerender(inspector(updatedHtml, "2026-10-20T00:00:01Z"));
  await expect.poll(() => loaded).toHaveLength(2);
  expect(loaded[1]).toEqual({ type: "html-preview-ready", text: "Updated status", isolated: true });
});

it.each([
  { status: "failed" as const, isError: false, guest: false },
  { status: "completed" as const, isError: true, guest: false },
  { status: "completed" as const, isError: false, guest: true },
])(
  "keeps HTML source readable when a preview is unavailable: %j",
  async ({ status, isError, guest }) => {
    setup();
    const html = "<style>body{min-height:100vh}</style><h1>Invalid page</h1>";
    const projected = projectedHtml(html, "2026-10-20T00:00:00Z", status, isError);
    const detail = Atom.make(AsyncResult.success({ item: projected.item }));
    const commandOutput = Atom.make(AsyncResult.initial<never, never>());
    await using screen = await render(
      <V2ItemInspector
        projectedItem={projected}
        source={guest ? { detail: () => detail, commandOutput: () => commandOutput } : undefined}
        environmentId={EnvironmentId.make("environment-html")}
      />,
    );
    expect(screen.container.textContent).toContain(html);
    expect(screen.container.textContent).toContain(
      guest ? "Console: no errors" : "Viewport height rejected",
    );
    expect(screen.container.querySelector("iframe")).toBeNull();
  },
);
