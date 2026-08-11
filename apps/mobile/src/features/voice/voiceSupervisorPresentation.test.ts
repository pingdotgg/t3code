import type { VoiceSupervisorConfirmation } from "../../voice/voiceSupervisorHost";
import type {
  VoiceActivityEntry,
  VoiceTranscriptEntry,
} from "@t3tools/client-runtime/voice/voice-supervisor-state";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyMobileVoiceEnvironmentAvailability,
  MAX_MOBILE_VOICE_ACTIVITY_ROWS,
  MAX_MOBILE_VOICE_ANNOUNCEMENT_CHARS,
  MAX_MOBILE_VOICE_ROW_TEXT_CHARS,
  MAX_MOBILE_VOICE_TRANSCRIPT_ROWS,
  mobileVoiceConfirmationAccessibilityLabel,
  pendingMobileVoiceConfirmationAnnouncement,
  selectMobileVoiceHistory,
  shouldShowVoiceForegroundButton,
  visibleMobileVoiceError,
  voiceConfirmationPreviewRows,
  voiceForegroundButtonPosition,
  voiceForegroundButtonPresentation,
} from "./voiceSupervisorPresentation";

function transcript(index: number, text = `Transcript ${index}`): VoiceTranscriptEntry {
  return {
    id: `transcript-${index}`,
    speaker: index % 2 === 0 ? "user" : "assistant",
    text,
    status: "complete",
    updatedAt: index,
  };
}

function activity(index: number, label = `Activity ${index}`): VoiceActivityEntry {
  return { id: `activity-${index}`, kind: "session", label, at: index };
}

function confirmation(
  preview: VoiceSupervisorConfirmation["preview"],
): VoiceSupervisorConfirmation {
  return Object.freeze({
    generation: 1,
    callId: "call-mobile",
    action: preview.operation,
    summary: "Confirm this action",
    preview,
  });
}

