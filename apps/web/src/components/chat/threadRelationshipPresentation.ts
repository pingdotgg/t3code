import type { OrchestrationV2ThreadShell, ThreadSpecialist } from "@t3tools/contracts";

/**
 * Role chip for a relationships row. Durable specialists use their bound label;
 * turn-scoped subagents stay "Subagent" — they are not specialists.
 */
export function relationshipSeatLabel(input: {
  readonly edgeKind: "parent" | "fork" | "subagent" | "transfer" | "side_chat" | "remote";
  readonly isParent: boolean;
  readonly specialist: ThreadSpecialist | undefined;
}): string {
  if (input.edgeKind === "subagent" && !input.isParent) return "Subagent";
  if (input.edgeKind === "remote") return "Remote";
  if (input.edgeKind === "side_chat") return "Side chat";
  if (input.edgeKind === "transfer") return "Context transfer";
  if (input.specialist !== undefined) return input.specialist.label;
  if (input.edgeKind === "subagent") return "Parent agent";
  return input.isParent ? "Parent thread" : "Fork";
}

export function relationshipDisplayTitle(input: {
  readonly title: string;
  readonly specialist: ThreadSpecialist | undefined;
  /** Subagent task titles stay plain; specialist handles only apply to listed seats. */
  readonly isSubagentChild: boolean;
}): string {
  if (input.isSubagentChild || input.specialist === undefined) return input.title;
  return `@${input.specialist.key} ${input.title}`;
}

export type RelationshipDisplayStatus =
  | { readonly kind: "needs_you"; readonly label: "Needs you" }
  | { readonly kind: "status"; readonly label: string; readonly raw: string | null };

/** Prefer pending runtime asks over run status so the Agents list surfaces attention. */
export function relationshipDisplayStatus(
  thread: Pick<OrchestrationV2ThreadShell, "pendingRuntimeRequest"> | null | undefined,
  runStatus: string | null,
  statusLabel: (status: string | null) => string,
): RelationshipDisplayStatus {
  const pending = thread?.pendingRuntimeRequest ?? null;
  if (pending !== null && pending.kind !== "auth_refresh") {
    return { kind: "needs_you", label: "Needs you" };
  }
  return { kind: "status", label: statusLabel(runStatus), raw: runStatus };
}

export function agentsSectionHeading(input: {
  readonly needsYou: number;
  readonly running: number;
}): string {
  if (input.needsYou > 0) {
    return `Agents · ${input.needsYou} need${input.needsYou === 1 ? "s" : ""} you`;
  }
  if (input.running > 0) return `Agents · ${input.running} running`;
  return "Agents";
}
