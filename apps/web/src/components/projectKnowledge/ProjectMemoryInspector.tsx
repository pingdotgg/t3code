import type {
  EnvironmentId,
  KnowledgeMessageRef,
  KnowledgeSourceUnavailableReason,
  ProjectFact,
  ProjectFactId,
  ProjectId,
  ProjectKnowledgeSearchResult,
  ProjectKnowledgeSource,
} from "@t3tools/contracts";
import { messageAuthorLabel } from "@t3tools/client-runtime/conversationSummaries";
import { T, useGT, useMessages } from "gt-react";
import {
  KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL,
  KNOWLEDGE_FACT_KIND_LABEL,
  canRestoreFactToRecall,
  isSupersededFact,
  knowledgeOriginLabel,
  projectFactVerdictLabel,
} from "@t3tools/client-runtime/projectKnowledge";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { useEnvironmentQuery } from "../../state/query";
import { projectKnowledge } from "../../state/projectKnowledge";
import { ProjectFactHistory, ProjectFactRelations } from "./ProjectFactDetail";
import type { EditableFact } from "./ProjectFactEditor";
import { factStatusBadge, shortFactId } from "./projectMemoryLabels";

export type SourceRef = {
  readonly threadId: KnowledgeMessageRef["threadId"];
  readonly messageId: KnowledgeMessageRef["messageId"];
  // Optional so a timeline message can be cited before the server has hashed it; readSource
  // returns the canonical ref.
  readonly digest?: KnowledgeMessageRef["digest"];
};

type KnowledgeScore = Extract<
  ProjectKnowledgeSearchResult["facts"],
  { state: "available" }
>["matches"][number]["score"];

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** Heading the controller moves focus to when the inspector content changes on narrow screens. */
export const INSPECTOR_HEADING = "[data-inspector-heading]";

const DISCLOSURE_TRIGGER_CLASS =
  "group flex items-center gap-1 rounded-sm font-medium text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function Disclosure(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="border-t pt-3">
      <Collapsible>
        <CollapsibleTrigger className={DISCLOSURE_TRIGGER_CLASS}>
          <ChevronRightIcon className="size-3.5 group-data-panel-open:rotate-90" aria-hidden />
          {props.label}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="pt-2">{props.children}</div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function InspectorHeading(props: { readonly children: ReactNode }) {
  return (
    <h3
      tabIndex={-1}
      data-inspector-heading
      className="flex flex-wrap items-center gap-2 rounded-sm font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {props.children}
    </h3>
  );
}

export function InspectorEmpty() {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-1 p-6 text-center">
      <p className="font-medium text-sm">
        <T>Select a fact to inspect</T>
      </p>
      <p className="max-w-64 text-muted-foreground text-xs">
        <T>Read its evidence and history here. Inspecting a fact does not add it to the draft.</T>
      </p>
    </div>
  );
}

