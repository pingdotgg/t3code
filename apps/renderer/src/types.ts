import type { ProviderEvent, ProviderSession } from "@acme/contracts";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";

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
  projectId: string;
  title: string;
  session: ProviderSession | null;
  messages: ChatMessage[];
  events: ProviderEvent[];
  error: string | null;
  createdAt: string;
}