describe("mobile Voice Supervisor presentation", () => {
  it("bounds rendered transcript/activity work independently and clips announcements", () => {
    const long = "x".repeat(MAX_MOBILE_VOICE_ROW_TEXT_CHARS + 100);
    const transcriptEntries = Array.from(
      { length: MAX_MOBILE_VOICE_TRANSCRIPT_ROWS + 5 },
      (_, index) =>
        transcript(index, index === MAX_MOBILE_VOICE_TRANSCRIPT_ROWS + 4 ? long : undefined),
    );
    const activityEntries = Array.from({ length: MAX_MOBILE_VOICE_ACTIVITY_ROWS + 7 }, (_, index) =>
      activity(index, index === MAX_MOBILE_VOICE_ACTIVITY_ROWS + 6 ? long : undefined),
    );
    const selected = selectMobileVoiceHistory({
      transcript: transcriptEntries,
      activity: activityEntries,
    });

    const transcriptItems = selected.items.filter((item) => item.kind === "transcript");
    const activityItems = selected.items.filter((item) => item.kind === "activity");
    expect(transcriptItems).toHaveLength(MAX_MOBILE_VOICE_TRANSCRIPT_ROWS);
    expect(activityItems).toHaveLength(MAX_MOBILE_VOICE_ACTIVITY_ROWS);
    expect(transcriptItems[0]?.entry.id).toBe("transcript-5");
    expect(activityItems[0]?.entry.id).toBe("activity-7");
    expect(transcriptItems.at(-1)?.entry.text).toHaveLength(MAX_MOBILE_VOICE_ROW_TEXT_CHARS);
    expect(activityItems.at(-1)?.entry.label).toHaveLength(MAX_MOBILE_VOICE_ROW_TEXT_CHARS);
    expect(selected.completedAnnouncement).toHaveLength(MAX_MOBILE_VOICE_ANNOUNCEMENT_CHARS);
  });

  it("announces hidden confirmations only and clips hostile summaries", () => {
    const announcement = pendingMobileVoiceConfirmationAnnouncement(
      { count: 2, summary: "secret ".repeat(200) },
      false,
    );
    expect(announcement).toHaveLength(MAX_MOBILE_VOICE_ANNOUNCEMENT_CHARS);
    expect(announcement).toMatch(/^2 voice confirmations pending/);
    expect(
      pendingMobileVoiceConfirmationAnnouncement({ count: 2, summary: "pending" }, true),
    ).toBeNull();
    expect(
      pendingMobileVoiceConfirmationAnnouncement({ count: 0, summary: null }, false),
    ).toBeNull();
    expect(mobileVoiceConfirmationAccessibilityLabel({ summary: "x".repeat(1_000) })).toHaveLength(
      MAX_MOBILE_VOICE_ANNOUNCEMENT_CHARS,
    );
  });

  it("renders every material field from frozen trusted confirmation previews", () => {
    const start = confirmation(
      Object.freeze({
        operation: "start_thread",
        instruction: "Implement the mobile fix",
        target: "T3 · Laptop",
        title: "Mobile fix",
        model: "codex / gpt-5.6",
        runtimeMode: "full-access",
        interactionMode: "default",
        workspace: Object.freeze({
          mode: "worktree",
          baseBranch: "main",
          startFromOrigin: true,
          runSetupScript: true,
        }),
      }),
    );
    expect(voiceConfirmationPreviewRows(start)).toEqual([
      { label: "Target", value: "T3 · Laptop" },
      { label: "Title", value: "Mobile fix" },
      { label: "Instruction", value: "Implement the mobile fix" },
      { label: "Model", value: "codex / gpt-5.6" },
      { label: "Runtime mode", value: "full-access" },
      { label: "Interaction mode", value: "default" },
      { label: "Workspace", value: "worktree · base main · from origin" },
      { label: "Setup script", value: "Runs before the thread" },
    ]);

    const interrupt = confirmation(
      Object.freeze({
        operation: "interrupt_thread",
        target: "Thread · Desktop",
        hasActiveTurn: true,
      }),
    );
    expect(voiceConfirmationPreviewRows(interrupt)).toEqual([
      { label: "Target", value: "Thread · Desktop" },
      { label: "Active turn", value: "Running now" },
    ]);

    const followUp = confirmation(
      Object.freeze({
        operation: "send_follow_up",
        instruction: "Run the focused checks",
        target: "Thread · Laptop",
        model: "codex / gpt-5.6",
      }),
    );
    expect(voiceConfirmationPreviewRows(followUp)).toEqual([
      { label: "Target", value: "Thread · Laptop" },
      { label: "Instruction", value: "Run the focused checks" },
      { label: "Model", value: "codex / gpt-5.6" },
    ]);
  });

  it("reports honest environment reverse states", () => {
    expect(
      classifyMobileVoiceEnvironmentAvailability({
        catalogReady: false,
        connectionPhase: null,
        hasServerConfig: false,
        supportsRealtimeVoice: false,
        hasPreparedConnection: false,
      }),
    ).toMatchObject({ message: "Loading execution environments…" });
    expect(
      classifyMobileVoiceEnvironmentAvailability({
        catalogReady: true,
        connectionPhase: "connected",
        hasServerConfig: true,
        supportsRealtimeVoice: false,
        hasPreparedConnection: true,
      }),
    ).toMatchObject({ kind: "unavailable", message: expect.stringContaining("Update") });
    expect(
      classifyMobileVoiceEnvironmentAvailability({
        catalogReady: true,
        connectionPhase: "connected",
        hasServerConfig: true,
        supportsRealtimeVoice: true,
        hasPreparedConnection: true,
      }),
    ).toMatchObject({ kind: "ready", message: expect.stringContaining("microphone") });
    expect(AVAILABLE_CONNECTION_STATE.generation).toBe(0);
  });

  it("keeps the portal control inside portrait, landscape, keyboard, and tiny viewports", () => {
    const portrait = voiceForegroundButtonPosition({
      windowHeight: 844,
      safeAreaTop: 47,
      safeAreaBottom: 34,
      safeAreaTrailing: 0,
      keyboardHeight: 0,
    });
    const keyboard = voiceForegroundButtonPosition({
      windowHeight: 844,
      safeAreaTop: 47,
      safeAreaBottom: 34,
      safeAreaTrailing: 32,
      keyboardHeight: 320,
    });
    const landscape = voiceForegroundButtonPosition({
      windowHeight: 390,
      safeAreaTop: 0,
      safeAreaBottom: 21,
      safeAreaTrailing: 59,
      keyboardHeight: 0,
    });
    const tiny = voiceForegroundButtonPosition({
      windowHeight: 60,
      safeAreaTop: 40,
      safeAreaBottom: 30,
      safeAreaTrailing: 0,
      keyboardHeight: 40,
    });

    expect(portrait).toEqual({ top: 406.5, trailing: 20 });
    expect(keyboard.top).toBeLessThan(portrait.top);
    expect(keyboard.trailing).toBe(32);
    expect(landscape.top).toBeGreaterThanOrEqual(0);
    expect(landscape.top + 44).toBeLessThanOrEqual(390 - 21);
    expect(tiny.top).toBeGreaterThanOrEqual(0);
    expect(tiny.top + 44).toBeLessThanOrEqual(60);
  });

  it("derives static launcher states without transcript input", () => {
    expect(
      voiceForegroundButtonPresentation({
        generation: 0,
        phase: "idle",
        muted: false,
        pendingConfirmationCount: 0,
        pendingConfirmationSummary: null,
      }),
    ).toBeNull();
    expect(
      voiceForegroundButtonPresentation({
        generation: 3,
        phase: "connected",
        muted: false,
        pendingConfirmationCount: 0,
        pendingConfirmationSummary: null,
      }),
    ).toMatchObject({ tone: "listening", icon: "mic" });
    expect(
      voiceForegroundButtonPresentation({
        generation: 3,
        phase: "connected",
        muted: false,
        pendingConfirmationCount: 2,
        pendingConfirmationSummary: "Start work",
      }),
    ).toMatchObject({
      tone: "pending",
      pendingCount: 2,
      icon: "mic",
      label: expect.stringContaining("Microphone listening"),
    });
    const active = {
      generation: 3,
      phase: "connected" as const,
      muted: false,
      pendingConfirmationCount: 1,
      pendingConfirmationSummary: "Approve",
    };
    expect(shouldShowVoiceForegroundButton(active, false)).toBe(true);
    expect(shouldShowVoiceForegroundButton(active, true)).toBe(false);
    expect(visibleMobileVoiceError("Latest microphone error", "Earlier session error")).toBe(
      "Latest microphone error",
    );
  });
});
