import type {
  CbmProjectIndexStatus,
  OptimizerId,
  OptimizerStatusSnapshot,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export const CBM_MCP_SERVER_NAME = "codebase-memory";

export interface SessionRtkAttachment {
  readonly command: "rtk";
}

export interface SessionCbmAttachment {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export interface SessionHeadroomAttachment {
  readonly environment: Readonly<Record<string, string>>;
  /** Claude flag settings outrank a base URL in the user's settings file; the process env does not. */
  readonly claudeBaseUrl?: string;
  /** Codex routes per thread through these config overrides. */
  readonly codexConfig?: Readonly<Record<string, string>>;
}

export interface SessionOptimizerAttachmentDescriptor {
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly configured: ReadonlyArray<OptimizerId>;
  readonly attached: ReadonlyArray<OptimizerId>;
  readonly ready: ReadonlyArray<OptimizerId>;
  readonly rtk?: SessionRtkAttachment;
  readonly headroom?: SessionHeadroomAttachment;
  readonly cbm?: SessionCbmAttachment;
  readonly cbmIndexCompletion?: Effect.Effect<CbmProjectIndexStatus>;
}

export interface SessionOptimizerCapabilities {
  readonly rtk: boolean;
  readonly headroom: boolean;
  readonly cbm: boolean;
}

export class SessionOptimizerAttachments extends Context.Service<
  SessionOptimizerAttachments,
  {
    readonly resolve: (input: {
      readonly threadId: ThreadId;
      readonly cwd: string | null;
      readonly capabilities: SessionOptimizerCapabilities;
      readonly resolveHeadroom?: (
        proxyUrl: string,
        cpaUrl: string,
      ) => Effect.Effect<SessionHeadroomAttachment | undefined>;
    }) => Effect.Effect<SessionOptimizerAttachmentDescriptor | undefined, never, Scope.Scope>;
    readonly getStatus: (input: {
      readonly refresh?: boolean;
    }) => Effect.Effect<OptimizerStatusSnapshot>;
  }
>()("@t3tools/provider-core/server/sessionOptimizerAttachments") {}

const attachmentsByThread = new Map<ThreadId, SessionOptimizerAttachmentDescriptor>();

export function setSessionOptimizerAttachments(
  threadId: ThreadId,
  descriptor: SessionOptimizerAttachmentDescriptor,
): void {
  attachmentsByThread.set(threadId, descriptor);
}

export function readSessionOptimizerAttachments(
  threadId: ThreadId,
): SessionOptimizerAttachmentDescriptor | undefined {
  return attachmentsByThread.get(threadId);
}

export function clearSessionOptimizerAttachments(threadId: ThreadId): void {
  attachmentsByThread.delete(threadId);
}

export function clearAllSessionOptimizerAttachments(): void {
  attachmentsByThread.clear();
}

export function isCurrentSessionOptimizerAttachments(
  threadId: ThreadId,
  descriptor: SessionOptimizerAttachmentDescriptor,
): boolean {
  return attachmentsByThread.get(threadId) === descriptor;
}

export function removeSessionOptimizerAttachment(threadId: ThreadId, optimizer: OptimizerId): void {
  const current = attachmentsByThread.get(threadId);
  if (current === undefined) return;
  const attached = current.attached.filter((id) => id !== optimizer);
  const ready = current.ready.filter((id) => id !== optimizer);
  if (optimizer === "rtk") {
    const { rtk: removed, ...remaining } = current;
    void removed;
    attachmentsByThread.set(threadId, { ...remaining, attached, ready });
    return;
  }
  if (optimizer === "cbm") {
    const { cbm: removed, cbmIndexCompletion: removedIndex, ...remaining } = current;
    void removed;
    void removedIndex;
    attachmentsByThread.set(threadId, { ...remaining, attached, ready });
    return;
  }
  if (optimizer === "headroom") {
    const { headroom: removed, ...remaining } = current;
    void removed;
    attachmentsByThread.set(threadId, { ...remaining, attached, ready });
    return;
  }
  attachmentsByThread.set(threadId, { ...current, attached, ready });
}

/** Snapshot of current per-thread optimizer attachments for server status reporting. */
export const sessionOptimizerAttachmentEntries = () => [...attachmentsByThread.entries()];
