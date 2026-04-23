import { MessageId } from "@forma/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerQueuedTurnsPanel } from "./ComposerQueuedTurnsPanel";

describe("ComposerQueuedTurnsPanel", () => {
  it("renders queued turns as minimal prompt-only rows", () => {
    const html = renderToStaticMarkup(
      <ComposerQueuedTurnsPanel
        turnQueue={{
          items: [
            {
              messageId: MessageId.make("queued-1"),
              text: "Ship the queue UI",
              attachmentIds: ["attachment-1", "attachment-2"],
              modelSelection: {
                provider: "codex",
                model: "gpt-5.3-codex",
              },
              runtimeMode: "approval-required",
              interactionMode: "plan",
              titleSeed: "Queue UI",
              sourceProposedPlan: null,
              queuedAt: "2026-02-27T00:00:00.000Z",
            },
          ],
          status: "queued",
          pauseReason: null,
        }}
        onRemoveQueuedTurn={() => undefined}
        onResumeTurnQueue={() => undefined}
      />,
    );

    expect(html).toContain("Queued");
    expect(html).toContain("1 queued");
    expect(html).toContain("Ship the queue UI");
    expect(html).toContain('data-composer-queue-panel="true"');
    expect(html).toContain('aria-label="Remove queued turn: Ship the queue UI"');
    expect(html).not.toContain("Next");
    expect(html).not.toContain("gpt-5.3-codex");
  });

  it("renders paused queues with an explicit resume action", () => {
    const html = renderToStaticMarkup(
      <ComposerQueuedTurnsPanel
        turnQueue={{
          items: [
            {
              messageId: MessageId.make("queued-1"),
              text: "Retry queued prompt",
              attachmentIds: [],
              modelSelection: {
                provider: "codex",
                model: "gpt-5-codex",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              titleSeed: null,
              sourceProposedPlan: null,
              queuedAt: "2026-02-27T00:00:00.000Z",
            },
          ],
          status: "paused",
          pauseReason: "error",
        }}
        onRemoveQueuedTurn={() => undefined}
        onResumeTurnQueue={() => undefined}
      />,
    );

    expect(html).toContain("Paused");
    expect(html).toContain("Resume queue");
  });

  it("shows an image-only fallback label", () => {
    const html = renderToStaticMarkup(
      <ComposerQueuedTurnsPanel
        turnQueue={{
          items: [
            {
              messageId: MessageId.make("queued-image-only"),
              text: "   ",
              attachmentIds: ["attachment-1"],
              modelSelection: {
                provider: "codex",
                model: "gpt-5-codex",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              titleSeed: null,
              sourceProposedPlan: null,
              queuedAt: "2026-02-27T00:00:00.000Z",
            },
          ],
          status: "queued",
          pauseReason: null,
        }}
        onRemoveQueuedTurn={() => undefined}
        onResumeTurnQueue={() => undefined}
      />,
    );

    expect(html).toContain("(Image-only prompt)");
  });

  it("renders an icon-only remove action for each row", () => {
    const html = renderToStaticMarkup(
      <ComposerQueuedTurnsPanel
        turnQueue={{
          items: [
            {
              messageId: MessageId.make("queued-remove"),
              text: "Remove me",
              attachmentIds: [],
              modelSelection: {
                provider: "codex",
                model: "gpt-5-codex",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              titleSeed: null,
              sourceProposedPlan: null,
              queuedAt: "2026-02-27T00:00:00.000Z",
            },
          ],
          status: "queued",
          pauseReason: null,
        }}
        onRemoveQueuedTurn={() => undefined}
        onResumeTurnQueue={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Remove queued turn: Remove me"');
  });
});
