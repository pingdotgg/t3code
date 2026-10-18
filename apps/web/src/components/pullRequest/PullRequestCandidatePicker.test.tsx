// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("disabled candidate picker", () => {
  it.each(["keyboard", "pointer"])(
    "shows the refusal reason for %s without opening the picker",
    async (input) => {
      const onOpenChange = vi.fn();
      const onSelect = vi.fn();
      await act(async () => {
        root.render(
          <PullRequestCandidatePicker
            icon="+"
            label="Request reviewers"
            allowed={false}
            disabledReason="Only collaborators can request reviewers."
            open={false}
            onOpenChange={onOpenChange}
            query=""
            onQueryChange={() => {}}
            searchLabel="Search reviewers"
            isPending={false}
            error={null}
            candidates={["alex"]}
            emptyLabel="No reviewers"
            noMatchLabel="No matching reviewers"
            errorLabel="Unable to load reviewers"
            truncated={false}
            truncatedLabel="More reviewers available"
            candidateKey={(candidate) => candidate}
            disabled={false}
            onSelect={onSelect}
          >
            {(candidate) => candidate}
          </PullRequestCandidatePicker>,
        );
      });
      const trigger = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Request reviewers"]',
      )!;
      if (input === "keyboard") {
        await act(async () => {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
          trigger.focus();
        });
        expect(document.activeElement).toBe(trigger);
      } else {
        vi.useFakeTimers();
        await act(async () => {
          trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          trigger.dispatchEvent(new MouseEvent("mouseenter"));
          trigger.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
          await vi.advanceTimersByTimeAsync(1000);
        });
      }
      expect(
        document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent,
      ).toContain("Only collaborators can request reviewers.");
      await act(async () => {
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
        trigger.click();
      });
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    },
  );
});
