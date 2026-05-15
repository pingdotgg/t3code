import "../../index.css";

import { MessageId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { RewindCheckpointCandidate } from "./MessagesTimeline.logic";
import { RewindCheckpointDialog } from "./RewindCheckpointDialog";

const candidates: RewindCheckpointCandidate[] = [
  {
    userMessageId: MessageId.make("user-2"),
    prompt: "Second prompt",
    createdAt: "2026-01-01T00:01:00Z",
    turnCount: 1,
    assistantTurnId: "turn-2" as never,
    changedFileCount: 2,
    additions: 3,
    deletions: 1,
  },
  {
    userMessageId: MessageId.make("user-1"),
    prompt: "First prompt",
    createdAt: "2026-01-01T00:00:00Z",
    turnCount: 0,
    assistantTurnId: "turn-1" as never,
    changedFileCount: 1,
    additions: 1,
    deletions: 0,
  },
];

describe("RewindCheckpointDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the search query when candidates refresh while open", async () => {
    const screen = await render(
      <RewindCheckpointDialog
        open
        candidates={candidates}
        isReverting={false}
        timestampFormat="locale"
        onOpenChange={() => undefined}
        onRestore={vi.fn()}
      />,
    );

    try {
      const searchInput = page.getByPlaceholder("Search prompts");
      await searchInput.fill("second");
      await expect.element(searchInput).toHaveValue("second");
      await expect.element(page.getByText("Second prompt")).toBeVisible();
      await expect.element(page.getByText("First prompt")).not.toBeInTheDocument();

      await screen.rerender(
        <RewindCheckpointDialog
          open
          candidates={[
            {
              ...candidates[0]!,
              changedFileCount: 3,
            },
            candidates[1]!,
          ]}
          isReverting={false}
          timestampFormat="locale"
          onOpenChange={() => undefined}
          onRestore={vi.fn()}
        />,
      );

      await expect.element(searchInput).toHaveValue("second");
      await expect.element(page.getByText("Second prompt")).toBeVisible();
      await expect.element(page.getByText("First prompt")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
