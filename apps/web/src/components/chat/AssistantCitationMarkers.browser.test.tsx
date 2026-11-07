import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { AssistantCitationMarkers } from "./AssistantCitationMarkers";

const mocks = vi.hoisted(() => ({ findAnchor: vi.fn() }));
vi.mock(import("~/lib/assistantTextSelection"), () => ({
  findAssistantCitationSourceAnchor: mocks.findAnchor,
}));

it("keeps source observations across typing and releases virtualized sources", async () => {
  mocks.findAnchor.mockReset();
  const viewport = document.createElement("div");
  const source = document.createElement("p");
  viewport.style.cssText = "position: fixed; left: 0; top: 0; width: 400px; height: 100px";
  source.style.width = "200px";
  source.textContent = "hello again";
  viewport.append(source);
  document.body.append(viewport);
  using _fixture = { [Symbol.dispose]: () => viewport.remove() };
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
  await act(() => source.remove());
  await vi.waitFor(() => expect(disconnect).toHaveBeenCalled());
});
