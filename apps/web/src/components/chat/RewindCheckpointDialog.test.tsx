import { MessageId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { RewindCheckpointCandidate } from "./MessagesTimeline.logic";
import { RewindCheckpointDialog } from "./RewindCheckpointDialog";
import {
  filterRewindCheckpointCandidates,
  isRewindRestoreDisabled,
} from "./RewindCheckpointDialog.logic";

vi.mock("../ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

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
  it("renders checkpoint candidates in the provided order", () => {
    const markup = renderToStaticMarkup(
      <RewindCheckpointDialog
        open
        candidates={candidates}
        isReverting={false}
        timestampFormat="locale"
        onOpenChange={() => undefined}
        onRestore={() => undefined}
      />,
    );

    expect(markup).toContain("Rewind checkpoint");
    expect(markup).toContain("Code and conversation");
    expect(markup.indexOf("Second prompt")).toBeLessThan(markup.indexOf("First prompt"));
    expect(markup).toContain("Checkpoint 1");
    expect(markup).toContain("Before first turn");
  });

  it("filters candidates by prompt text", () => {
    expect(filterRewindCheckpointCandidates(candidates, "second")).toEqual([candidates[0]]);
    expect(filterRewindCheckpointCandidates(candidates, "missing")).toEqual([]);
  });

  it("disables restore while reverting, blocked, or missing a selection", () => {
    expect(
      isRewindRestoreDisabled({
        isReverting: true,
        disabledReason: null,
        selected: candidates[0]!,
      }),
    ).toBe(true);
    expect(
      isRewindRestoreDisabled({
        isReverting: false,
        disabledReason: "Interrupt the current turn before reverting checkpoints.",
        selected: candidates[0]!,
      }),
    ).toBe(true);
    expect(
      isRewindRestoreDisabled({
        isReverting: false,
        disabledReason: null,
        selected: null,
      }),
    ).toBe(true);
    expect(
      isRewindRestoreDisabled({
        isReverting: false,
        disabledReason: null,
        selected: candidates[0]!,
      }),
    ).toBe(false);
  });
});
