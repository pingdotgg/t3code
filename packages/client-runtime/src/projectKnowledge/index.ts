import {
  WS_METHODS,
  type AssistedLearningRun,
  type KnowledgeConflictHint,
  type KnowledgeOrigin,
  type KnowledgeSourceUnavailableReason,
  type ProjectFact,
  type ProjectFactHistoryEntry,
  type ProjectFactVerdictRecord,
  type ProjectKnowledgeDeliveries,
  type ProjectKnowledgeStatus,
} from "@t3tools/contracts";
export { projectKnowledgeContextRecord } from "@t3tools/shared/composerContextReferences";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "../state/runtime.ts";

export function createProjectKnowledgeAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-knowledge:list",
      tag: WS_METHODS.projectKnowledgeList,
      staleTimeMs: 0,
    }),
    search: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-knowledge:search",
      tag: WS_METHODS.projectKnowledgeSearch,
      staleTimeMs: 0,
    }),
    readSource: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-knowledge:source",
      tag: WS_METHODS.projectKnowledgeReadSource,
      staleTimeMs: 0,
    }),
    readDeliveries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-knowledge:deliveries",
      tag: WS_METHODS.projectKnowledgeReadDeliveries,
      staleTimeMs: 0,
    }),
    readFact: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-knowledge:fact",
      tag: WS_METHODS.projectKnowledgeReadFact,
      staleTimeMs: 0,
    }),
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-knowledge:status",
      tag: WS_METHODS.projectKnowledgeStatus,
      staleTimeMs: 0,
    }),
    prepareContext: createEnvironmentRpcCommand(runtime, {
      label: "project-knowledge:prepare",
      tag: WS_METHODS.projectKnowledgePrepareContext,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "project-knowledge:mutate",
      tag: WS_METHODS.projectKnowledgeMutate,
    }),
  };
}

type DeliveryRecord = ProjectKnowledgeDeliveries["deliveries"][number];

/**
 * What one sent message's knowledge reference delivered or why it was omitted. Prefers the latest
 * attempt the provider accepted; otherwise the latest attempt, whose status explains why it is
 * not confirmed.
 */
export function deliveredKnowledgeSnapshot(result: ProjectKnowledgeDeliveries, contextId: string) {
  const matches = result.deliveries
    .map((delivery) => {
      const item = delivery.items.find((candidate) => candidate.contextId === contextId);
      if (item)
        return {
          status: delivery.status,
          item,
          omission: null,
          ...(delivery.omissions.some((entry) => entry.reason === "recall_failed")
            ? { recallFailed: true }
            : {}),
        };
      const omission = delivery.omissions.find((candidate) => candidate.contextId === contextId);
      return omission
        ? {
            status: delivery.status,
            item: null,
            omission,
            ...(delivery.omissions.some((entry) => entry.reason === "recall_failed")
              ? { recallFailed: true }
              : {}),
          }
        : null;
    })
    .filter((match) => match !== null);
  const chosen = matches.findLast((match) => match.status === "sent") ?? matches.at(-1);
  return chosen ? { ...chosen, attempts: matches.length } : null;
}

export function deliveredKnowledgeNotes(
  snapshot: NonNullable<ReturnType<typeof deliveredKnowledgeSnapshot>>,
): ReadonlyArray<string> {
  const notes: string[] = [];
  if (snapshot.recallFailed)
    notes.push("Optional knowledge recall failed; historical evidence was omitted.");
  if (snapshot.status === "prepared" || snapshot.status === "uncertain")
    notes.push("Delivery to the provider was not confirmed.");
  if (snapshot.status === "failed") notes.push("This turn was not sent to the provider.");
  if (snapshot.attempts > 1) notes.push(`Prepared for ${snapshot.attempts} provider attempts.`);
  if (snapshot.item === null) return notes;
  if (snapshot.item.current === "changed")
    notes.push("This knowledge has changed since it was sent.");
  if (snapshot.item.contentRemoved)
    notes.push(
      "This knowledge has since been forgotten. Its content was removed from this record.",
    );
  else if (snapshot.item.current === "forgotten")
    notes.push("This knowledge has since been forgotten.");
  if (snapshot.item.current === "unavailable")
    notes.push("A source for this knowledge is no longer available.");
  return notes;
}

export const KNOWLEDGE_DELIVERY_OMISSION_LABEL: Record<
  DeliveryRecord["omissions"][number]["reason"],
  string
> = {
  not_referenced: "not referenced in the message",
  over_budget: "exceeds the context allowance",
  source_unavailable: "source unavailable",
  stale_revision: "selected revision could not be verified",
  not_permitted: "source not permitted for this project",
  recall_failed: "optional knowledge recall failed",
};

