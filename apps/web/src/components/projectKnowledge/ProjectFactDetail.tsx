import { useState } from "react";
import type {
  KnowledgeConflictHint,
  KnowledgeMessageRef,
  ProjectFactHistoryEntry,
  ProjectFactId,
  ProjectFactSummary,
  ProjectKnowledgeFactDetail,
  ProjectKnowledgeStatus,
} from "@t3tools/contracts";
import {
  KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL,
  knowledgeConflictHintLabel,
  knowledgeOriginLabel,
  projectFactHistoryLabel,
  projectFactTrustPoints,
} from "@t3tools/client-runtime/projectKnowledge";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

type OpenFact = (factId: ProjectFactId) => void;

const historyTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 24;

// Trust lives in [0, 1]; a fixed scale keeps a flat history visibly flat instead of
// stretching noise across the full height.
function TrustSparkline(props: { readonly points: ReadonlyArray<number> }) {
  const first = props.points[0] ?? 0;
  const last = props.points.at(-1) ?? 0;
  const step = SPARK_WIDTH / (props.points.length - 1);
  const coordinates = props.points
    .map((point, index) => {
      const clamped = Math.min(1, Math.max(0, point));
      return `${(index * step).toFixed(1)},${(SPARK_HEIGHT - clamped * SPARK_HEIGHT).toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      role="img"
      aria-label={`Trust from ${first.toFixed(2)} to ${last.toFixed(2)}`}
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      className="overflow-visible text-muted-foreground"
    >
      <polyline points={coordinates} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

/** Lexical hint shown with the fact it was computed against; compare is local and transient. */
export function ConflictHintRow(props: {
  readonly hint: KnowledgeConflictHint;
  readonly currentContent: string | null;
  readonly onOpenFact: OpenFact | null;
}) {
  const [comparing, setComparing] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <p>
        {knowledgeConflictHintLabel(props.hint)}: <q>{props.hint.excerpt}</q>
      </p>
      <div className="flex flex-wrap gap-2">
        {props.onOpenFact ? (
          <Button variant="link" size="sm" onClick={() => props.onOpenFact?.(props.hint.factId)}>
            Open that fact
          </Button>
        ) : null}
        {props.currentContent !== null ? (
          <Button variant="ghost" size="sm" onClick={() => setComparing((value) => !value)}>
            {comparing ? "Hide comparison" : "Compare"}
          </Button>
        ) : null}
      </div>
      {comparing && props.currentContent !== null ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <figure className="rounded-md border p-2">
            <figcaption className="text-xs text-muted-foreground">This fact</figcaption>
            <p className="whitespace-pre-wrap text-sm">{props.currentContent}</p>
          </figure>
          <figure className="rounded-md border p-2">
            <figcaption className="text-xs text-muted-foreground">
              Existing fact, revision {props.hint.revision}
            </figcaption>
            <p className="whitespace-pre-wrap text-sm">{props.hint.excerpt}</p>
          </figure>
        </div>
      ) : null}
    </div>
  );
}

function SummaryRow(props: {
  readonly label: string;
  readonly summary: ProjectFactSummary;
  readonly onOpenFact: OpenFact;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span>
        {props.label}: {props.summary.excerpt ?? "Forgotten fact"} (revision{" "}
        {props.summary.revision}, {props.summary.status})
      </span>
      <Button variant="link" size="sm" onClick={() => props.onOpenFact(props.summary.id)}>
        Open
      </Button>
    </div>
  );
}

function HistoryRow(props: {
  readonly entry: ProjectFactHistoryEntry;
  readonly onOpenSource: (source: KnowledgeMessageRef) => void;
}) {
  const { entry } = props;
  const showsContent =
    (entry.event === "created" || entry.event === "edited") && entry.content !== null;
  return (
    <li className="flex flex-col gap-1 border-l-2 pl-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{projectFactHistoryLabel(entry)}</span>
        <span className="text-xs text-muted-foreground">
          {knowledgeOriginLabel(entry.actor)} ·{" "}
          <time dateTime={entry.at}>{historyTimeFormatter.format(new Date(entry.at))}</time>
        </span>
      </div>
      {entry.event === "feedback" && entry.trustBefore !== null ? (
        <p className="text-xs">
          Trust {entry.trustBefore.toFixed(2)} → {entry.trustAfter.toFixed(2)}
        </p>
      ) : null}
      {showsContent ? (
        <details>
          <summary className="text-xs">Revision {entry.revision} content</summary>
          <p className="whitespace-pre-wrap text-sm">{entry.content}</p>
        </details>
      ) : null}
      {entry.sources.some((source) => source.kind === "message") ||
      entry.sourceUnavailable !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          {entry.sources.map((source) =>
            source.kind === "message" ? (
              <Button
                key={`${source.threadId}:${source.messageId}`}
                variant="link"
                size="sm"
                onClick={() => props.onOpenSource(source)}
              >
                Message {source.messageId}
              </Button>
            ) : null,
          )}
          {entry.sourceUnavailable !== null ? (
            <Badge variant="warning">
              {KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[entry.sourceUnavailable]}
            </Badge>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Supersede links and conflict hints the server computed for the inspected fact. */
export function ProjectFactRelations(props: {
  readonly detail: ProjectKnowledgeFactDetail;
  readonly onOpenFact: OpenFact;
}) {
  const { detail } = props;
  if (!detail.supersedes && !detail.supersededBy && detail.hints.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {detail.supersedes ? (
        <SummaryRow label="Supersedes" summary={detail.supersedes} onOpenFact={props.onOpenFact} />
      ) : null}
      {detail.supersededBy ? (
        <SummaryRow
          label="Superseded by"
          summary={detail.supersededBy}
          onOpenFact={props.onOpenFact}
        />
      ) : null}
      {detail.hints.map((hint) => (
        <ConflictHintRow
          key={hint.factId}
          hint={hint}
          currentContent={detail.fact.content}
          onOpenFact={props.onOpenFact}
        />
      ))}
    </div>
  );
}

export function ProjectFactHistory(props: {
  readonly detail: ProjectKnowledgeFactDetail;
  readonly onOpenSource: (source: KnowledgeMessageRef) => void;
}) {
  const { detail } = props;
  const trust = projectFactTrustPoints(detail.history);
  return (
    <section aria-labelledby="project-fact-history" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h4 id="project-fact-history" className="font-medium text-sm">
          History
        </h4>
        {trust.length >= 2 ? <TrustSparkline points={trust} /> : null}
      </div>
      {detail.historyTruncated ? (
        <p className="text-xs text-muted-foreground">Earlier history not shown</p>
      ) : null}
      <ol aria-label="Fact history" className="flex flex-col gap-2">
        {detail.history.map((entry) => (
          <HistoryRow key={entry.sequence} entry={entry} onOpenSource={props.onOpenSource} />
        ))}
      </ol>
    </section>
  );
}

export function KnowledgeHealthStrip(props: { readonly status: ProjectKnowledgeStatus }) {
  const { status } = props;
  const counters = [
    ["Saved", status.counts.saved],
    ["Superseded", status.counts.superseded],
    ["Below recall threshold", status.belowRecallThreshold],
    ["Retrievals", status.retrievals],
    ["Helpful", status.feedback.helpful],
    ["Unhelpful", status.feedback.unhelpful],
  ] as const;
  return (
    <dl
      aria-label="Memory health"
      className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
    >
      {counters.map(([label, value]) => (
        <div key={label} className="flex gap-1">
          <dt>{label}</dt>
          <dd className="tabular-nums text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
