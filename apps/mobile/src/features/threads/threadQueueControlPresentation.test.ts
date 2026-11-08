import { formatAssistantCitationHref } from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveAdmissionWaitReason,
  resolveThreadQueueRowControls,
} from "./threadQueueControlPresentation";

describe("threadQueueControlPresentation", () => {
  it.each([
    { busy: false, isEditing: false, expected: true },
    { busy: true, isEditing: false, expected: false },
    { busy: false, isEditing: true, expected: false },
  ])(
    "gates sending a stopped thread's queued message with $busy busy and $isEditing editing",
    ({ busy, isEditing, expected }) => {
      const controls = resolveThreadQueueRowControls({
        busy,
        isEditing,
        canPromoteToSteer: false,
        canSendNow: true,
        text: "Queued message",
      });

      expect(controls.canSend).toBe(expected);
    },
  );

  it("shows an assistant quote as its quoted text", () => {
    const href = formatAssistantCitationHref({
      version: 1,
      environmentId: "environment:test" as never,
      threadId: "thread:test" as never,
      messageId: "message:assistant" as never,
      text: "Retry the sync after the lock clears.",
      start: 0,
      end: 37,
      prefix: "",
      suffix: "",
    });
    const controls = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canSendNow: false,
      text: `[Assistant quote](${href}) Can we add a backoff here?`,
    });

    expect(controls.displayText).toBe(
      "Retry the sync after the lock clears. Can we add a backoff here?",
    );
  });

  it("keeps the row already open in the composer from being reopened or steered", () => {
    const editing = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canSendNow: false,
      isEditing: true,
      text: "Being edited",
    });

    expect(editing.isEditing).toBe(true);
    expect(editing.canEdit).toBe(false);
    expect(editing.canSend).toBe(false);
    expect(editing.canDismiss).toBe(true);
  });

  it("lets the owner cancel a guest's queued message but not rewrite it", () => {
    const guest = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canSendNow: false,
      isGuestMessage: true,
      text: "Why?",
    });

    expect(guest.canEdit).toBe(false);
    expect(guest.canDismiss).toBe(true);
  });

  it("explains why a run waits for the host", () => {
    const admission = {
      runningTurns: 4,
      maxRunningTurns: 4,
      waitingTurns: 1,
      pacing: null,
      waitingThreadIds: [],
    };
    expect(resolveAdmissionWaitReason("capacity", admission)).toBe(
      "Waiting for a free slot (4/4 running)",
    );
    expect(resolveAdmissionWaitReason("capacity", undefined)).toBe("Waiting for a free slot");
    expect(resolveAdmissionWaitReason("host_load", { ...admission, pacing: "severe" })).toBe(
      "Waiting for the host: memory is critically low",
    );
    expect(resolveAdmissionWaitReason("host_load", { ...admission, pacing: "paced" })).toBe(
      "Starting turns one at a time while the host is busy",
    );
    expect(resolveAdmissionWaitReason(undefined, admission)).toBeNull();
  });
});
