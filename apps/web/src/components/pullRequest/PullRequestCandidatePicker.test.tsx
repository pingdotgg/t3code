// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { TooltipProvider } from "../ui/tooltip";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("explains a denied reviewer request on hover and keyboard focus without opening the picker", async () => {
  const reason = "Asking someone to review needs write access on this repository";
  const onOpenChange = vi.fn();
  const onSelect = vi.fn();
  await act(async () => {
    root.render(
      <TooltipProvider delay={0}>
        <PullRequestCandidatePicker
          icon={<span aria-hidden>+</span>}
          label="Request a review"
          allowed={false}
          disabledReason={reason}
          open={false}
          onOpenChange={onOpenChange}
          query=""
          onQueryChange={() => {}}
          searchLabel="Search people with access"
          isPending={false}
          error={null}
          candidates={[] as string[]}
          emptyLabel="Nobody else has access to this repository."
          noMatchLabel="Nobody with access matches that."
          errorLabel="The people with access could not be read."
          truncated={false}
          truncatedLabel="More people exist."
          candidateKey={(candidate) => candidate}
          disabled={false}
          onSelect={onSelect}
        >
          {(candidate) => candidate}
        </PullRequestCandidatePicker>
      </TooltipProvider>,
    );
  });
  const button = container.querySelector("button")!;
  expect(button.disabled).toBe(true);
  const target = button.parentElement!;
  await act(async () => {
    target.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseenter"));
    target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  });
  await act(async () => {});
  expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(reason);
  await act(async () => {
    target.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseleave"));
  });
  await act(async () => {});
  expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
  await act(async () => target.focus());
  await act(async () => {});
  expect(document.activeElement).toBe(target);
  expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(reason);
  await act(async () => button.click());
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(onSelect).not.toHaveBeenCalled();
});
