import type { ProviderEvent, ProviderSession } from "@t3tools/contracts";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
export type RuntimeMode = "approval-required" | "full-access";
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;

export interface ChatImageAttachment {
  type: "image";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
}

export type ChatAttachment = ChatImageAttachment;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments?: ChatAttachment[];
  createdAt: string;
  streaming: boolean;
}

export interface Project {
  id: string;
  name: string;
  cwd: string;
  model: string;
  expanded: boolean;
}

export interface Thread {
  id: string;
  codexThreadId: string | null;
  projectId: string;
  title: string;
  model: string;
  terminalOpen: boolean;
  terminalHeight: number;
  session: ProviderSession | null;
  messages: ChatMessage[];
  events: ProviderEvent[];
  error: string | null;
  createdAt: string;
  latestTurnId?: string | undefined;
  latestTurnStartedAt?: string | undefined;
  latestTurnCompletedAt?: string | undefined;
  latestTurnDurationMs?: number | undefined;
  branch: string | null;
  worktreePath: string | null;
}
