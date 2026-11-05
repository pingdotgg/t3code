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
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event.defaultPrevented;
};

it("claims only the Escape that dismisses a live citation", async () => {
  // router: false because the hook only listens on the document.
  await using _screen = await render(<CitedTimeline />, { router: false });

  expect(pressEscape()).toBe(true);
  expect(pressEscape()).toBe(false);
});