export function FactInspector(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly factId: ProjectFactId;
  readonly listedFact: ProjectFact | undefined;
  readonly score: KnowledgeScore | undefined;
  readonly unavailableReason: KnowledgeSourceUnavailableReason | undefined;
  readonly historyAvailable: boolean;
  readonly curationAvailable: boolean;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly onEdit: (fact: EditableFact, supersede: boolean) => void;
  readonly onRevise: (
    fact: ProjectFact,
    action: "forget" | "feedback" | "restore",
    helpful?: boolean,
  ) => void;
  readonly onOpenSource: (source: KnowledgeMessageRef) => void;
  readonly onOpenFact: (factId: ProjectFactId) => void;
  readonly onBackToResults: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  // One readFact per inspected fact: history, supersede links and hints are never read per row.
  const detailQuery = useEnvironmentQuery(
    props.historyAvailable
      ? projectKnowledge.readFact({
          environmentId: props.environmentId,
          input: { projectId: props.projectId, factId: props.factId },
        })
      : null,
  );
  const detail = detailQuery.data?.fact.id === props.factId ? detailQuery.data : null;
  // A mutation can remove the row from these results; detail still owns its latest revision.
  const fact =
    detail && (!props.listedFact || detail.fact.revision >= props.listedFact.revision)
      ? detail.fact
      : props.listedFact;
  if (!fact) {
    if (props.historyAvailable && !detailQuery.error) {
      return (
        <p role="status">
          <T>Reading fact…</T>
        </p>
      );
    }
    return (
      <div className="flex flex-col items-start gap-2">
        <InspectorHeading>
          <T>Fact not in these results</T>
        </InspectorHeading>
        {detailQuery.error ? <p role="alert">{detailQuery.error}</p> : null}
        <p className="text-muted-foreground text-sm">
          {gt("Fact {factId} is not part of the current list or search.", {
            factId: shortFactId(props.factId),
          })}
        </p>
        <Button size="sm" variant="outline" onClick={props.onBackToResults}>
          <T>Back to results</T>
        </Button>
      </div>
    );
  }
  const status = factStatusBadge(fact, m);
  const superseded = isSupersededFact(fact);
  const sourceUnavailable = props.unavailableReason ?? detail?.sourceUnavailable ?? null;
  const locked = !props.canMutate || props.busy;
  const citations = fact.sources.flatMap((source) => (source.kind === "message" ? [source] : []));
  return (
    <article className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <InspectorHeading>
          <Badge variant={status.variant}>{status.label}</Badge>
          <span>{m(KNOWLEDGE_FACT_KIND_LABEL[fact.kind])}</span>
        </InspectorHeading>
        <div className="flex flex-wrap gap-1.5">
          {sourceUnavailable ? (
            <Badge variant="warning">
              {m(KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[sourceUnavailable])}
            </Badge>
          ) : null}
          {fact.supersededBy ? (
            <Badge variant="secondary">
              {gt("Superseded by {factId}", { factId: shortFactId(fact.supersededBy) })}
            </Badge>
          ) : null}
          {fact.supersedes ? (
            <Badge variant="outline">
              {gt("Supersedes {factId}", { factId: shortFactId(fact.supersedes) })}
            </Badge>
          ) : null}
        </div>
      </div>
      <p className="whitespace-pre-wrap text-base leading-relaxed">
        {fact.content ?? gt("Forgotten fact")}
      </p>
      {fact.verdict ? (
        <p className="text-muted-foreground text-sm">
          {projectFactVerdictLabel(fact.verdict, m)}{" "}
          <time dateTime={fact.verdict.at}>{dateFormatter.format(new Date(fact.verdict.at))}</time>
        </p>
      ) : null}
      {fact.entities.length + fact.tags.length > 0 ? (
        <ul aria-label={gt("Entities and tags")} className="flex flex-wrap gap-1.5">
          {[...new Set([...fact.entities, ...fact.tags])].map((label) => (
            <li key={label}>
              <Badge variant="outline">{label}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {fact.status !== "forgotten" ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {props.curationAvailable && canRestoreFactToRecall(fact) ? (
              <Button
                disabled={locked}
                size="sm"
                variant="outline"
                onClick={() => props.onRevise(fact, "restore")}
              >
                <T>Restore to recall</T>
              </Button>
            ) : null}
            {/* The server rejects revisions of a superseded fact; its replacement is the one to change. */}
            {!superseded ? (
              <Button
                disabled={locked}
                size="sm"
                variant="outline"
                data-inspector-edit
                onClick={() => props.onEdit(fact, false)}
              >
                <T context="edit a project fact">Edit</T>
              </Button>
            ) : null}
            {props.historyAvailable && !superseded ? (
              <Button
                disabled={locked}
                size="sm"
                variant="outline"
                onClick={() => props.onEdit(fact, true)}
              >
                <T context="replace a project fact">Supersede</T>
              </Button>
            ) : null}
            <Button
              disabled={locked}
              size="sm"
              variant="ghost"
              onClick={() => props.onRevise(fact, "feedback", true)}
            >
              <T context="project fact feedback">Helpful</T>
            </Button>
            <Button
              disabled={locked}
              size="sm"
              variant="ghost"
              onClick={() => props.onRevise(fact, "feedback", false)}
            >
              <T context="project fact feedback">Unhelpful</T>
            </Button>
            <Button
              disabled={locked}
              size="sm"
              variant="ghost-destructive"
              onClick={() => props.onRevise(fact, "forget")}
            >
              <T context="permanently forget a project fact">Forget</T>
            </Button>
          </div>
          {!props.canMutate ? (
            <p className="text-muted-foreground text-xs">
              <T>This environment grants read access only.</T>
            </p>
          ) : null}
        </div>
      ) : null}
      <section aria-labelledby="project-fact-evidence" className="flex flex-col gap-1.5">
        <h4 id="project-fact-evidence" className="font-medium text-sm">
          <T context="project fact evidence">Evidence</T>
        </h4>
        <p className="text-muted-foreground text-sm">{knowledgeOriginLabel(fact.origin, m)}</p>
        {citations.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {citations.map((ref) => (
              <Button
                key={`${ref.threadId}:${ref.messageId}`}
                variant="link"
                size="sm"
                onClick={() => props.onOpenSource(ref)}
              >
                {gt("Message {messageId}", { messageId: ref.messageId })}
              </Button>
            ))}
          </div>
        ) : null}
      </section>
      {detail ? <ProjectFactRelations detail={detail} onOpenFact={props.onOpenFact} /> : null}
      {detailQuery.error ? <p role="alert">{detailQuery.error}</p> : null}
      {detail ? <ProjectFactHistory detail={detail} onOpenSource={props.onOpenSource} /> : null}
      {props.score ? (
        <Disclosure label={gt("Why this matched")}>
          <p className="text-sm">
            {gt(
              "Holographic {holographic} · Text {text} · Overlap {overlap} · Age {age} · Use {use} · Trust signal {trust} · Match score {score}",
              {
                holographic: props.score.holographic.toFixed(3),
                text: props.score.lexical.toFixed(3),
                overlap: props.score.tokenOverlap.toFixed(3),
                age: props.score.temporalDecay.toFixed(3),
                use: props.score.reinforcement.toFixed(3),
                trust: props.score.trust.toFixed(2),
                score: props.score.combined.toFixed(6),
              },
            )}
          </p>
          <p className="text-muted-foreground text-xs">
            <T>
              Ranking combines lexical evidence and deterministic holographic similarity. It does
              not establish truth.
            </T>
          </p>
        </Disclosure>
      ) : null}
      <Disclosure label={gt("Technical details")}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">
            <T context="project fact revision">Revision</T>
          </dt>
          <dd>{fact.revision}</dd>
          <dt className="text-muted-foreground">
            <T>Trust signal</T>
          </dt>
          <dd>{fact.trust.toFixed(2)}</dd>
          <dt className="text-muted-foreground">
            <T context="project fact retrieval count">Retrievals</T>
          </dt>
          <dd>{fact.retrievalCount}</dd>
          <dt className="text-muted-foreground">
            <T context="project fact update time">Updated</T>
          </dt>
          <dd>
            <time dateTime={fact.updatedAt}>{dateFormatter.format(new Date(fact.updatedAt))}</time>
          </dd>
          <dt className="text-muted-foreground">
            <T>Fact ID</T>
          </dt>
          <dd className="break-all font-mono">{fact.id}</dd>
        </dl>
      </Disclosure>
    </article>
  );
}

export function SourceInspector(props: {
  readonly source: SourceRef;
  readonly data: ProjectKnowledgeSource | null;
  readonly error: string | null;
  readonly selected: boolean;
  readonly canMutate: boolean;
  readonly onBack: (() => void) | null;
  readonly onToggleSelect: (ref: KnowledgeMessageRef) => void;
  readonly onSaveAsFact: (text: string, ref: KnowledgeMessageRef) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { data } = props;
  return (
    <article className="flex flex-col gap-3">
      {props.onBack ? (
        <Button className="self-start" size="sm" variant="ghost" onClick={props.onBack}>
          <T>Back to fact</T>
        </Button>
      ) : null}
      <InspectorHeading>
        <T>Exact source</T>
      </InspectorHeading>
      <p className="break-all text-muted-foreground text-xs">
        {props.source.threadId}/{props.source.messageId}
        {props.source.digest ? <code>{` · sha256:${props.source.digest}`}</code> : null}
      </p>
      {props.error ? (
        <p role="alert">{props.error}</p>
      ) : data?.state === "unavailable" ? (
        <p>{gt("Source unavailable. {reason}", { reason: data.reason })}</p>
      ) : data?.state === "available" ? (
        <>
          <p className="text-muted-foreground text-xs">
            {data.title} · {messageAuthorLabel(data.role, data.speaker, data.provenance, m)} ·{" "}
            {dateFormatter.format(new Date(data.createdAt))}
            {data.archived ? gt(" · archived", { $context: "source thread status suffix" }) : ""}
          </p>
          <pre className="whitespace-pre-wrap border-s-2 ps-3 font-sans text-sm leading-relaxed">
            {data.text}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => props.onToggleSelect(data.source)}>
              {props.selected ? gt("Remove message from draft") : gt("Select message for draft")}
            </Button>
            <Button
              disabled={!props.canMutate}
              size="sm"
              variant="outline"
              onClick={() => props.onSaveAsFact(data.text, data.source)}
            >
              <T>Save as fact</T>
            </Button>
          </div>
        </>
      ) : (
        <p role="status">
          <T>Reading source…</T>
        </p>
      )}
    </article>
  );
}
