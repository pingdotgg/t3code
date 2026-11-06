import { View } from "react-native";
import type {
  KnowledgeConflictHint,
  KnowledgeMessageRef,
  KnowledgeSelection,
  KnowledgeSourceUnavailableReason,
  MessageId,
  ProjectFact,
  ProjectFactHistoryEntry,
  ProjectFactId,
  ProjectFactSummary,
  ProjectKnowledgeFactDetail,
  ProjectKnowledgeSource,
  ProjectKnowledgeStatus,
  ThreadId,
} from "@t3tools/contracts";
import {
  KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL,
  isSupersededFact,
  knowledgeConflictHintLabel,
  knowledgeOriginLabel,
  projectFactHistoryLabel,
} from "@t3tools/client-runtime/projectKnowledge";

import { knowledgeSelectionState } from "../lib/projectKnowledgeComposer";
import { SelectForDraftControl } from "./ProjectKnowledgeDraftFooter";
import { AppText } from "./ui/AppText";
import { Button } from "./ui/Button";

type OpenFact = (factId: ProjectFactId) => void;
type KnowledgeSelectionState = ReturnType<typeof knowledgeSelectionState>;

const historyTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
// Revision bodies can be 12k characters; the timeline is for orientation, not reading.
const REVISION_PREVIEW_LENGTH = 280;

export function ConflictHintRow(props: {
  readonly hint: KnowledgeConflictHint;
  readonly onOpenFact: OpenFact | null;
}) {
  return (
    <View className="gap-1 rounded-xl bg-subtle p-2">
      <AppText className="text-sm">
        {knowledgeConflictHintLabel(props.hint)}: “{props.hint.excerpt}”
      </AppText>
      {props.onOpenFact ? (
        <Button
          label="Open that fact"
          tone="text"
          onPress={() => props.onOpenFact?.(props.hint.factId)}
        />
      ) : null}
    </View>
  );
}

function SummaryRow(props: {
  readonly label: string;
  readonly summary: ProjectFactSummary;
  readonly onOpenFact: OpenFact;
}) {
  return (
    <View className="gap-1">
      <AppText className="text-sm">
        {props.label}: {props.summary.excerpt ?? "Forgotten fact"} (revision{" "}
        {props.summary.revision}, {props.summary.status})
      </AppText>
      <Button
        label={`Open ${props.label.toLowerCase()}`}
        tone="text"
        onPress={() => props.onOpenFact(props.summary.id)}
      />
    </View>
  );
}

function HistoryRow(props: { readonly entry: ProjectFactHistoryEntry }) {
  const { entry } = props;
  const content =
    (entry.event === "created" || entry.event === "edited") && entry.content !== null
      ? entry.content
      : null;
  return (
    <View className="gap-1 border-l-2 border-border pl-3">
      <AppText className="font-t3-medium">{projectFactHistoryLabel(entry)}</AppText>
      <AppText className="text-xs text-foreground-muted">
        {knowledgeOriginLabel(entry.actor)} · {historyTimeFormatter.format(new Date(entry.at))}
      </AppText>
      {entry.event === "feedback" && entry.trustBefore !== null ? (
        <AppText className="text-xs">
          Trust {entry.trustBefore.toFixed(2)} → {entry.trustAfter.toFixed(2)}
        </AppText>
      ) : null}
      {content !== null ? (
        <AppText className="text-sm" numberOfLines={4}>
          {content.length > REVISION_PREVIEW_LENGTH
            ? `${content.slice(0, REVISION_PREVIEW_LENGTH)}…`
            : content}
        </AppText>
      ) : null}
      {entry.sourceUnavailable !== null ? (
        <AppText className="text-xs text-warning-foreground">
          {KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[entry.sourceUnavailable]}
        </AppText>
      ) : null}
    </View>
  );
}

