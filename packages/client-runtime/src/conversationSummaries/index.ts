import {
  WS_METHODS,
  type ConversationSummaryPass,
  type ConversationSummarySourceRef,
  type ConversationSummarySourceResult,
  type OrchestrationV2MessageProvenance,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "../state/runtime.ts";

export function createConversationSummariesAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "conversation-summaries:list",
    tag: WS_METHODS.conversationSummariesList,
    staleTimeMs: 0,
  });
  const expand = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "conversation-summaries:expand",
    tag: WS_METHODS.conversationSummariesExpand,
    staleTimeMs: 0,
  });
  return {
    list: (target: Parameters<typeof list>[0]) =>
      list({ ...target, input: { ...target.input, sourceFormat: 3 } }),
    expand: (target: Parameters<typeof expand>[0]) =>
      expand({ ...target, input: { ...target.input, sourceFormat: 3 } }),
  };
}

export function conversationSummaryPassLabel(
  pass: ConversationSummaryPass,
  resolve: MFunctionType = mFallback,
): string {
  const waiting =
    pass.waitingMessages === 0
      ? ""
      : ` ${resolve(
          msg(
            "{count, plural, one {# older source waits for a summary.} other {# older sources wait for a summary.}}",
          ),
          { count: pass.waitingMessages },
        )}`;
  switch (pass.result) {
    case "ran":
      return `${resolve(msg("Last pass wrote {count, plural, one {# summary} other {# summaries}}."), { count: pass.generated })}${pass.reason ? ` ${pass.reason}` : ""}${waiting}`;
    case "skipped":
      return `${resolve(msg("Last pass wrote nothing."))} ${pass.reason ?? ""}${waiting}`.trim();
    case "failed":
      return `${resolve(msg("Last pass failed."))} ${pass.reason ?? ""}${waiting}`.trim();
  }
}

export interface ConversationSummarySourceCursor {
  readonly offset: number;
  readonly textOffset: number;
}

/** Who wrote a message: the user, the thread's agent, or the peer seat that spoke it. */
export function messageAuthorLabel(
  role: "user" | "assistant",
  speaker?: { readonly label: string; readonly model: string },
  provenance?: OrchestrationV2MessageProvenance,
  resolve: MFunctionType = mFallback,
): string {
  if (provenance?.linkedSender !== undefined) {
    const sender = provenance.linkedSender;
    return resolve(msg("Agent: {title} ({environment})"), {
      title: sender.title || sender.threadId,
      environment: sender.environmentId,
    });
  }
  if (provenance?.senderThreadId !== undefined)
    return resolve(msg("Agent ({thread})"), { thread: provenance.senderThreadId });
  if (provenance !== undefined)
    return resolve(provenance.createdBy === "system" ? msg("System") : msg("Agent"));
  if (role === "user") return resolve(msg("User"));
  if (speaker === undefined) return resolve(msg("Assistant"));
  // A seat without a label is named by its model.
  return speaker.label === speaker.model ? speaker.label : `${speaker.label} (${speaker.model})`;
}

/** Who a source came from; a child summary is named by its id so it can be opened. */
export function conversationSummarySourceLabel(
  ref: ConversationSummarySourceRef,
  result: ConversationSummarySourceResult,
  resolve: MFunctionType = mFallback,
): string {
  if (result.state !== "available") return resolve(msg("Unavailable"));
  switch (result.role) {
    case "user":
    case "assistant":
      return messageAuthorLabel(result.role, result.speaker, result.provenance, resolve);
    case "tool":
      return resolve(msg("Tool"));
    case "summary":
      return ref.kind === "summary"
        ? resolve(msg("Summary {id}"), { id: ref.summaryId })
        : resolve(msg("Summary"));
  }
}

export function conversationSummarySourceRangeLabel(
  ref: ConversationSummarySourceRef,
  result: ConversationSummarySourceResult,
  resolve: MFunctionType = mFallback,
): string | null {
  if (result.state !== "available" || result.text.length === 0) return null;
  const textOffset = result.textOffset ?? 0;
  const totalChars = result.totalChars ?? result.text.length;
  const range = ref.kind === "summary" ? undefined : ref.range;
  if (range === undefined && textOffset === 0 && totalChars === result.text.length) return null;
  const start = (range?.start ?? 0) + textOffset;
  const end = start + result.text.length;
  const total = range?.total ?? totalChars;
  return resolve(msg("Characters {start, number}–{end, number} of {total, number}"), {
    start: start + 1,
    end,
    total,
  });
}
