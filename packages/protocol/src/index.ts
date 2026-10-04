/** Only our mobile/Termux interface lives here; no T3 runtime dependencies. */
export type SessionStatus = "idle" | "running" | "interrupted" | "error";
export type RpcId = string | number;
export interface Message { id: string; role: "user" | "assistant"; text: string }
export interface ToolItem { id: string; kind: string; title: string; output: string; status: string }
export interface Approval { id: RpcId; method: string; detail: string; choices: string[] }
export interface UserQuestion { id: string; header: string; question: string; options?: { label: string; description?: string }[] }
export interface UserInputRequest { id: RpcId; questions: UserQuestion[] }
export interface Session {
  id: string; threadId: string; title: string; cwd: string; status: SessionStatus; turnId: string | null;
  messages: Message[]; tools: ToolItem[]; approvals: Approval[]; questions: UserInputRequest[];
  diff: string; error: string | null; fullAccess: boolean;
}
export interface RuntimeStatus { codexAvailable: boolean; codexAuthenticated: boolean; version: string | null; error: string | null }
export type ClientRequest =
  | { id: string; method: "status" | "sessions/list" }
  | { id: string; method: "session/create"; params: { cwd: string; fullAccess: boolean } }
  | { id: string; method: "turn/start"; params: { sessionId: string; text: string } }
  | { id: string; method: "turn/interrupt"; params: { sessionId: string } }
  | { id: string; method: "approval/respond"; params: { sessionId: string; requestId: RpcId; decision: string } }
  | { id: string; method: "question/respond"; params: { sessionId: string; requestId: RpcId; answers: Record<string, string[]> } };
export type ServerMessage =
  | { id: string; result: unknown }
  | { id: string; error: string }
  | { event: "snapshot"; sessions: Session[] }
  | { event: "session"; session: Session }
  | { event: "runtime/error"; message: string };
