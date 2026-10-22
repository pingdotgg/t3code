// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or synchronous createHash.
import * as NodeCrypto from "node:crypto";

import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { resolveThreadAwarenessPhaseV2 } from "@t3tools/shared/agentAwareness";
import * as DateTime from "effect/DateTime";

export type ThreadWatchEventKind = "completed" | "failed" | "question" | "approval" | "ended";

export interface ThreadWatchState {
  readonly attention: string | null;
  readonly completion: string | null;
  readonly ended: boolean;
}

export const UNSEEN: ThreadWatchState = { attention: null, completion: null, ended: false };

/**
 * Uses the phases mobile alerts use. A run that ends as its thread settles is
 * reported before `ended`.
 */
export function observeThreadWatch(
  shell: OrchestrationV2ThreadShell | null,
  prior: ThreadWatchState,
): { readonly state: ThreadWatchState; readonly kinds: ReadonlyArray<ThreadWatchEventKind> } {
  if (prior.ended) return { state: prior, kinds: [] };
  const ended =
    shell === null ||
    shell.deletedAt !== null ||
    shell.archivedAt !== null ||
    shell.settledOverride === "settled";
  const phase = shell === null ? null : resolveThreadAwarenessPhaseV2(shell);
  const attentionKind =
    phase === "waiting_for_approval"
      ? "approval"
      : phase === "waiting_for_input"
        ? "question"
        : phase === "failed"
          ? "failed"
          : null;
  // Keyed by request too, so a second question in one run gets its own event id.
  const attention =
    attentionKind === null
      ? null
      : `${shell?.latestRunId ?? ""}:${attentionKind}:${shell?.pendingRuntimeRequest?.id ?? ""}`;
  const completion =
    phase === "completed" && shell !== null
      ? DateTime.formatIso(shell.latestRunCompletedAt ?? shell.updatedAt)
      : prior.completion;
  const kinds: Array<ThreadWatchEventKind> = [];
  if (attentionKind !== null && attention !== prior.attention) kinds.push(attentionKind);
  else if (completion !== null && completion !== prior.completion) kinds.push("completed");
  if (ended) kinds.push("ended");
  return { state: { attention, completion, ended }, kinds };
}

const digest = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 32);

export const threadWatchId = (threadId: ThreadId, url: string) =>
  `tw_${digest(`${threadId}\0${url}`)}`;

export const threadWatchEventId = (
  watchId: string,
  kind: ThreadWatchEventKind,
  state: ThreadWatchState,
  occurredAt: DateTime.Utc,
) =>
  `evt_${digest(
    // A watch made again on the same URL can end with nothing else changed.
    `${watchId}\0${kind}\0${kind === "ended" ? DateTime.formatIso(occurredAt) : (state.attention ?? state.completion ?? "")}`,
  )}`;

export function threadWatchEventBody(input: {
  readonly eventId: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly shell: OrchestrationV2ThreadShell | null;
  readonly kind: ThreadWatchEventKind;
  readonly occurredAt: DateTime.Utc;
}): string {
  return JSON.stringify({
    eventId: input.eventId,
    name: "thread.watch",
    timestamp: DateTime.formatIso(input.occurredAt),
    data: {
      environmentId: input.environmentId,
      threadId: input.threadId,
      title: input.shell?.title ?? "",
      kind: input.kind,
      runId: input.shell?.latestRunId ?? null,
    },
    cursor: null,
  });
}

/** Standard Webhooks, which MCP Events uses for webhook delivery. */
export function standardWebhookKey(secret: string): Uint8Array | null {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null;
  const key = Buffer.from(encoded, "base64");
  return key.length >= 24 && key.length <= 64 ? key : null;
}

export const standardWebhookSignature = (input: {
  readonly key: Uint8Array;
  readonly id: string;
  readonly timestamp: number;
  readonly body: string;
}) =>
  `v1,${NodeCrypto.createHmac("sha256", input.key)
    .update(`${input.id}.${input.timestamp}.${input.body}`)
    .digest("base64")}`;
