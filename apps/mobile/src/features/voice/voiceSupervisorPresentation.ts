import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { VoiceSupervisorConfirmation } from "../../voice/voiceSupervisorHost";
import type { MobileVoiceSupervisorCompactState } from "../../voice/voiceSupervisorRuntime";
import type {
  VoiceActivityEntry,
  VoiceTranscriptEntry,
} from "@t3tools/client-runtime/voice/voice-supervisor-state";
import type { RealtimeVoice } from "@t3tools/contracts";

export const MAX_MOBILE_VOICE_TRANSCRIPT_ROWS = 40;
export const MAX_MOBILE_VOICE_ACTIVITY_ROWS = 40;
export const MAX_MOBILE_VOICE_ROW_TEXT_CHARS = 2_000;
export const MAX_MOBILE_VOICE_ANNOUNCEMENT_CHARS = 500;
export const VOICE_FOREGROUND_BUTTON_SIZE = 44;
export const VOICE_FOREGROUND_BUTTON_EDGE_INSET = 20;
export const VOICE_FOREGROUND_BUTTON_VERTICAL_MARGIN = 56;

export type MobileVoiceHistoryItem =
  | {
      readonly kind: "transcript";
      readonly key: string;
      readonly entry: VoiceTranscriptEntry;
    }
  | {
      readonly kind: "activity";
      readonly key: string;
      readonly entry: VoiceActivityEntry;
    };

