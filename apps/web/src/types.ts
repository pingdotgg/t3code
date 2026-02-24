import type {
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
  ProjectScript as ContractProjectScript,
} from "@t3tools/contracts";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
export type RuntimeMode = "approval-required" | "full-access";
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
export const DEFAULT_THREAD_TERMINAL_ID = "default";
export const MAX_THREAD_TERMINAL_COUNT = 4;
export type ProjectScript = ContractProjectScript;

export interface ThreadTerminalGroup {
  id: string;
  terminalIds: string[];
}

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
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ChatAttachment[];
  createdAt: string;
  completedAt?: string | undefined;
  streaming: boolean;
}

export interface TurnDiffFileChange {
  path: string;
  kind?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface TurnDiffSummary {
  turnId: string;
  completedAt: string;
  status?: string | undefined;
  files: TurnDiffFileChange[];
  checkpointRef?: string | undefined;
  assistantMessageId?: string | undefined;
  checkpointTurnCount?: number | undefined;
}

export interface Project {
  id: string;
  name: string;
  cwd: string;
  model: string;
  expanded: boolean;
  scripts: ProjectScript[];
}

export interface Thread {
  id: string;
  codexThreadId: string | null;
  projectId: string;
  title: string;
  model: string;
  terminalOpen: boolean;
  terminalHeight: number;
  terminalIds: string[];
  runningTerminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  session: ThreadSession | null;
  messages: ChatMessage[];
  error: string | null;
  createdAt: string;
  latestTurnId?: string | undefined;
  latestTurnStartedAt?: string | undefined;
  latestTurnCompletedAt?: string | undefined;
  latestTurnDurationMs?: number | undefined;
  lastVisitedAt?: string | undefined;
  branch: string | null;
  worktreePath: string | null;
  turnDiffSummaries: TurnDiffSummary[];
  activities: OrchestrationThreadActivity[];
}

export interface ThreadSession {
  sessionId: string;
  provider: "codex" | "claudeCode";
  status: SessionPhase | "error" | "closed";
  threadId: string | null;
  activeTurnId?: string | undefined;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  orchestrationStatus: OrchestrationSessionStatus;
}
