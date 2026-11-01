import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";

async function setup() {
  const viewport = document.createElement("div");
  const source = document.createElement("div");
  source.dataset.assistantCitationSource = "render-tool-item";
  const frame = document.createElement("iframe");
  frame.dataset.htmlSelectionBridge = "true";
  source.append(frame);
  viewport.append(source);
  const mount = document.createElement("div");
  document.body.append(viewport, mount);
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 500));
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 40, 400, 300));
  const onCite = vi.fn<
    (citation: AssistantCitation, anchor: AssistantCitationSourceAnchor) => boolean
  >(() => true);
  const screen = await render(
    <AssistantSelectionToolbar
      viewport={viewport}
      threadRef={{ environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") }}
      onCite={onCite}
    />,
    { container: mount, router: false },
  );
  frame.focus();
  const quote = { text: "quoted text", start: 7, end: 18, prefix: "Before ", suffix: " after." };
  const data = {
    jsonrpc: "2.0",
    method: "t3/selection",
    params: {
      selector: quote,
      rect: { left: 10, top: 20, width: 80, height: 15 },
      pointer: { x: 70, y: 35 },
    },
  };
  const send = (payload: unknown = data, origin: Window | null = frame.contentWindow) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: origin, data: payload }));
    });
  return {
    frame,
    onCite,
    quote,
    data,
    send,
    async [Symbol.asyncDispose]() {
      await screen[Symbol.asyncDispose]();
      viewport.remove();
      vi.restoreAllMocks();
    },
  };
}

describe("HTML selection Cite toolbar", () => {
  it("retains the host's citation scope and omits page-authored comments", async () => {
    await using fixture = await setup();
    const { data, send, onCite, quote } = fixture;
    await send({
      ...data,
      params: {
        ...data.params,
        selector: {
          ...quote,
          version: 2,
          environmentId: "forged",
          threadId: "forged",
          messageId: "forged",
          comment: "forged",
        },
      },
    });
    await act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Cite selection in composer"]')!
        .click(),
    );
    expect(onCite.mock.calls[0]?.[0]).toEqual({
      version: 1,
      environmentId: "env",
      threadId: "thread",
      messageId: "render-tool-item",
      ...quote,
    });
  });

  it("adds the iframe quote to the composer with a source anchor in client coordinates", async () => {
    await using fixture = await setup();
    const { frame, onCite, quote, send } = fixture;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    await send();
    const button = document.querySelector<HTMLButtonElement>(
      '[aria-label="Cite selection in composer"]',
    )!;
    expect(button).not.toBeNull();
    expect(button.style.left).toBe("170px");
    expect(button.style.top).toBe("75px");
    await act(() => button.click());
    expect(onCite).toHaveBeenCalledOnce();
    const [citation, anchor] = onCite.mock.calls[0]!;
    expect(citation).toEqual({
      version: 1,
      environmentId: "env",
      threadId: "thread",
      messageId: MessageId.make("render-tool-item"),
      ...quote,
    });
    expect(anchor.htmlRender).toBe(frame);
    expect(anchor.range.getBoundingClientRect()).toEqual(new DOMRect(110, 60, 80, 15));
    expect(post).toHaveBeenCalledWith(
      { method: "t3/selection-command", params: { action: "clear", selector: undefined } },
      "*",
    );
    expect(document.querySelector('[aria-label="Cite selection in composer"]')).toBeNull();
  });

  it("ignores messages from unrelated or unfocused frames", async () => {
    await using fixture = await setup();
    const { frame, data, send } = fixture;
    await send(data, window);
    expect(document.querySelector('[aria-label="Cite selection in composer"]')).toBeNull();
    frame.blur();
    await send();
    expect(document.querySelector('[aria-label="Cite selection in composer"]')).toBeNull();
  });

  it("offers shortening for oversized selections and dismisses on iframe interaction", async () => {
    await using fixture = await setup();
    const { onCite, data, send } = fixture;
    await send({ ...data, params: { tooLong: true, rect: data.params.rect, pointer: null } });
    const button = document.querySelector<HTMLButtonElement>(
      '[aria-label="Selection is too long to cite"]',
    )!;
    expect(button.disabled).toBe(true);
    await act(() => button.click());
    expect(onCite).not.toHaveBeenCalled();
    await send({ ...data, params: null });
    expect(document.querySelector('[aria-label="Selection is too long to cite"]')).toBeNull();
  });
});
