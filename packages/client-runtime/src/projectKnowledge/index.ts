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
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
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
  resolve: MFunctionType = mFallback,
): ReadonlyArray<string> {
  const notes: string[] = [];
  if (snapshot.recallFailed)
    notes.push(resolve(msg("Optional knowledge recall failed; historical evidence was omitted.")));
  if (snapshot.status === "prepared" || snapshot.status === "uncertain")
    notes.push(resolve(msg("Delivery to the provider was not confirmed.")));
  if (snapshot.status === "failed")
    notes.push(resolve(msg("This turn was not sent to the provider.")));
  if (snapshot.attempts > 1)
    notes.push(
      resolve(
        msg(
          "Prepared for {attempts, plural, one {{attempts} provider attempt} other {{attempts} provider attempts}}.",
        ),
        { attempts: snapshot.attempts },
      ),
    );
  if (snapshot.item === null) return notes;
  if (snapshot.item.current === "changed")
    notes.push(resolve(msg("This knowledge has changed since it was sent.")));
  if (snapshot.item.contentRemoved)
    notes.push(
      resolve(
        msg("This knowledge has since been forgotten. Its content was removed from this record."),
      ),
    );
  else if (snapshot.item.current === "forgotten")
    notes.push(resolve(msg("This knowledge has since been forgotten.")));
  if (snapshot.item.current === "unavailable")
    notes.push(resolve(msg("A source for this knowledge is no longer available.")));
  return notes;
}

export const KNOWLEDGE_DELIVERY_OMISSION_LABEL: Record<
  DeliveryRecord["omissions"][number]["reason"],
  string
> = {
  not_referenced: msg("not referenced in the message"),
  over_budget: msg("exceeds the context allowance"),
  source_unavailable: msg("source unavailable"),
  stale_revision: msg("selected revision could not be verified"),
  not_permitted: msg("source not permitted for this project"),
  recall_failed: msg("optional knowledge recall failed"),
};

export const KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL: Record<KnowledgeSourceUnavailableReason, string> =
  {
    missing: msg("Source missing"),
    deleted: msg("Source deleted"),
    archived: msg("Source archived"),
    wrong_project: msg("Source moved"),
    streaming: msg("Source still streaming"),
    changed: msg("Source changed"),
  };

export const KNOWLEDGE_FACT_KIND_LABEL: Record<ProjectFact["kind"], string> = {
  decision: msg("decision", { $context: "project fact kind" }),
  constraint: msg("constraint", { $context: "project fact kind" }),
  convention: msg("convention", { $context: "project fact kind" }),
  note: msg("note", { $context: "project fact kind" }),
};

export const KNOWLEDGE_FACT_STATUS_LABEL: Record<ProjectFact["status"], string> = {
  saved: msg("saved", { $context: "project fact status" }),
  forgotten: msg("forgotten", { $context: "project fact status" }),
};

export function knowledgeOriginLabel(
  origin: KnowledgeOrigin,
  resolve: MFunctionType = mFallback,
): string {
  switch (origin.kind) {
    case "user":
      return resolve(msg("User assertion"));
    case "agent-thread":
      return resolve(msg("Agent observation in thread {threadId}"), { threadId: origin.threadId });
    case "agent-client":
      return resolve(msg("Agent observation from {label}"), { label: origin.label });
    case "assisted":
      return origin.runOutcome === "completed"
        ? resolve(msg("Learned from a finished run"))
        : origin.runOutcome === "failed"
          ? resolve(msg("Learned from a run that failed"))
          : resolve(msg("Learned from a run that was interrupted"));
    case "curator":
      return resolve(msg("Memory curator"));
    case "unknown":
      return resolve(msg("Origin not recognized by this version"));
  }
}

