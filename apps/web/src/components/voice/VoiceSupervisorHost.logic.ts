import {
  connectionProjectionPhase,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import type { VoiceSupervisorConfirmation } from "../../voice/voiceSupervisorHost";
import type { VoiceActivityEntry, VoiceTranscriptEntry } from "../../voice/voiceSupervisorStore";
import type { DesktopBridge } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPreparedConnection } from "../../state/session";
import { serverEnvironment } from "../../state/server";

export const MAX_VOICE_PANEL_TRANSCRIPT_ROWS = 40;
export const MAX_VOICE_PANEL_ACTIVITY_ROWS = 40;
export const MAX_VOICE_PANEL_TRANSCRIPT_TEXT_CHARS = 2_000;
export const MAX_VOICE_PANEL_ANNOUNCEMENT_CHARS = 500;

export interface VoiceConfirmationPreviewRow {
  readonly label: string;
  readonly value: string;
}

export type DesktopMicrophonePreflightResult =
  | { readonly status: "ready" }
  | { readonly status: "blocked"; readonly message: string };

function clipPanelText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

export function selectVoicePanelHistory(input: {
  readonly transcript: ReadonlyArray<VoiceTranscriptEntry>;
  readonly activity: ReadonlyArray<VoiceActivityEntry>;
}) {
  const transcript = input.transcript.slice(-MAX_VOICE_PANEL_TRANSCRIPT_ROWS).map((entry) => ({
    ...entry,
    text: clipPanelText(entry.text, MAX_VOICE_PANEL_TRANSCRIPT_TEXT_CHARS),
  }));
  const completed = input.transcript.findLast((entry) => entry.status === "complete");
  return {
    transcript,
    activity: input.activity.slice(-MAX_VOICE_PANEL_ACTIVITY_ROWS),
    completedAnnouncement:
      completed === undefined
        ? undefined
        : clipPanelText(completed.text, MAX_VOICE_PANEL_ANNOUNCEMENT_CHARS),
  };
}

export function pendingVoiceConfirmationAnnouncement(
  confirmations: ReadonlyArray<Pick<VoiceSupervisorConfirmation, "summary">>,
  panelOpen: boolean,
): string | undefined {
  if (panelOpen || confirmations.length === 0) return undefined;
  const count = confirmations.length;
  return clipPanelText(
    `${count} voice confirmation${count === 1 ? "" : "s"} pending. ${confirmations[0]?.summary ?? ""}`,
    MAX_VOICE_PANEL_ANNOUNCEMENT_CHARS,
  );
}

/** Revalidates the exact host authority after an asynchronous OS permission prompt. */
export function readAuthoritativeVoiceHostConnection(
  environmentId: Parameters<typeof environmentCatalog.stateAtom>[0],
): PreparedConnection | null {
  const connection = Option.getOrNull(
    AsyncResult.value(appAtomRegistry.get(environmentCatalog.stateAtom(environmentId))),
  );
  if (connection === null || connectionProjectionPhase(connection) !== "ready") return null;
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
  if (config?.environment.capabilities.realtimeVoice !== true) return null;
  const prepared = readPreparedConnection(environmentId);
  return prepared?.environmentId === environmentId ? prepared : null;
}

export async function prepareDesktopMicrophoneAccess(
  bridge: Pick<DesktopBridge, "getMicrophoneAccessStatus" | "requestMicrophoneAccess"> | undefined,
): Promise<DesktopMicrophonePreflightResult> {
  if (!bridge?.getMicrophoneAccessStatus) return { status: "ready" };
  try {
    const current = await bridge.getMicrophoneAccessStatus();
    if (current === "granted" || current === "unsupported" || current === "unknown") {
      return { status: "ready" };
    }
    if (current === "denied" || current === "restricted") {
      return {
        status: "blocked",
        message:
          "Microphone access is blocked. Allow T3 Code to use the microphone in System Settings.",
      };
    }
    if (!bridge.requestMicrophoneAccess) return { status: "ready" };
    const requested = await bridge.requestMicrophoneAccess();
    return requested === "granted" || requested === "unsupported"
      ? { status: "ready" }
      : {
          status: "blocked",
          message:
            "Microphone access was not granted. Allow T3 Code to use the microphone in System Settings.",
        };
  } catch {
    return {
      status: "blocked",
      message: "T3 Code could not check the desktop microphone permission. Try again.",
    };
  }
}

/** Projects only the trusted, frozen local preview captured by the supervisor core. */
export function voiceConfirmationPreviewRows(
  confirmation: Pick<VoiceSupervisorConfirmation, "preview">,
): ReadonlyArray<VoiceConfirmationPreviewRow> {
  const preview = confirmation.preview;
  const rows: VoiceConfirmationPreviewRow[] = [];
  rows.push({ label: "Target", value: preview.target });
  if (preview.operation === "start_thread") {
    rows.push({ label: "Title", value: preview.title });
  }
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
