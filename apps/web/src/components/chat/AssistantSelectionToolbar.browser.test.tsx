import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";

function Fixture({ onCite }: { onCite: () => boolean }) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setViewport} style={{ position: "fixed", inset: 40, overflow: "auto" }}>
      <div style={{ marginTop: 120, height: 200, overflow: "hidden" }}>
        <p
          data-assistant-citation-source="message-1"
          style={{ margin: 0, marginTop: 40, lineHeight: "24px" }}
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

it("a click past release does not cite", async () => {
  const onCite = vi.fn(() => true);
  await using screen = await render(<Fixture onCite={onCite} />);
  const source = screen.getByText("Select these words to cite them.").element() as HTMLElement;
  const rect = selectText(source);
  const cite = page.getByRole("button", { name: "Cite selection in composer" });
  await expect.element(cite).toBeVisible();
  const target = document.elementFromPoint(rect.right + 1, rect.bottom - 1)!;
  await userEvent.click(page.elementLocator(target), {
    position: {
      x: rect.right + 1 - target.getBoundingClientRect().left,
      y: rect.bottom - 1 - target.getBoundingClientRect().top,
    },
  });
  expect(onCite).not.toHaveBeenCalled();
});

it("places Cite relative to the visible part of a clipped selection", async () => {
  await using screen = await render(<Fixture onCite={() => true} />);
  const source = screen.getByText("Select these words to cite them.").element() as HTMLElement;
  const clip = source.parentElement!;
  clip.style.width = "120px";
  clip.style.height = "48px";
  source.style.marginTop = "0";
  clip.scrollTop = 24;
  selectText(source);

  const clipRect = clip.getBoundingClientRect();
  const lines = Array.from(window.getSelection()!.getRangeAt(0).getClientRects());
  const visible = lines.filter((line) => line.bottom > clipRect.top && line.top < clipRect.bottom);
  expect(lines.some((line) => line.bottom <= clipRect.top)).toBe(true);
  expect(visible.length).toBeGreaterThan(0);

  const cite = page.getByRole("button", { name: "Cite selection in composer" });
  await expect.element(cite).toBeVisible();
  await vi.waitFor(() => {
    const rect = cite.element().getBoundingClientRect();
    const center = (rect.left + rect.right) / 2;
    expect(center).toBeGreaterThanOrEqual(
      Math.max(clipRect.left, Math.min(...visible.map((line) => line.left))),
    );
    expect(center).toBeLessThanOrEqual(
      Math.min(clipRect.right, Math.max(...visible.map((line) => line.right))),
    );
    const visibleTop = Math.max(clipRect.top, Math.min(...visible.map((line) => line.top)));
    const visibleBottom = Math.min(
      clipRect.bottom,
      Math.max(...visible.map((line) => line.bottom)),
    );
    // Anchored to the visible lines, not the scrolled-away first line above the clip.
    const gap = rect.bottom <= visibleTop ? visibleTop - rect.bottom : rect.top - visibleBottom;
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(12);
  });
});