export function assistedLearningRunLabel(
  run: AssistedLearningRun,
  resolve: MFunctionType = mFallback,
): string {
  switch (run.result) {
    case "ran":
      return run.saved === 0
        ? resolve(msg("Last run: nothing saved.{reason}"), {
            reason: run.reason ? ` ${run.reason}` : "",
          })
        : resolve(msg("Last run: saved {saved}.{reason}"), {
            saved: run.saved,
            reason: run.reason ? ` ${run.reason}` : "",
          });
    case "skipped":
      return resolve(msg("Last run skipped. {reason}"), { reason: run.reason ?? "" }).trim();
    case "failed":
      return resolve(msg("Last run failed. {reason}"), { reason: run.reason ?? "" }).trim();
  }
}

/** The fact's recall eligibility as one line; the caller appends the formatted date. */
export function projectFactVerdictLabel(
  verdict: ProjectFactVerdictRecord,
  resolve: MFunctionType = mFallback,
): string {
  switch (verdict.value) {
    case "standing":
      return resolve(
        msg(
          "Standing, recalled into related work · {by, select, check {checked} person {marked by you} other {marked by an agent}}",
        ),
        { by: verdict.by },
      );
    case "task":
      return resolve(
        msg(
          "Set aside as a task note, never recalled automatically · {by, select, check {checked} person {marked by you} other {marked by an agent}}",
        ),
        { by: verdict.by },
      );
    case "code":
      return resolve(
        msg(
          "Set aside as a code description, never recalled automatically · {by, select, check {checked} person {marked by you} other {marked by an agent}}",
        ),
        { by: verdict.by },
      );
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
  resolve: MFunctionType = mFallback,
): string {
  const explanation =
    run.reason === "disabled"
      ? resolve(msg("Memory curation is turned off for this project."))
      : run.reason === "provider_unsupported"
        ? resolve(msg("The selected model does not support memory curation."))
        : run.reason === "project_unavailable"
          ? resolve(msg("The project is archived or unavailable."))
          : run.reason === "nothing_to_review"
            ? resolve(msg("No eligible memories to review."))
            : run.reason === "invalid_output"
              ? resolve(msg("The model returned an unusable review."))
              : run.reason === "interrupted"
                ? resolve(msg("The review was interrupted."))
                : "";
  switch (run.status) {
    case "running":
      return resolve(msg("Reviewing project memory…"));
    case "ran":
      return resolve(msg("Last review: {reviewed} reviewed, {changed} changed."), {
        reviewed: run.reviewed,
        changed: run.changed,
      });
    case "skipped":
      return resolve(msg("Last review skipped. {explanation}"), { explanation }).trim();
    case "failed":
      return resolve(msg("Last review could not finish. {explanation}"), { explanation }).trim();
  }
}

export function projectFactHistoryLabel(
  entry: ProjectFactHistoryEntry,
  resolve: MFunctionType = mFallback,
): string {
  if (entry.memoryAction === "curated") return resolve(msg("Removed automatically"));
  if (entry.memoryAction === "restored") return resolve(msg("Restored to recall"));
  switch (entry.event) {
    case "baseline":
      return resolve(msg("History begins at revision {revision}"), { revision: entry.revision });
    case "created":
      return entry.relatedFactId === null
        ? resolve(msg("Created", { $context: "project fact history" }))
        : resolve(msg("Created as a replacement"));
    case "edited":
      return resolve(msg("Edited to revision {revision}"), { revision: entry.revision });
    case "confirmed":
      return resolve(msg("Confirmed", { $context: "project fact history" }));
    case "forgotten":
      return entry.actor.kind === "curator"
        ? resolve(msg("Removed automatically"))
        : resolve(msg("Forgotten", { $context: "project fact history" }));
    case "feedback":
      return entry.helpful === false
        ? resolve(msg("Marked unhelpful"))
        : resolve(msg("Marked helpful"));
    case "superseded":
      return resolve(msg("Superseded", { $context: "project fact history" }));
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

export function knowledgeConflictHintLabel(
  hint: KnowledgeConflictHint,
  resolve: MFunctionType = mFallback,
): string {
  switch (hint.kind) {
    case "duplicate":
      return resolve(msg("Same as an existing fact"));
    case "near_duplicate":
      return resolve(msg("Possible duplicate of"));
    case "possible_conflict":
      return resolve(msg("Possible conflict with"));
  }
}
