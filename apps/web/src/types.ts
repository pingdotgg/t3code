import type { ProviderEvent, ProviderSession } from "@t3tools/contracts";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
export type RuntimeMode = "approval-required" | "full-access";
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
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