export type MobileVoiceEnvironmentAvailability =
  | { readonly kind: "ready"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

export interface VoiceConfirmationPreviewRow {
  readonly label: string;
  readonly value: string;
}

export interface VoiceForegroundButtonPositionInput {
  readonly windowHeight: number;
  readonly safeAreaTop: number;
  readonly safeAreaBottom: number;
  readonly safeAreaTrailing: number;
  readonly keyboardHeight: number;
}

export interface VoiceForegroundButtonPresentation {
  readonly label: string;
  readonly icon: "mic" | "mic.slash";
  readonly tone: "connecting" | "listening" | "muted" | "pending" | "failed";
  readonly pendingCount: number;
}

function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function selectMobileVoiceHistory(input: {
  readonly generation: number;
  readonly transcript: ReadonlyArray<VoiceTranscriptEntry>;
  readonly activity: ReadonlyArray<VoiceActivityEntry>;
}): {
  readonly items: ReadonlyArray<MobileVoiceHistoryItem>;
  readonly completedAnnouncement: {
    readonly key: string;
    readonly text: string;
  } | null;
} {
  const transcript = input.transcript.slice(-MAX_MOBILE_VOICE_TRANSCRIPT_ROWS);
  const activity = input.activity.slice(-MAX_MOBILE_VOICE_ACTIVITY_ROWS);
  const completed = input.transcript.findLast((entry) => entry.status === "complete");
  return {
    items: [
      ...transcript.map(
        (entry): MobileVoiceHistoryItem => ({
          kind: "transcript",
          key: `transcript:${entry.speaker}:${entry.id}`,
          entry: {
            ...entry,
            text: clipText(entry.text, MAX_MOBILE_VOICE_ROW_TEXT_CHARS),
          },
        }),
      ),
      ...activity.map(
        (entry): MobileVoiceHistoryItem => ({
          kind: "activity",
          key: `activity:${entry.id}`,
          entry: {
            ...entry,
            label: clipText(entry.label, MAX_MOBILE_VOICE_ROW_TEXT_CHARS),
          },
        }),
      ),
    ],
    completedAnnouncement:
      completed === undefined
        ? null
        : {
            key: `transcript:${input.generation}:${completed.speaker}:${completed.id}:${completed.updatedAt}`,
            text: clipText(completed.text, MAX_MOBILE_VOICE_ANNOUNCEMENT_CHARS),
          },
  };
}

export function pendingMobileVoiceConfirmationAnnouncement(
  pending: { readonly count: number; readonly summary: string | null },
  routeVisible: boolean,
): string | null {
  if (routeVisible || pending.count === 0) return null;
  const count = pending.count;
  return clipText(
    `${count} voice confirmation${count === 1 ? "" : "s"} pending. ${pending.summary ?? ""}`,
    MAX_MOBILE_VOICE_ANNOUNCEMENT_CHARS,
  );
}

export function mobileVoiceConfirmationAccessibilityLabel(
  confirmation: Pick<VoiceSupervisorConfirmation, "summary">,
): string {
  return clipText(
    `Confirmation required. ${confirmation.summary}`,
    MAX_MOBILE_VOICE_ANNOUNCEMENT_CHARS,
  );
}

export function classifyMobileVoiceEnvironmentAvailability(input: {
  readonly catalogReady: boolean;
  readonly connectionPhase: EnvironmentConnectionPhase | null;
  readonly hasServerConfig: boolean;
  readonly supportsRealtimeVoice: boolean;
  readonly hasPreparedConnection: boolean;
}): MobileVoiceEnvironmentAvailability {
  if (!input.catalogReady) {
    return { kind: "unavailable", message: "Loading execution environments…" };
  }
  if (input.connectionPhase === null) {
    return { kind: "unavailable", message: "This environment is not connected." };
  }
  if (
    input.connectionPhase === "available" ||
    input.connectionPhase === "offline" ||
    input.connectionPhase === "error"
  ) {
    return { kind: "unavailable", message: "This environment is offline." };
  }
  if (
    input.connectionPhase === "connecting" ||
    input.connectionPhase === "reconnecting" ||
    !input.hasServerConfig ||
    !input.hasPreparedConnection
  ) {
    return { kind: "unavailable", message: "Preparing the secure voice connection…" };
  }
  if (!input.supportsRealtimeVoice) {
    return {
      kind: "unavailable",
      message: "Update the selected T3 Code environment to use Voice Supervisor.",
    };
  }
  return { kind: "ready", message: "Ready to start. Your microphone stays off until Start." };
}

export function voiceConfirmationPreviewRows(
  confirmation: Pick<VoiceSupervisorConfirmation, "preview">,
): ReadonlyArray<VoiceConfirmationPreviewRow> {
  const preview = confirmation.preview;
  const rows: VoiceConfirmationPreviewRow[] = [{ label: "Target", value: preview.target }];
  if (preview.operation === "start_thread") rows.push({ label: "Title", value: preview.title });
  if (preview.operation !== "interrupt_thread") {
    rows.push({ label: "Instruction", value: preview.instruction });
    rows.push({ label: "Model", value: preview.model });
  }
  if (preview.operation === "start_thread") {
    rows.push({ label: "Runtime mode", value: preview.runtimeMode });
    rows.push({ label: "Interaction mode", value: preview.interactionMode });
    rows.push({
      label: "Workspace",
      value:
        preview.workspace.mode === "worktree"
          ? `worktree · base ${preview.workspace.baseBranch}${preview.workspace.startFromOrigin ? " · from origin" : " · local ref"}`
          : `local${preview.workspace.branch === null ? "" : ` · branch ${preview.workspace.branch}`}${preview.workspace.hasWorktreePath ? " · existing worktree" : " · project workspace"}`,
    });
    rows.push({
      label: "Setup script",
      value: preview.workspace.runSetupScript ? "Runs before the thread" : "Does not run",
    });
  }
  if (preview.operation === "interrupt_thread") {
    rows.push({
      label: "Active turn",
      value: preview.hasActiveTurn ? "Running now" : "No active turn detected",
    });
  }
  return rows;
}

export function voiceForegroundButtonPosition(input: VoiceForegroundButtonPositionInput): {
  readonly top: number;
  readonly trailing: number;
} {
  const windowHeight = Math.max(VOICE_FOREGROUND_BUTTON_SIZE, input.windowHeight);
  const visibleBottom = Math.max(
    0,
    windowHeight - Math.max(0, input.safeAreaBottom) - Math.max(0, input.keyboardHeight),
  );
  const safeTop = Math.min(
    Math.max(0, input.safeAreaTop),
    Math.max(0, visibleBottom - VOICE_FOREGROUND_BUTTON_SIZE),
  );
  const lowestTop = Math.max(safeTop, visibleBottom - VOICE_FOREGROUND_BUTTON_SIZE);
  const preferredMin = Math.min(lowestTop, safeTop + VOICE_FOREGROUND_BUTTON_VERTICAL_MARGIN);
  const preferredMax = Math.max(
    preferredMin,
    visibleBottom - VOICE_FOREGROUND_BUTTON_VERTICAL_MARGIN - VOICE_FOREGROUND_BUTTON_SIZE,
  );
  const centered = (safeTop + visibleBottom - VOICE_FOREGROUND_BUTTON_SIZE) / 2;
  return {
    top: Math.min(preferredMax, Math.max(preferredMin, centered)),
    trailing: Math.max(VOICE_FOREGROUND_BUTTON_EDGE_INSET, input.safeAreaTrailing),
  };
}

export function voiceForegroundButtonPresentation(
  state: MobileVoiceSupervisorCompactState,
): VoiceForegroundButtonPresentation | null {
  if (state.pendingConfirmationCount > 0) {
    const listening = state.phase === "connected" && !state.muted;
    return {
      label: `${state.pendingConfirmationCount} voice confirmation${state.pendingConfirmationCount === 1 ? "" : "s"} pending. Microphone ${listening ? "listening" : "muted"}. Open Voice Supervisor.`,
      icon: listening ? "mic" : "mic.slash",
      tone: "pending",
      pendingCount: state.pendingConfirmationCount,
    };
  }
  switch (state.phase) {
    case "idle":
      return null;
    case "connecting":
      return {
        label: "Voice Supervisor connecting. Microphone muted.",
        icon: "mic.slash",
        tone: "connecting",
        pendingCount: 0,
      };
    case "connected":
      return state.muted
        ? {
            label: "Voice Supervisor connected. Microphone muted.",
            icon: "mic.slash",
            tone: "muted",
            pendingCount: 0,
          }
        : {
            label: "Voice Supervisor listening.",
            icon: "mic",
            tone: "listening",
            pendingCount: 0,
          };
    case "failed":
      return {
        label: "Voice Supervisor connection failed. Open to retry.",
        icon: "mic.slash",
        tone: "failed",
        pendingCount: 0,
      };
  }
}

export function shouldShowVoiceForegroundButton(
  state: MobileVoiceSupervisorCompactState,
  routeVisible: boolean,
): boolean {
  return !routeVisible && voiceForegroundButtonPresentation(state) !== null;
}

export function visibleMobileVoiceError(
  startError: string | null,
  sessionError: string | null,
): string | null {
  return startError ?? sessionError;
}

export function voiceLabel(voice: RealtimeVoice): string {
  return `${voice[0].toUpperCase()}${voice.slice(1)}`;
}
