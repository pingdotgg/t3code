import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";

function Fixture({ onCite, clipped = false }: { onCite: () => boolean; clipped?: boolean }) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setViewport} style={{ position: "fixed", inset: 40, overflow: "auto" }}>
      <div style={{ marginTop: 120, height: clipped ? 100 : 200, overflow: "hidden" }}>
        <p
          data-assistant-citation-source="message-1"
          style={{ margin: 0, marginTop: clipped ? -8 : 40, lineHeight: "24px" }}
        >
          Select these words to cite them.
        </p>
      </div>
      <AssistantSelectionToolbar
        viewport={viewport}
        threadRef={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        }}
        onCite={onCite}
      />
    </div>
  );
}

function selectText(source: HTMLElement) {
  source.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0 }),
  );
  const range = document.createRange();
  range.selectNodeContents(source);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  const rect = range.getBoundingClientRect();
  source.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, clientX: rect.right, clientY: rect.bottom - 1 }),
  );
  return rect;
}

it("places Cite above the selection and a click past release does not cite", async () => {
  const onCite = vi.fn(() => true);
  await using screen = await render(<Fixture onCite={onCite} />);
  const source = screen.getByText("Select these words to cite them.").element() as HTMLElement;
  const rect = selectText(source);
  const cite = page.getByRole("button", { name: "Cite selection in composer" });
  await expect.element(cite).toBeVisible();
  expect(cite.element().getBoundingClientRect().bottom).toBe(rect.top - 6);
  const target = document.elementFromPoint(rect.right + 1, rect.bottom - 1)!;
  await userEvent.click(page.elementLocator(target), {
    position: {
      x: rect.right + 1 - target.getBoundingClientRect().left,
      y: rect.bottom - 1 - target.getBoundingClientRect().top,
    },
  });
  expect(onCite).not.toHaveBeenCalled();
});

it("flips below a line clipped by a nested scroller", async () => {
  await using screen = await render(<Fixture onCite={() => true} clipped />);
  const source = screen.getByText("Select these words to cite them.").element() as HTMLElement;
  const rect = selectText(source);
  const cite = page.getByRole("button", { name: "Cite selection in composer" });
  await expect.element(cite).toBeVisible();
  expect(cite.element().getBoundingClientRect().top).toBe(rect.bottom + 6);
});
