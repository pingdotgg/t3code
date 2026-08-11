import { describe, expect, it, vi } from "@effect/vitest";

import {
  prepareDesktopMicrophoneAccess,
  pendingVoiceConfirmationAnnouncement,
  selectVoicePanelHistory,
  voiceConfirmationPreviewRows,
} from "./VoiceSupervisorHost.logic";
import type { VoiceSupervisorConfirmationPreview } from "../../voice/voiceSupervisorHost";

function preview(value: VoiceSupervisorConfirmationPreview) {
  return { preview: value };
}

describe("voice confirmation preview", () => {
  it("shows the frozen start-thread instruction, model, and workspace behavior", () => {
    expect(
      voiceConfirmationPreviewRows(
        preview({
          operation: "start_thread",
          instruction: "Fix the login race",
          target: "T3 Code",
          title: "Fix login",
          model: "gpt-5.4",
          runtimeMode: "full-access",
          interactionMode: "plan",
          workspace: {
            mode: "worktree",
            baseBranch: "main",
            startFromOrigin: true,
            runSetupScript: true,
          },
        }),
      ),
    ).toEqual([
      { label: "Target", value: "T3 Code" },
      { label: "Title", value: "Fix login" },
      { label: "Instruction", value: "Fix the login race" },
      { label: "Model", value: "gpt-5.4" },
      { label: "Runtime mode", value: "full-access" },
      { label: "Interaction mode", value: "plan" },
      { label: "Workspace", value: "worktree · base main · from origin" },
      { label: "Setup script", value: "Runs before the thread" },
    ]);
  });

  it("shows the frozen follow-up instruction and model", () => {
    expect(
      voiceConfirmationPreviewRows(
        preview({
          operation: "send_follow_up",
          instruction: "Run the focused tests",
          target: "Fix login",
          model: "claude-opus-4-6",
        }),
      ),
    ).toEqual([
      { label: "Target", value: "Fix login" },
      { label: "Instruction", value: "Run the focused tests" },
      { label: "Model", value: "claude-opus-4-6" },
    ]);
  });

  it("shows whether an interrupt targets an active turn", () => {
    expect(
      voiceConfirmationPreviewRows(
        preview({ operation: "interrupt_thread", target: "Fix login", hasActiveTurn: true }),
      ),
    ).toEqual([
      { label: "Target", value: "Fix login" },
      { label: "Active turn", value: "Running now" },
    ]);
  });
});

describe("voice panel history", () => {
  it("renders only recent bounded rows and clips the completed live announcement", () => {
    const transcript = Array.from({ length: 45 }, (_, index) => ({
      id: `transcript-${index}`,
      speaker: "assistant" as const,
      text: index === 44 ? "x".repeat(3_000) : `Transcript ${index}`,
      status: "complete" as const,
      updatedAt: index,
    }));
    const activity = Array.from({ length: 45 }, (_, index) => ({
      id: `activity-${index}`,
      kind: "response" as const,
      label: `Activity ${index}`,
      at: index,
    }));

    const selected = selectVoicePanelHistory({ transcript, activity });
    expect(selected.transcript).toHaveLength(40);
    expect(selected.transcript[0]?.id).toBe("transcript-5");
    expect(selected.transcript.at(-1)?.text).toHaveLength(2_000);
    expect(selected.activity).toHaveLength(40);
    expect(selected.activity[0]?.id).toBe("activity-5");
    expect(selected.completedAnnouncement).toHaveLength(500);
  });

  it("announces a bounded pending confirmation only while the panel is hidden", () => {
    const confirmations = [{ summary: `Start ${"x".repeat(1_000)}` }];
    expect(pendingVoiceConfirmationAnnouncement(confirmations, false)).toHaveLength(500);
    expect(pendingVoiceConfirmationAnnouncement(confirmations, false)).toContain(
      "1 voice confirmation pending",
    );
    expect(pendingVoiceConfirmationAnnouncement(confirmations, true)).toBeUndefined();
    expect(pendingVoiceConfirmationAnnouncement([], false)).toBeUndefined();
  });
});

describe("desktop microphone preflight", () => {
  it("does nothing when the desktop bridge is absent", async () => {
    await expect(prepareDesktopMicrophoneAccess(undefined)).resolves.toEqual({ status: "ready" });
  });

  it("requests a not-yet-determined macOS permission only on preflight", async () => {
    const requestMicrophoneAccess = vi.fn(async () => "granted" as const);
    await expect(
      prepareDesktopMicrophoneAccess({
        getMicrophoneAccessStatus: async () => "not-determined",
        requestMicrophoneAccess,
      }),
    ).resolves.toEqual({ status: "ready" });
    expect(requestMicrophoneAccess).toHaveBeenCalledOnce();
  });

  it("reports denied access without requesting it again", async () => {
    const requestMicrophoneAccess = vi.fn(async () => "granted" as const);
    await expect(
      prepareDesktopMicrophoneAccess({
        getMicrophoneAccessStatus: async () => "denied",
        requestMicrophoneAccess,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      message: expect.stringContaining("System Settings"),
    });
    expect(requestMicrophoneAccess).not.toHaveBeenCalled();
  });

  it("redacts native permission failures", async () => {
    await expect(
      prepareDesktopMicrophoneAccess({
        getMicrophoneAccessStatus: async () => {
          throw new Error("native-secret");
        },
      }),
    ).resolves.toEqual({
      status: "blocked",
      message: "T3 Code could not check the desktop microphone permission. Try again.",
    });
  });
});
