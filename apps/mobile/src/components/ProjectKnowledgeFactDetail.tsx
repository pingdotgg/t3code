import { View } from "react-native";
import { T, useGT, useMessages } from "gt-react-native";
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
import { messageAuthorLabel } from "@t3tools/client-runtime/conversationSummaries";
import {
  KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL,
  KNOWLEDGE_FACT_KIND_LABEL,
  KNOWLEDGE_FACT_STATUS_LABEL,
  canRestoreFactToRecall,
  isSupersededFact,
  knowledgeConflictHintLabel,
  knowledgeOriginLabel,
  memoryCurationRunLabel,
  projectFactVerdictLabel,
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
  const gt = useGT();
  const m = useMessages();
  return (
    <View className="gap-1 rounded-xl bg-subtle p-2">
      <AppText className="text-sm">
        {knowledgeConflictHintLabel(props.hint, m)}: “{props.hint.excerpt}”
      </AppText>
      {props.onOpenFact ? (
        <Button
          label={gt("Open that fact")}
          tone="text"
          onPress={() => props.onOpenFact?.(props.hint.factId)}
        />
      ) : null}
    </View>
  );
}

function SummaryRow(props: {
  readonly label: string;
  readonly openLabel: string;
  readonly summary: ProjectFactSummary;
  readonly onOpenFact: OpenFact;
}) {
  const gt = useGT();
  const m = useMessages();
  return (
    <View className="gap-1">
      <AppText className="text-sm">
        {gt("{label}: {excerpt} (revision {revision}, {status})", {
          label: props.label,
          excerpt: props.summary.excerpt ?? gt("Forgotten fact"),
          revision: props.summary.revision,
          status: m(KNOWLEDGE_FACT_STATUS_LABEL[props.summary.status]),
        })}
      </AppText>
      <Button
        label={props.openLabel}
        tone="text"
        onPress={() => props.onOpenFact(props.summary.id)}
      />
    </View>
  );
}

