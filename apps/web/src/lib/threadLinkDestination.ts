import { resolveLinkedThreadOpen } from "@t3tools/client-runtime/linked-thread";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { threadLinkCandidates, type ThreadLink } from "@t3tools/shared/threadLinks";

/** What this client knows about where a thread link can open. */
export interface ThreadLinkLookup {
  /** This client's saved connection to an environment, if it has one. */
  readonly own: (environmentId: EnvironmentId) => { readonly connected: boolean } | undefined;
  /** What `viaEnvironmentId` calls `environmentId` when it links to it. */
  readonly linkedLabel: (
    viaEnvironmentId: EnvironmentId,
    environmentId: EnvironmentId,
  ) => Promise<string | undefined>;
  /** Which of `threadIds` exist in `environmentId`. */
  readonly existing: (
    environmentId: EnvironmentId,
    threadIds: ReadonlyArray<ThreadId>,
  ) => Promise<ReadonlySet<ThreadId>>;
}

export type ThreadLinkDestination =
  | { readonly kind: "direct"; readonly ref: ScopedThreadRef }
  | { readonly kind: "linked"; readonly ref: ScopedThreadRef; readonly label: string };

/** Where a thread link shown in `viaEnvironmentId` opens, the same as a thread link in chat. */
export async function resolveThreadLinkDestination(
  link: ThreadLink,
  viaEnvironmentId: EnvironmentId,
  lookup: ThreadLinkLookup,
): Promise<ThreadLinkDestination> {
  const candidates = threadLinkCandidates(link, viaEnvironmentId);
  const written = candidates[0]!;
  const own = lookup.own(written.environmentId);
  const label =
    written.environmentId === viaEnvironmentId || own?.connected === true
      ? undefined
      : await lookup.linkedLabel(viaEnvironmentId, written.environmentId);
  const open = resolveLinkedThreadOpen({
    environmentId: written.environmentId,
    viaEnvironmentId,
    own,
    linked: label !== undefined,
  });
  if (open === "linked" && label !== undefined) return { kind: "linked", ref: written, label };
  if (candidates.length === 1) return { kind: "direct", ref: written };
  // A thread id can hold percent escapes of its own; the spelling as written wins when both exist.
  const existing = await lookup.existing(
    written.environmentId,
    candidates.map((ref) => ref.threadId),
  );
  return { kind: "direct", ref: candidates.find((ref) => existing.has(ref.threadId)) ?? written };
}