export const KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL: Record<KnowledgeSourceUnavailableReason, string> =
  {
    missing: "Source missing",
    deleted: "Source deleted",
    archived: "Source archived",
    wrong_project: "Source moved",
    streaming: "Source still streaming",
    changed: "Source changed",
  };

export function knowledgeOriginLabel(origin: KnowledgeOrigin): string {
  switch (origin.kind) {
    case "user":
      return "User assertion";
    case "agent-thread":
      return `Agent observation in thread ${origin.threadId}`;
    case "agent-client":
      return `Agent observation from ${origin.label}`;
    case "assisted":
      return origin.runOutcome === "completed"
        ? "Learned from a finished run"
        : `Learned from a run that ${origin.runOutcome === "failed" ? "failed" : "was interrupted"}`;
    case "curator":
      return "Memory curator";
    case "unknown":
      return "Origin not recognized by this version";
  }
}

export function assistedLearningRunLabel(run: AssistedLearningRun): string {
  switch (run.result) {
    case "ran":
      return run.saved === 0
        ? `Last run: nothing saved.${run.reason ? ` ${run.reason}` : ""}`
        : `Last run: saved ${run.saved}.${run.reason ? ` ${run.reason}` : ""}`;
    case "skipped":
      return `Last run skipped. ${run.reason ?? ""}`.trim();
    case "failed":
      return `Last run failed. ${run.reason ?? ""}`.trim();
  }
}

/** The fact's recall eligibility as one line; the caller appends the formatted date. */
export function projectFactVerdictLabel(verdict: ProjectFactVerdictRecord): string {
  const decided =
    verdict.by === "check"
      ? "checked"
      : verdict.by === "person"
        ? "marked by you"
        : "marked by an agent";
  switch (verdict.value) {
    case "standing":
      return `Standing, recalled into related work · ${decided}`;
    case "task":
      return `Set aside as a task note, never recalled automatically · ${decided}`;
    case "code":
      return `Set aside as a code description, never recalled automatically · ${decided}`;
  }
}

export function isSupersededFact(fact: ProjectFact): boolean {
  return fact.supersededBy != null;
}

export function canRestoreFactToRecall(fact: ProjectFact): boolean {
  return (
    fact.status === "saved" &&
    (isSupersededFact(fact) || fact.verdict?.value === "task" || fact.verdict?.value === "code")
  );
}

export function memoryCurationRunLabel(
  run: NonNullable<ProjectKnowledgeStatus["curation"]>,
): string {
  const explanation =
    run.reason === "disabled"
      ? "Memory curation is turned off for this project."
      : run.reason === "provider_unsupported"
        ? "The selected model does not support memory curation."
        : run.reason === "project_unavailable"
          ? "The project is archived or unavailable."
          : run.reason === "nothing_to_review"
            ? "No eligible memories to review."
            : run.reason === "invalid_output"
              ? "The model returned an unusable review."
              : run.reason === "interrupted"
                ? "The review was interrupted."
                : "";
  switch (run.status) {
    case "running":
      return "Reviewing project memory…";
    case "ran":
      return `Last review: ${run.reviewed} reviewed, ${run.changed} changed.`;
    case "skipped":
      return `Last review skipped. ${explanation}`.trim();
    case "failed":
      return `Last review could not finish. ${explanation}`.trim();
  }
}

export function projectFactHistoryLabel(entry: ProjectFactHistoryEntry): string {
  if (entry.memoryAction === "curated")
    return entry.relatedFactId === null
      ? "Set aside by the memory curator"
      : "Superseded by the memory curator";
  if (entry.memoryAction === "restored") return "Restored to recall";
  switch (entry.event) {
    case "baseline":
      return `History begins at revision ${entry.revision}`;
    case "created":
      return entry.relatedFactId === null ? "Created" : "Created as a replacement";
    case "edited":
      return `Edited to revision ${entry.revision}`;
    case "confirmed":
      return "Confirmed";
    case "forgotten":
      return "Forgotten";
    case "feedback":
      return entry.helpful === false ? "Marked unhelpful" : "Marked helpful";
    case "superseded":
      return "Superseded";
  }
}

/** Trust after each event, oldest first; a sparkline only says something with two points. */
export function projectFactTrustPoints(
  history: ReadonlyArray<ProjectFactHistoryEntry>,
): ReadonlyArray<number> {
  const first = history[0];
  if (!first) return [];
  return [
    ...(first.trustBefore === null ? [] : [first.trustBefore]),
    ...history.map((entry) => entry.trustAfter),
  ];
}

export function knowledgeConflictHintLabel(hint: KnowledgeConflictHint): string {
  switch (hint.kind) {
    case "duplicate":
      return "Same as an existing fact";
    case "near_duplicate":
      return "Possible duplicate of";
    case "possible_conflict":
      return "Possible conflict with";
  }
}
