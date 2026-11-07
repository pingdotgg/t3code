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
  source.textContent = "hello";
  viewport.append(source);
  document.body.append(viewport);
  using _fixture = { [Symbol.dispose]: () => viewport.remove() };
  mocks.findAnchor.mockImplementation(() => {
    if (!viewport.contains(source)) return null;
    const range = document.createRange();
    range.selectNodeContents(source);
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
      prompt={prompt}
      richTextEnabled
      onOpen={onOpen}
    />,
  );
  using disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
  const searches = mocks.findAnchor.mock.calls.length;
  await screen.rerender(
    <AssistantCitationMarkers
      viewport={viewport}
      prompt={`${prompt} typing`}
      richTextEnabled
      onOpen={onOpen}
    />,
  );
  expect(disconnect).not.toHaveBeenCalled();
  expect(mocks.findAnchor).toHaveBeenCalledTimes(searches);
  await act(() => source.remove());
  await vi.waitFor(() => expect(disconnect).toHaveBeenCalled());
});
