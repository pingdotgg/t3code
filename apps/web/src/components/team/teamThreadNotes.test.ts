import {
  EnvironmentId,
  MessageId,
  RunId,
  TeamId,
  TeamMemberId,
  TeamThreadNoteId,
  ThreadId,
  type TeamPseudo,
  type TeamThreadNote,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  interleaveTeamThreadNoteRows,
  type MessagesTimelineRow,
} from "../chat/MessagesTimeline.logic";

function makeMessageRow(
  id: string,
  role: "user" | "assistant",
  runId?: string,
): MessagesTimelineRow {
  return {
    kind: "message",
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    message: {
      id: MessageId.make(id),
      role,
      text: `msg ${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      streaming: false,
      runId: runId ? RunId.make(runId) : null,
    },
    showAssistantMeta: role === "assistant",
    suppressEmptyResponse: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
    revertTurnCount: undefined,
    groupedWithNext: false,
    groupedWithPrevious: false,
    continuesSteer: false,
  };
}

function makeNote(
  overrides: Omit<Partial<TeamThreadNote>, "id"> & { readonly id: string },
): TeamThreadNote {
  const { id, ...rest } = overrides;
  return {
    id: TeamThreadNoteId.make(id),
    threadId: ThreadId.make("t-1"),
    teamId: TeamId.make("team-1"),
    authorMemberId: TeamMemberId.make("m-alice"),
    authorPseudo: "alice" as TeamPseudo,
    authorRole: "owner",
    originalBody: `Note ${id}`,
    originalContentHash: `hash-${id}`,
    editedBody: null,
    editedContentHash: null,
    status: "pending",
    anchorTurnId: null,
    anchorSeq: 1,
    includedInTurnId: null,
    resolvedByMemberId: null,
    resolvedByPseudo: null,
    resolvedAt: null,
    createdAt: "2026-01-01T00:00:01.000Z",
    ...rest,
  };
}

describe("interleaveTeamThreadNoteRows", () => {
  it("anchors notes chronologically after their anchorTurnId and moves re-anchored concurrent notes after the new turn", () => {
    const baseRows: MessagesTimelineRow[] = [
      makeMessageRow("m1", "user"),
      makeMessageRow("a1", "assistant", "run-1"),
      makeMessageRow("m2", "user"),
      makeMessageRow("a2", "assistant", "run-2"),
    ];
    const acceptedNote = makeNote({
      id: "note-1",
      status: "consumed",
      anchorTurnId: "run-1",
      anchorSeq: 1,
      includedInTurnId: "run-2",
    });
    const concurrentReanchoredNote = makeNote({
      id: "note-2",
      status: "pending",
      anchorTurnId: "run-2",
      anchorSeq: 2,
    });
    const unanchoredNote = makeNote({
      id: "note-3",
      status: "rejected",
      anchorTurnId: null,
      anchorSeq: 3,
    });

    const rows = interleaveTeamThreadNoteRows(baseRows, [
      unanchoredNote,
      concurrentReanchoredNote,
      acceptedNote,
    ]);
    expect(rows.map((row) => row.id)).toEqual([
      "m1",
      "a1",
      "team-note:note-1",
      "m2",
      "a2",
      "team-note:note-2",
      "team-note:note-3",
    ]);
  });

  it("returns the same array reference with zero overhead when there are no notes", () => {
    const baseRows: MessagesTimelineRow[] = [makeMessageRow("m1", "user")];
    expect(interleaveTeamThreadNoteRows(baseRows, [])).toBe(baseRows);
    expect(EnvironmentId.make("env-1")).toBe("env-1");
  });
});
