import type { AssistantCitation } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { useAssistantCitationTarget } from "./useAssistantCitationTarget";

const request = { citation: {} as AssistantCitation, key: "citation" };

function CitedTimeline() {
  useAssistantCitationTarget({
    request,
    phase: null,
    viewport: null,
    onManualNavigation: () => {},
  });
  return null;
}

const pressEscape = () => {
  let reachedWindow = false;
  const onWindowKeyDown = () => {
    reachedWindow = true;
  };
  window.addEventListener("keydown", onWindowKeyDown);
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  window.removeEventListener("keydown", onWindowKeyDown);
  return { claimed: event.defaultPrevented, reachedWindow };
};

it("claims only the Escape that dismisses a live citation", async () => {
  // router: false because the hook only listens on the document.
  await using _screen = await render(<CitedTimeline />, { router: false });

  expect(pressEscape()).toEqual({ claimed: true, reachedWindow: false });
  expect(pressEscape()).toEqual({ claimed: false, reachedWindow: true });
});
