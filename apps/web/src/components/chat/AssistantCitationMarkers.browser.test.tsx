import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { AssistantCitationMarkers } from "./AssistantCitationMarkers";

import "~/index.css";

const mocks = vi.hoisted(() => ({ findAnchor: vi.fn() }));
vi.mock(import("~/lib/assistantTextSelection"), () => ({
  findAssistantCitationSourceAnchor: mocks.findAnchor,
}));

it.each(["moving sibling", "queued text", "narrow gutter"])(
  "keeps source observations across typing and %s changes",
  async (scenario) => {
    mocks.findAnchor.mockReset();
    const viewport = document.createElement("div");
    const source = document.createElement("p");
    viewport.style.cssText = "position: fixed; left: 0; top: 0; width: 400px; height: 100px";
    source.style.width = "200px";
    source.textContent = "hello again";
    const sibling = document.createElement("div");
    const content = document.createElement("div");
    content.className = "messages-timeline-scroll";
    content.append(sibling, source);
    viewport.append(content);
    const canvas = document.createElement("div");
    canvas.setAttribute("data-chat-canvas", "");
    canvas.append(viewport);
    document.body.append(canvas);
    using _fixture = { [Symbol.dispose]: () => canvas.remove() };
    mocks.findAnchor.mockImplementation(() => {
      if (!viewport.contains(source)) return null;
      const range = document.createRange();
      range.setStart(source.firstChild!, 0);
      range.setEnd(source.firstChild!, 5);
      return { source, range };
    });
    const prompt = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("message"),
      text: "hello",
      start: 0,
      end: 5,
      prefix: "",
      suffix: "",
    });
    const onOpen = vi.fn();
    await using screen = await render(
      <AssistantCitationMarkers
        viewport={viewport}
        prompt={`${prompt} ${prompt}`}
        richTextEnabled
        onOpen={onOpen}
      />,
    );
    const markers = screen.container.querySelectorAll<HTMLButtonElement>(
      "[data-citation-marker-key]",
    );
    await vi.waitFor(() => {
      expect(markers[0]!.style.left).not.toBe("");
      expect(markers[0]!.style.left).not.toBe(markers[1]!.style.left);
      expect(markers[0]!.style.top).toBe(markers[1]!.style.top);
      expect(
        Number.parseFloat(markers[0]!.style.left) + viewport.getBoundingClientRect().left,
      ).toBeGreaterThanOrEqual(source.getBoundingClientRect().right);
    });
    using disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const searches = mocks.findAnchor.mock.calls.length;
    await screen.rerender(
      <AssistantCitationMarkers
        viewport={viewport}
        prompt={`${prompt} ${prompt} typing`}
        richTextEnabled
        onOpen={onOpen}
      />,
    );
    expect(disconnect).not.toHaveBeenCalled();
    expect(mocks.findAnchor).toHaveBeenCalledTimes(searches);
    if (scenario === "moving sibling") {
      const previousTop = markers[0]!.style.top;
      await act(() => {
        sibling.style.height = "30px";
      });
      await vi.waitFor(() => expect(markers[0]!.style.top).not.toBe(previousTop));
    }
    if (scenario === "queued text") {
      await act(() => {
        viewport.append(document.createElement("div"));
        source.firstChild!.textContent = "hello updated";
      });
      await vi.waitFor(() => {
        expect(mocks.findAnchor.mock.calls.length).toBeGreaterThan(searches);
        expect(markers[0]!.hidden).toBe(false);
      });
    }
    if (scenario === "narrow gutter") {
      await act(() => {
        source.style.width = "100%";
        viewport.dispatchEvent(new Event("scroll"));
      });
      await vi.waitFor(() => {
        for (const marker of markers) {
          expect(Number.parseFloat(marker.style.left)).toBeGreaterThanOrEqual(
            source.getBoundingClientRect().right - viewport.getBoundingClientRect().left,
          );
          expect(Number.parseFloat(marker.style.left) + marker.offsetWidth).toBeLessThanOrEqual(
            viewport.clientWidth,
          );
        }
      });
    }
    await act(() => source.remove());
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalled());
  },
);