function HistoryRow(props: { readonly entry: ProjectFactHistoryEntry }) {
  const gt = useGT();
  const m = useMessages();
  const { entry } = props;
  const content =
    (entry.event === "created" || entry.event === "edited") && entry.content !== null
      ? entry.content
      : null;
  return (
    <View className="gap-1 border-l-2 border-border pl-3">
      <AppText className="font-t3-medium">{projectFactHistoryLabel(entry, m)}</AppText>
      <AppText className="text-xs text-foreground-muted">
        {knowledgeOriginLabel(entry.actor, m)} · {historyTimeFormatter.format(new Date(entry.at))}
      </AppText>
      {entry.event === "feedback" && entry.trustBefore !== null ? (
        <AppText className="text-xs">
          {gt("Trust {before} → {after}", {
            before: entry.trustBefore.toFixed(2),
            after: entry.trustAfter.toFixed(2),
          })}
        </AppText>
      ) : null}
      {entry.reason ? (
        <AppText className="text-xs text-foreground-muted">{entry.reason}</AppText>
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
          {m(KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[entry.sourceUnavailable])}
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
  readonly curation: boolean;
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
  readonly onRestore: () => void;
  readonly onFeedback: (helpful: boolean) => void;
  readonly onDismissHints: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
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
          <Button label={gt("Dismiss")} tone="text" onPress={props.onDismissHints} />
        </View>
      ) : null}
      <View className="gap-2">
        {superseded ? (
          <AppText className="text-xs font-t3-medium text-foreground-muted">
            <T context="project fact status">Superseded</T>
          </AppText>
        ) : null}
        <AppText selectable className="text-base">
          {fact.content ?? gt("Forgotten fact")}
        </AppText>
        <AppText className="text-xs text-foreground-muted">
          {m(KNOWLEDGE_FACT_KIND_LABEL[fact.kind])} · {m(KNOWLEDGE_FACT_STATUS_LABEL[fact.status])}{" "}
          · {knowledgeOriginLabel(fact.origin, m)}
        </AppText>
        {fact.verdict ? (
          <AppText className="text-xs text-foreground-muted">
            {projectFactVerdictLabel(fact.verdict, m)}{" "}
            {historyTimeFormatter.format(new Date(fact.verdict.at))}
          </AppText>
        ) : null}
        <AppText className="text-xs text-foreground-muted">
          {gt("Trust signal {trust} · revision {revision}", {
            trust: fact.trust.toFixed(2),
            revision: fact.revision,
          })}
        </AppText>
      </View>

      <View className="gap-2">
        <AppText className="text-sm font-t3-medium">
          <T context="project fact evidence">Evidence</T>
        </AppText>
        {props.sourceUnavailable !== null ? (
          <AppText className="text-xs text-warning-foreground">
            {m(KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[props.sourceUnavailable])}
          </AppText>
        ) : null}
        {citations.length === 0 ? (
          <AppText className="text-sm text-foreground-muted">
            <T>No cited source</T>
          </AppText>
        ) : null}
        {citations.map((ref) => (
          <Button
            key={`${ref.threadId}:${ref.messageId}`}
            label={gt("Read source message")}
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
          {props.curation && canRestoreFactToRecall(fact) ? (
            <Button
              label={gt("Restore to recall")}
              tone="secondary"
              disabled={!mutable}
              onPress={props.onRestore}
            />
          ) : null}
          {!superseded ? (
            <Button
              label={gt("Edit", { $context: "edit a project fact" })}
              tone="secondary"
              disabled={!mutable}
              onPress={() => props.onEdit("edit")}
            />
          ) : null}
          {props.history && !superseded ? (
            <Button
              label={gt("Supersede", { $context: "replace a project fact" })}
              tone="text"
              disabled={!mutable}
              onPress={() => props.onEdit("supersede")}
            />
          ) : null}
          <Button
            label={gt("Helpful", { $context: "project fact feedback" })}
            tone="text"
            disabled={!mutable}
            onPress={() => props.onFeedback(true)}
          />
          <Button
            label={gt("Unhelpful", { $context: "project fact feedback" })}
            tone="text"
            disabled={!mutable}
            onPress={() => props.onFeedback(false)}
          />
          <Button
            label={gt("Forget", { $context: "permanently forget a project fact" })}
            tone="danger"
            disabled={!mutable}
            onPress={props.onForget}
          />
        </View>
      ) : null}
      {!props.canMutate && active ? (
        <AppText className="text-xs text-foreground-muted">
          <T>This connection can read project memory but not change it.</T>
        </AppText>
      ) : null}

      {props.history ? (
        <View className="gap-3">
          {props.detailError ? (
            <AppText accessibilityRole="alert" className="text-danger">
              {props.detailError}
            </AppText>
          ) : null}
          {detail === null && !props.detailError ? (
            <AppText>
              <T>Reading fact history…</T>
            </AppText>
          ) : null}
          {detail?.supersedes ? (
            <SummaryRow
              label={gt("Supersedes", { $context: "project fact relation" })}
              openLabel={gt("Open supersedes", { $context: "open the fact replaced by this fact" })}
              summary={detail.supersedes}
              onOpenFact={props.onOpenFact}
            />
          ) : null}
          {detail?.supersededBy ? (
            <SummaryRow
              label={gt("Superseded by", { $context: "project fact relation" })}
              openLabel={gt("Open superseded by", {
                $context: "open the fact that replaced this fact",
              })}
              summary={detail.supersededBy}
              onOpenFact={props.onOpenFact}
            />
          ) : null}
          {detail?.hints.map((hint) => (
            <ConflictHintRow key={hint.factId} hint={hint} onOpenFact={props.onOpenFact} />
          ))}
          {detail ? (
            <>
              <AppText className="text-sm font-t3-medium">
                <T context="project fact history">History</T>
              </AppText>
              {detail.historyTruncated ? (
                <AppText className="text-xs text-foreground-muted">
                  <T>Earlier history not shown</T>
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
  const gt = useGT();
  const m = useMessages();
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
      {source === null && !props.error ? (
        <AppText>
          <T>Reading source…</T>
        </AppText>
      ) : null}
      {source?.state === "unavailable" ? (
        <AppText>
          {gt("This message is unavailable ({reason}).", {
            reason: m(KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[source.reason]),
          })}
        </AppText>
      ) : null}
      {source?.state === "available" ? (
        <>
          <AppText className="text-xs text-foreground-muted">
            {source.title} · {messageAuthorLabel(source.role, source.speaker, source.provenance, m)}{" "}
            · {source.createdAt}
            {source.archived ? gt(" · archived", { $context: "source thread status suffix" }) : ""}
          </AppText>
          <AppText selectable>{source.text}</AppText>
          <SelectForDraftControl
            current={source.source}
            state={knowledgeSelectionState(props.selections, source.source)}
            onToggle={props.onToggleSelection}
            onRefresh={props.onRefreshSelection}
          />
          <Button
            label={gt("Save as fact")}
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
  const gt = useGT();
  const m = useMessages();
  const { status } = props;
  const lost = status.unavailableSources;
  return (
    <View className="gap-1">
      <AppText className="text-xs text-foreground-muted">
        {gt(
          "{saved} saved · {superseded} superseded · {belowRecall} below recall · {helpful} helpful · {unhelpful} unhelpful",
          {
            saved: status.counts.saved,
            superseded: status.counts.superseded,
            belowRecall: status.belowRecallThreshold,
            helpful: status.feedback.helpful,
            unhelpful: status.feedback.unhelpful,
          },
        )}
      </AppText>
      {status.curation ? (
        <AppText className="text-xs text-foreground-muted">
          {memoryCurationRunLabel(status.curation, m)}
          {status.curation.completedAt
            ? ` · ${historyTimeFormatter.format(new Date(status.curation.completedAt))}`
            : ""}
        </AppText>
      ) : null}
      {lost > 0 ? (
        <Button
          label={gt(
            "{coverage, select, partial {At least } other {}}{count, plural, one {1 fact lost its source} other {{count} facts lost their source}}",
            { coverage: status.unavailableSourcesCoverage, count: lost },
          )}
          tone="text"
          onPress={props.onShowUnavailable}
        />
      ) : null}
    </View>
  );
}
