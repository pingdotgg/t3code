import type { KeyboardEvent, ReactNode } from "react";
import type {
  KnowledgeMessageRef,
  KnowledgeSourceUnavailableReason,
  ProjectFact,
  ProjectFactId,
  ProjectKnowledgeSearchResult,
} from "@t3tools/contracts";
import {
  KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL,
  isSupersededFact,
} from "@t3tools/client-runtime/projectKnowledge";
import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import { factStatusBadge, factRowKey, messageRowKey, shortFactId } from "./projectMemoryLabels";

type MessageMatch = ProjectKnowledgeSearchResult["messages"]["matches"][number];

// Rows carry a bounded excerpt; the inspector renders the full fact (up to 12,000 characters).
const ROW_EXCERPT_LENGTH = 280;

const ROW_BUTTON_CLASS =
  "flex w-full min-w-0 flex-col gap-1 rounded-lg border border-transparent px-3 py-2.5 text-start outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-[current=true]:border-border aria-[current=true]:bg-accent";

const revealOnMount = (node: HTMLElement | null) => node?.scrollIntoView({ block: "nearest" });

// Arrow keys move between row buttons; Enter or Space inspects. Checkboxes stay in Tab order so
// selecting for the draft never depends on which row is inspected.
function moveRowFocus(event: KeyboardEvent<HTMLDivElement>) {
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-memory-row]")];
  const index = rows.indexOf(event.target as HTMLElement);
  if (index < 0) return;
  const next =
    event.key === "ArrowDown"
      ? Math.min(index + 1, rows.length - 1)
      : event.key === "ArrowUp"
        ? Math.max(index - 1, 0)
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? rows.length - 1
            : null;
  if (next === null) return;
  event.preventDefault();
  rows[next]?.focus();
}

export function ProjectMemoryFactList(props: {
  readonly facts: ReadonlyArray<ProjectFact>;
  readonly unavailableReasons: ReadonlyMap<ProjectFactId, KnowledgeSourceUnavailableReason>;
  readonly messages: ReadonlyArray<MessageMatch>;
  readonly inspectedKey: string | null;
  readonly selectedFactIds: ReadonlySet<ProjectFactId>;
  readonly revealFactId: ProjectFactId | null;
  readonly onInspectFact: (factId: ProjectFactId) => void;
  readonly onInspectMessage: (ref: KnowledgeMessageRef) => void;
  readonly onToggleFact: (fact: ProjectFact) => void;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 px-2 pb-3" onKeyDown={moveRowFocus}>
      {props.facts.length > 0 ? (
        <ul aria-label="Project facts" className="flex flex-col gap-0.5">
          {props.facts.map((fact) => {
            const key = factRowKey(fact.id);
            const status = factStatusBadge(fact);
            const unavailable = props.unavailableReasons.get(fact.id);
            const excerpt = (fact.content ?? "Forgotten fact").slice(0, ROW_EXCERPT_LENGTH);
            return (
              <li key={fact.id} className="relative">
                <button
                  type="button"
                  className={ROW_BUTTON_CLASS}
                  data-memory-row={key}
                  aria-current={props.inspectedKey === key ? "true" : undefined}
                  ref={fact.id === props.revealFactId ? revealOnMount : undefined}
                  onClick={() => props.onInspectFact(fact.id)}
                >
                  <span className="flex flex-wrap items-center gap-1.5 pe-7 text-xs">
                    <Badge size="sm" variant={status.variant}>
                      {status.label}
                    </Badge>
                    {fact.origin.kind === "assisted" ? (
                      <Badge size="sm" variant="outline">
                        Automatic
                      </Badge>
                    ) : null}
                    <span className="text-muted-foreground">{fact.kind}</span>
                    {unavailable ? (
                      <Badge size="sm" variant="warning">
                        {KNOWLEDGE_SOURCE_UNAVAILABLE_LABEL[unavailable]}
                      </Badge>
                    ) : null}
                    {isSupersededFact(fact) && fact.supersededBy ? (
                      <Badge size="sm" variant="secondary">
                        Superseded by {shortFactId(fact.supersededBy)}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="line-clamp-2 whitespace-pre-wrap text-sm">{excerpt}</span>
                </button>
                {fact.status !== "forgotten" ? (
                  <Checkbox
                    className="absolute end-3 top-3"
                    aria-label={`Select for draft: ${excerpt.slice(0, 80)}`}
                    checked={props.selectedFactIds.has(fact.id)}
                    onCheckedChange={() => props.onToggleFact(fact)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {props.messages.length > 0 ? (
        <section aria-labelledby="project-memory-conversations" className="flex flex-col gap-1">
          <h3
            id="project-memory-conversations"
            className="px-3 font-medium text-muted-foreground text-xs"
          >
            Conversations
          </h3>
          <ul className="flex flex-col gap-0.5">
            {props.messages.map((match) => {
              if (!match.messageId || !match.digest) return null;
              const ref: KnowledgeMessageRef = {
                kind: "message",
                threadId: match.threadId,
                messageId: match.messageId,
                digest: match.digest,
              };
              const key = messageRowKey(ref);
              return (
                <li key={key}>
                  <button
                    type="button"
                    className={ROW_BUTTON_CLASS}
                    data-memory-row={key}
                    aria-current={props.inspectedKey === key ? "true" : undefined}
                    onClick={() => props.onInspectMessage(ref)}
                  >
                    <span className="line-clamp-3 text-sm">{match.snippet}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {props.children}
    </div>
  );
}