export function ProjectFactInspector(props: {
  readonly fact: ProjectFact;
  /** Null when the server lacks history, or while it loads. */
  readonly detail: ProjectKnowledgeFactDetail | null;
  readonly detailError: string | null;
  readonly history: boolean;
  readonly sourceUnavailable: KnowledgeSourceUnavailableReason | null;
  readonly hints: ReadonlyArray<KnowledgeConflictHint>;
  readonly selection: KnowledgeSelectionState | null;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly onToggleSelection: (selection: KnowledgeSelection) => void;
  readonly onRefreshSelection: (selection: KnowledgeSelection) => void;
  readonly onReadSource: (ref: KnowledgeMessageRef) => void;
  readonly onOpenFact: OpenFact;
  readonly onEdit: (mode: "edit" | "supersede") => void;
  readonly onForget: () => void;
  readonly onFeedback: (helpful: boolean) => void;
  readonly onDismissHints: () => void;
}) {
  const { fact, detail } = props;
  const superseded = isSupersededFact(fact);
  const active = fact.status !== "forgotten";
  const mutable = props.canMutate && !props.busy;
  const citations = fact.sources.flatMap((source) => (source.kind === "message" ? [source] : []));
  return (
    <View className="gap-4">
      {props.hints.length > 0 ? (
        <View className="gap-2">
          {props.hints.map((hint) => (
            <ConflictHintRow
              key={hint.factId}
              hint={hint}
              onOpenFact={props.history ? props.onOpenFact : null}
            />
          ))}
          <Button label="Dismiss" tone="text" onPress={props.onDismissHints} />
        </View>
      ) : null}
      <View className="gap-2">
        {superseded ? (
          <AppText className="text-xs font-t3-medium text-foreground-muted">Superseded</AppText>
        ) : null}
        <AppText selectable className="text-base">
          {fact.content ?? "Forgotten fact"}
        </AppText>
        <AppText className="text-xs text-foreground-muted">
          {fact.kind} · {fact.status} · {knowledgeOriginLabel(fact.origin)}
        </AppText>
        <AppText className="text-xs text-foreground-muted">
          Trust signal {fact.trust.toFixed(2)} · revision {fact.revision}
        </AppText>
      </View>

      <View className="gap-2">
        <AppText className="text-sm font-t3-medium">Evidence</AppText>
        {props.sourceUnavailable !== null ? (
          <AppText className="text-xs text-warning-foreground">
            {KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[props.sourceUnavailable]}
          </AppText>
        ) : null}
        {citations.length === 0 ? (
          <AppText className="text-sm text-foreground-muted">No cited source</AppText>
        ) : null}
        {citations.map((ref) => (
          <Button
            key={`${ref.threadId}:${ref.messageId}`}
            label="Read source message"
            tone="text"
            onPress={() => props.onReadSource(ref)}
          />
        ))}
      </View>

      {active && props.selection ? (
        <SelectForDraftControl
          current={{ kind: "fact", factId: fact.id, revision: fact.revision }}
          state={props.selection}
          onToggle={props.onToggleSelection}
          onRefresh={props.onRefreshSelection}
        />
      ) : null}

      {active ? (
        <View className="flex-row flex-wrap gap-2">
          {!superseded ? (
            <Button
              label="Edit"
              tone="secondary"
              disabled={!mutable}
              onPress={() => props.onEdit("edit")}
            />
          ) : null}
          {props.history && !superseded ? (
            <Button
              label="Supersede"
              tone="text"
              disabled={!mutable}
              onPress={() => props.onEdit("supersede")}
            />
          ) : null}
          <Button
            label="Helpful"
            tone="text"
            disabled={!mutable}
            onPress={() => props.onFeedback(true)}
          />
          <Button
            label="Unhelpful"
            tone="text"
            disabled={!mutable}
            onPress={() => props.onFeedback(false)}
          />
          <Button label="Forget" tone="danger" disabled={!mutable} onPress={props.onForget} />
        </View>
      ) : null}
      {!props.canMutate && active ? (
        <AppText className="text-xs text-foreground-muted">
          This connection can read project memory but not change it.
        </AppText>
      ) : null}

      {props.history ? (
        <View className="gap-3">
          {props.detailError ? (
            <AppText accessibilityRole="alert" className="text-danger">
              {props.detailError}
            </AppText>
          ) : null}
          {detail === null && !props.detailError ? <AppText>Reading fact history…</AppText> : null}
          {detail?.supersedes ? (
            <SummaryRow
              label="Supersedes"
              summary={detail.supersedes}
              onOpenFact={props.onOpenFact}
            />
          ) : null}
          {detail?.supersededBy ? (
            <SummaryRow
              label="Superseded by"
              summary={detail.supersededBy}
              onOpenFact={props.onOpenFact}
            />
          ) : null}
          {detail?.hints.map((hint) => (
            <ConflictHintRow key={hint.factId} hint={hint} onOpenFact={props.onOpenFact} />
          ))}
          {detail ? (
            <>
              <AppText className="text-sm font-t3-medium">History</AppText>
              {detail.historyTruncated ? (
                <AppText className="text-xs text-foreground-muted">
                  Earlier history not shown
                </AppText>
              ) : null}
              {detail.history.map((entry) => (
                <HistoryRow key={entry.sequence} entry={entry} />
              ))}
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Exact message text, read through readSource so the citation is the canonical one. */
export function ProjectKnowledgeSourceInspector(props: {
  readonly reference: { readonly threadId: ThreadId; readonly messageId: MessageId };
  readonly source: ProjectKnowledgeSource | null;
  readonly error: string | null;
  readonly selections: ReadonlyArray<KnowledgeSelection>;
  readonly canMutate: boolean;
  readonly onToggleSelection: (selection: KnowledgeSelection) => void;
  readonly onRefreshSelection: (selection: KnowledgeSelection) => void;
  readonly onSaveAsFact: (text: string, source: KnowledgeMessageRef) => void;
}) {
  const { source } = props;
  return (
    <View className="gap-3">
      <AppText className="text-xs text-foreground-muted">
        {props.reference.threadId} / {props.reference.messageId}
      </AppText>
      {props.error ? (
        <AppText accessibilityRole="alert" className="text-danger">
          {props.error}
        </AppText>
      ) : null}
      {source === null && !props.error ? <AppText>Reading source…</AppText> : null}
      {source?.state === "unavailable" ? (
        <AppText>
          This message is unavailable ({KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[source.reason]}).
        </AppText>
      ) : null}
      {source?.state === "available" ? (
        <>
          <AppText className="text-xs text-foreground-muted">
            {source.title} · {source.role} · {source.createdAt}
            {source.archived ? " · archived" : ""}
          </AppText>
          <AppText selectable>{source.text}</AppText>
          <SelectForDraftControl
            current={source.source}
            state={knowledgeSelectionState(props.selections, source.source)}
            onToggle={props.onToggleSelection}
            onRefresh={props.onRefreshSelection}
          />
          <Button
            label="Save as fact"
            tone="text"
            disabled={!props.canMutate}
            onPress={() => props.onSaveAsFact(source.text, source.source)}
          />
        </>
      ) : null}
    </View>
  );
}

export function KnowledgeHealthRow(props: {
  readonly status: ProjectKnowledgeStatus;
  readonly onShowUnavailable: () => void;
}) {
  const { status } = props;
  const lost = status.unavailableSources;
  return (
    <View className="gap-1">
      <AppText className="text-xs text-foreground-muted">
        {status.counts.saved} saved · {status.counts.superseded} superseded ·{" "}
        {status.belowRecallThreshold} below recall · {status.feedback.helpful} helpful ·{" "}
        {status.feedback.unhelpful} unhelpful
      </AppText>
      {lost > 0 ? (
        <Button
          label={`${status.unavailableSourcesCoverage === "partial" ? "At least " : ""}${
            lost === 1 ? "1 fact lost its source" : `${lost} facts lost their source`
          }`}
          tone="text"
          onPress={props.onShowUnavailable}
        />
      ) : null}
    </View>
  );
}
