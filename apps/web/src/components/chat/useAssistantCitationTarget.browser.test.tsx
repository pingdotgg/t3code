import type { AssistantCitation } from "@t3tools/contracts";
import { useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
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

function CompletedCitation(props: { onReady: (complete: () => void) => void }) {
  const { target, onListLoad } = useAssistantCitationTarget({
    request,
    phase: { _tag: "ready", rowId: "row" },
    viewport: null,
    onManualNavigation: () => {},
  });
  useEffect(onListLoad, [onListLoad]);
  if (target) props.onReady(target.onComplete);
  return null;
}

it("leaves Escape unclaimed once the citation scroll completed", async () => {
  let complete: (() => void) | undefined;
  // router: false because the hook only listens on the document.
  await using _screen = await render(<CompletedCitation onReady={(next) => (complete = next)} />, {
    router: false,
  });
  await vi.waitFor(() => expect(complete).toBeDefined());
  await act(() => complete?.());

  expect(pressEscape()).toEqual({ claimed: false, reachedWindow: true });
});
