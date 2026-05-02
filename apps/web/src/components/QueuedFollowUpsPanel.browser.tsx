import { ThreadId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { QueuedFollowUpsPanel } from "./QueuedFollowUpsPanel";
import type { QueuedTurnDraft } from "../queuedTurnStore";

function makeQueuedTurn(overrides: Partial<QueuedTurnDraft> = {}): QueuedTurnDraft {
  const file = new File(["hello"], "queued.png", { type: "image/png" });
  return {
    id: overrides.id ?? crypto.randomUUID(),
    text: overrides.text ?? "Queued follow-up",
    createdAt: overrides.createdAt ?? "2026-04-16T12:00:00.000Z",
    images: overrides.images ?? [
      {
        type: "image",
        id: "image-1",
        name: "queued.png",
        mimeType: "image/png",
        sizeBytes: file.size,
        previewUrl: "data:image/png;base64,aGVsbG8=",
        file,
      },
    ],
    persistedAttachments: overrides.persistedAttachments ?? [
      {
        id: "image-1",
        name: "queued.png",
        mimeType: "image/png",
        sizeBytes: file.size,
        dataUrl: "data:image/png;base64,aGVsbG8=",
      },
    ],
    terminalContexts: overrides.terminalContexts ?? [],
    modelSelection: overrides.modelSelection ?? { instanceId: "codex" as any, model: "gpt-5" },
    promptEffort: overrides.promptEffort ?? null,
    runtimeMode: overrides.runtimeMode ?? "full-access",
    interactionMode: overrides.interactionMode ?? "default",
  };
}

async function mountPanel(props: Partial<ComponentProps<typeof QueuedFollowUpsPanel>> = {}) {
  const host = document.createElement("div");
  document.body.append(host);

  const onSendNow = vi.fn();
  const onSaveAsSnippet = vi.fn();
  const onDelete = vi.fn();
  const onClearAll = vi.fn();
  const onMove = vi.fn();
  const onReplaceText = vi.fn();

  const screen = await render(
    <QueuedFollowUpsPanel
      queuedItems={[
        makeQueuedTurn({ id: "turn-1", text: "First queued follow-up" }),
        makeQueuedTurn({
          id: "turn-2",
          text: "Second queued follow-up",
          terminalContexts: [
            {
              id: "ctx-2",
              threadId: ThreadId.make("thread-1"),
              createdAt: "2026-04-16T12:00:00.000Z",
              terminalId: "terminal-2",
              terminalLabel: "Terminal",
              lineStart: 10,
              lineEnd: 12,
              text: "pnpm lint",
            },
          ],
        }),
      ]}
      canSendNow={true}
      onSendNow={onSendNow}
      onSaveAsSnippet={onSaveAsSnippet}
      onDelete={onDelete}
      onClearAll={onClearAll}
      onMove={onMove}
      onReplaceText={onReplaceText}
      {...props}
    />,
    { container: host },
  );

  return {
    onSendNow,
    onSaveAsSnippet,
    onDelete,
    onClearAll,
    onMove,
    onReplaceText,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("QueuedFollowUpsPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders queued turns and wires row actions", async () => {
    const mounted = await mountPanel();

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("2 queued follow-ups");
        expect(document.body.textContent ?? "").toContain("First queued follow-up");
      });

      await page.getByRole("button", { name: "Edit queued follow-up" }).first().click();
      await page.getByRole("textbox").fill("Updated queued follow-up");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      expect(mounted.onReplaceText).toHaveBeenCalledWith(
        expect.objectContaining({ id: "turn-1" }),
        "Updated queued follow-up",
      );

      await page.getByRole("button", { name: "Send queued follow-up now" }).nth(1).click();
      expect(mounted.onSendNow).toHaveBeenCalledWith(expect.objectContaining({ id: "turn-2" }));

      await page.getByRole("button", { name: "Save queued follow-up as snippet" }).first().click();
      expect(mounted.onSaveAsSnippet).toHaveBeenCalledWith(
        expect.objectContaining({ id: "turn-1" }),
      );

      await page.getByRole("button", { name: "Remove queued follow-up" }).nth(1).click();
      expect(mounted.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "turn-2" }));

      await page.getByRole("button", { name: "Clear all" }).click();
      expect(mounted.onClearAll).toHaveBeenCalledTimes(1);

      await page.getByRole("button", { name: "Move queued follow-up down" }).first().click();
      expect(mounted.onMove).toHaveBeenCalledWith(expect.objectContaining({ id: "turn-1" }), 1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("disables send-now when queued dispatch is blocked", async () => {
    const mounted = await mountPanel({ canSendNow: false });

    try {
      await expect
        .element(page.getByRole("button", { name: "Send queued follow-up now" }).first())
        .toBeDisabled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports keyboard row traversal and reorder shortcuts", async () => {
    const mounted = await mountPanel();

    try {
      const firstRow = page.getByTestId("queued-follow-up-turn-1");
      await firstRow.click();
      (await firstRow.element())?.focus();

      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(document.activeElement?.getAttribute("data-testid")).toBe("queued-follow-up-turn-2");
      });

      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowUp",
          altKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(mounted.onMove).toHaveBeenCalledWith(expect.objectContaining({ id: "turn-2" }), 0);
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
