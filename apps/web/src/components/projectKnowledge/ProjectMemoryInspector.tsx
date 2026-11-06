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
import {
  KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL,
  isSupersededFact,
  knowledgeOriginLabel,
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
      <p className="font-medium text-sm">Select a fact to inspect</p>
      <p className="max-w-64 text-muted-foreground text-xs">
        Read its evidence and history here. Inspecting a fact does not add it to the draft.
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
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly onEdit: (fact: EditableFact, supersede: boolean) => void;
  readonly onRevise: (fact: ProjectFact, action: "forget" | "feedback", helpful?: boolean) => void;
  readonly onOpenSource: (source: KnowledgeMessageRef) => void;
  readonly onOpenFact: (factId: ProjectFactId) => void;
  readonly onBackToResults: () => void;
}) {
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
      return <p role="status">Reading fact…</p>;
    }
    return (
      <div className="flex flex-col items-start gap-2">
        <InspectorHeading>Fact not in these results</InspectorHeading>
        {detailQuery.error ? <p role="alert">{detailQuery.error}</p> : null}
        <p className="text-muted-foreground text-sm">
          Fact {shortFactId(props.factId)} is not part of the current list or search.
        </p>
        <Button size="sm" variant="outline" onClick={props.onBackToResults}>
          Back to results
        </Button>
      </div>
    );
  }
  const status = factStatusBadge(fact);
  const superseded = isSupersededFact(fact);
  const sourceUnavailable = props.unavailableReason ?? detail?.sourceUnavailable ?? null;
  const locked = !props.canMutate || props.busy;
  const citations = fact.sources.flatMap((source) => (source.kind === "message" ? [source] : []));
  return (
    <article className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <InspectorHeading>
          <Badge variant={status.variant}>{status.label}</Badge>
          <span>{fact.kind}</span>
        </InspectorHeading>
        <div className="flex flex-wrap gap-1.5">
          {sourceUnavailable ? (
            <Badge variant="warning">{KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[sourceUnavailable]}</Badge>
          ) : null}
          {fact.supersededBy ? (
            <Badge variant="secondary">Superseded by {shortFactId(fact.supersededBy)}</Badge>
          ) : null}
          {fact.supersedes ? (
            <Badge variant="outline">Supersedes {shortFactId(fact.supersedes)}</Badge>
          ) : null}
        </div>
      </div>
      <p className="whitespace-pre-wrap text-base leading-relaxed">
        {fact.content ?? "Forgotten fact"}
      </p>
      {fact.entities.length + fact.tags.length > 0 ? (
        <ul aria-label="Entities and tags" className="flex flex-wrap gap-1.5">
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
            {/* The server rejects revisions of a superseded fact; its replacement is the one to change. */}
            {!superseded ? (
              <Button
                disabled={locked}
                size="sm"
                variant="outline"
                data-inspector-edit
                onClick={() => props.onEdit(fact, false)}
              >
                Edit
              </Button>
            ) : null}
            {props.historyAvailable && !superseded ? (
              <Button
                disabled={locked}
                size="sm"
                variant="outline"
                onClick={() => props.onEdit(fact, true)}
              >
                Supersede
              </Button>
            ) : null}
            <Button
              disabled={locked}
              size="sm"
              variant="ghost"
              onClick={() => props.onRevise(fact, "feedback", true)}
            >
              Helpful
            </Button>
            <Button
              disabled={locked}
              size="sm"
              variant="ghost"
              onClick={() => props.onRevise(fact, "feedback", false)}
            >
              Unhelpful
            </Button>
            <Button
              disabled={locked}
              size="sm"
              variant="ghost-destructive"
              onClick={() => props.onRevise(fact, "forget")}
            >
              Forget
            </Button>
          </div>
          {!props.canMutate ? (
            <p className="text-muted-foreground text-xs">
              This environment grants read access only.
            </p>
          ) : null}
        </div>
      ) : null}
      <section aria-labelledby="project-fact-evidence" className="flex flex-col gap-1.5">
        <h4 id="project-fact-evidence" className="font-medium text-sm">
          Evidence
        </h4>
        <p className="text-muted-foreground text-sm">{knowledgeOriginLabel(fact.origin)}</p>
        {citations.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {citations.map((ref) => (
              <Button
                key={`${ref.threadId}:${ref.messageId}`}
                variant="link"
                size="sm"
                onClick={() => props.onOpenSource(ref)}
              >
                Message {ref.messageId}
              </Button>
            ))}
          </div>
        ) : null}
      </section>
      {detail ? <ProjectFactRelations detail={detail} onOpenFact={props.onOpenFact} /> : null}
      {detailQuery.error ? <p role="alert">{detailQuery.error}</p> : null}
      {detail ? <ProjectFactHistory detail={detail} onOpenSource={props.onOpenSource} /> : null}
      {props.score ? (
        <Disclosure label="Why this matched">
          <p className="text-sm">
            Holographic {props.score.holographic.toFixed(3)} · Text {props.score.lexical.toFixed(3)}{" "}
            · Overlap {props.score.tokenOverlap.toFixed(3)} · Age{" "}
            {props.score.temporalDecay.toFixed(3)} · Use {props.score.reinforcement.toFixed(3)} ·
            Trust signal {props.score.trust.toFixed(2)} · Match score{" "}
            {props.score.combined.toFixed(6)}
          </p>
          <p className="text-muted-foreground text-xs">
            Ranking combines lexical evidence and deterministic holographic similarity. It does not
            establish truth.
          </p>
        </Disclosure>
      ) : null}
      <Disclosure label="Technical details">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Revision</dt>
          <dd>{fact.revision}</dd>
          <dt className="text-muted-foreground">Trust signal</dt>
          <dd>{fact.trust.toFixed(2)}</dd>
          <dt className="text-muted-foreground">Retrievals</dt>
          <dd>{fact.retrievalCount}</dd>
          <dt className="text-muted-foreground">Updated</dt>
          <dd>
            <time dateTime={fact.updatedAt}>{dateFormatter.format(new Date(fact.updatedAt))}</time>
          </dd>
          <dt className="text-muted-foreground">Fact ID</dt>
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
  const { data } = props;
  return (
    <article className="flex flex-col gap-3">
      {props.onBack ? (
        <Button className="self-start" size="sm" variant="ghost" onClick={props.onBack}>
          Back to fact
        </Button>
      ) : null}
      <InspectorHeading>Exact source</InspectorHeading>
      <p className="break-all text-muted-foreground text-xs">
        {props.source.threadId}/{props.source.messageId}
        {props.source.digest ? ` · sha256:${props.source.digest}` : null}
      </p>
      {props.error ? (
        <p role="alert">{props.error}</p>
      ) : data?.state === "unavailable" ? (
        <p>Source unavailable. {data.reason}</p>
      ) : data?.state === "available" ? (
        <>
          <p className="text-muted-foreground text-xs">
            {data.title} · {data.role} · {dateFormatter.format(new Date(data.createdAt))}
            {data.archived ? " · archived" : ""}
          </p>
          <pre className="whitespace-pre-wrap border-s-2 ps-3 font-sans text-sm leading-relaxed">
            {data.text}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => props.onToggleSelect(data.source)}>
              {props.selected ? "Remove message from draft" : "Select message for draft"}
            </Button>
            <Button
              disabled={!props.canMutate}
              size="sm"
              variant="outline"
              onClick={() => props.onSaveAsFact(data.text, data.source)}
            >
              Save as fact
            </Button>
          </div>
        </>
      ) : (
        <p role="status">Reading source…</p>
      )}
    </article>
  );
}
