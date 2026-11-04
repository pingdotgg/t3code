export type GeminiLiveStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "executing_tool"
  | "error";

export const GEMINI_VOICE_NAMES = ["Puck", "Charon", "Kore", "Fenrir", "Aoede"] as const;
export type GeminiVoiceName = (typeof GEMINI_VOICE_NAMES)[number];

export const GEMINI_LIVE_MODELS = [
  {
    id: "models/gemini-2.0-flash-exp",
    label: "Gemini 2.0 Flash Live (Default)",
  },
  {
    id: "models/gemini-2.5-flash-native-audio-preview-12-2025",
    label: "Gemini 2.5 Flash Native Audio",
  },
] as const;

export interface GeminiLiveSettings {
  readonly apiKey: string;
  readonly voiceName: GeminiVoiceName;
  readonly model: string;
  readonly autoNarrateAgentReplies: boolean;
}

export const DEFAULT_GEMINI_LIVE_SETTINGS: GeminiLiveSettings = {
  apiKey: "",
  voiceName: "Puck",
  model: "models/gemini-2.0-flash-exp",
  autoNarrateAgentReplies: true,
};

export const GEMINI_LIVE_SETTINGS_STORAGE_KEY = "t3code:gemini-live-settings:v1";

export function loadGeminiLiveSettings(): GeminiLiveSettings {
  if (typeof window === "undefined") {
    return DEFAULT_GEMINI_LIVE_SETTINGS;
  }
  try {
    const raw = window.localStorage.getItem(GEMINI_LIVE_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_GEMINI_LIVE_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<GeminiLiveSettings>;
    const voiceName = GEMINI_VOICE_NAMES.includes(parsed.voiceName as GeminiVoiceName)
      ? (parsed.voiceName as GeminiVoiceName)
      : DEFAULT_GEMINI_LIVE_SETTINGS.voiceName;
    return {
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      voiceName,
      model:
        typeof parsed.model === "string" && parsed.model.trim().length > 0
          ? parsed.model.trim()
          : DEFAULT_GEMINI_LIVE_SETTINGS.model,
      autoNarrateAgentReplies:
        typeof parsed.autoNarrateAgentReplies === "boolean"
          ? parsed.autoNarrateAgentReplies
          : DEFAULT_GEMINI_LIVE_SETTINGS.autoNarrateAgentReplies,
    };
  } catch {
    return DEFAULT_GEMINI_LIVE_SETTINGS;
  }
}

export function saveGeminiLiveSettings(settings: GeminiLiveSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GEMINI_LIVE_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota errors.
  }
}

export interface VoiceActivityItem {
  readonly id: string;
  readonly createdAt: string;
  readonly kind: "user" | "assistant" | "tool" | "agent_update" | "system";
  readonly title: string;
  readonly detail?: string;
}

export interface GeminiLiveThreadSnapshot {
  readonly threadTitle: string;
  readonly projectName: string | null;
  readonly isWorking: boolean;
  readonly phase: string;
  readonly pendingApprovalCount: number;
  readonly pendingQuestionText: string | null;
  readonly recentMessages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
  }>;
}

export interface GeminiLiveToolHandlers {
  readonly sendPromptToThread: (prompt: string) => Promise<{ ok: boolean; message: string }>;
  readonly getThreadStatus: () => GeminiLiveThreadSnapshot;
  readonly interruptThread: () => Promise<{ ok: boolean; message: string }>;
  readonly startNewThread: () => Promise<{ ok: boolean; message: string }>;
}

/**
 * Cleans markdown from coding agent responses so the voice model can summarize
 * and speak it naturally without reading out raw code blocks or long file URIs.
 */
export function summarizeMarkdownForVoice(markdown: string, maxLength = 1600): string {
  if (!markdown) return "";
  const withoutCodeBlocks = markdown.replace(/```[\s\S]*?```/g, " [code block] ");
  const withoutFileLinks = withoutCodeBlocks.replace(
    /\[([^\]]+)\]\((?:file:\/\/\/[^)]+|https?:\/\/[^)]+)\)/g,
    "$1",
  );
  const withoutInlineCode = withoutFileLinks.replace(/`([^`]+)`/g, "$1");
  const collapsed = withoutInlineCode.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength)}...`;
}
