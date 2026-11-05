import {
  WS_METHODS,
  type ConversationSummaryPass,
  type ConversationSummarySourceRef,
  type ConversationSummarySourceResult,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
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
      list({ ...target, input: { ...target.input, sourceFormat: 2 } }),
    expand: (target: Parameters<typeof expand>[0]) =>
      expand({ ...target, input: { ...target.input, sourceFormat: 2 } }),
  };
}

export function conversationSummaryPassLabel(pass: ConversationSummaryPass): string {
  const waiting =
    pass.waitingMessages === 0
      ? ""
      : ` ${pass.waitingMessages} older ${pass.waitingMessages === 1 ? "source waits" : "sources wait"} for a summary.`;
  switch (pass.result) {
    case "ran":
      return `Last pass wrote ${pass.generated} ${pass.generated === 1 ? "summary" : "summaries"}.${waiting}`;
    case "skipped":
      return `Last pass wrote nothing. ${pass.reason ?? ""}${waiting}`.trim();
    case "failed":
      return `Last pass failed. ${pass.reason ?? ""}${waiting}`.trim();
  }
}

export interface ConversationSummarySourceCursor {
  readonly offset: number;
  readonly textOffset: number;
}

export function conversationSummarySourceRangeLabel(
  ref: ConversationSummarySourceRef,
  result: ConversationSummarySourceResult,
): string | null {
  if (result.state !== "available" || result.text.length === 0) return null;
  const textOffset = result.textOffset ?? 0;
  const totalChars = result.totalChars ?? result.text.length;
  if (ref.range === undefined && textOffset === 0 && totalChars === result.text.length) return null;
  const start = (ref.range?.start ?? 0) + textOffset;
  const end = start + result.text.length;
  const total = ref.range?.total ?? totalChars;
  return `Characters ${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`;
}
