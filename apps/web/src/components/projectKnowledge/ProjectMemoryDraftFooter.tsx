import type { KnowledgeSelection, ProjectKnowledgePreparedContext } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { Button } from "../ui/button";
import { selectionKey } from "./projectMemoryLabels";

export const MAX_DRAFT_SELECTIONS = 20;

/** The draft's chosen knowledge. Independent of what the inspector shows. */
export function ProjectMemoryDraftFooter(props: {
  readonly selections: ReadonlyArray<KnowledgeSelection>;
  readonly labelFor: (selection: KnowledgeSelection) => string;
  readonly attached: boolean;
  readonly preview: ProjectKnowledgePreparedContext | null;
  readonly busy: boolean;
  readonly onRemove: (selection: KnowledgeSelection) => void;
  readonly onClear: () => void;
  readonly onAttach: () => void;
}) {
  const gt = useGT();
  const count = props.selections.length;
  return (
    <section
      aria-labelledby="project-memory-draft-selection"
      className="flex shrink-0 flex-col gap-2 border-t bg-muted/72 px-4 py-3 sm:rounded-b-2xl sm:px-6"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-col">
          <h3 id="project-memory-draft-selection" className="font-medium text-sm">
            <T>Draft selection</T>
          </h3>
          <p role="status" className="text-muted-foreground text-xs">
            {gt(
              "{count, plural, =0 {Nothing selected} other {{count} selected}}{atLimit, select, yes { (maximum {maximum})} other {}}{attached, select, yes { · attached to draft} other {}}",
              {
                count,
                atLimit: count >= MAX_DRAFT_SELECTIONS ? "yes" : "no",
                maximum: MAX_DRAFT_SELECTIONS,
                attached: props.attached ? "yes" : "no",
              },
            )}
          </p>
        </div>
        {count > 0 ? (
          <ul
            aria-label={gt("Selected for draft")}
            className="flex min-w-0 flex-1 flex-wrap gap-1.5"
          >
            {props.selections.map((selection) => {
              const label = props.labelFor(selection);
              return (
                <li
                  key={selectionKey(selection)}
                  className="flex max-w-56 items-center gap-0.5 rounded-md border bg-background ps-2 text-xs"
                >
                  <span className="truncate">{label}</span>
                  <Button
                    aria-label={gt("Remove {label} from draft selection", { label })}
                    size="icon-micro"
                    variant="ghost"
                    onClick={() => props.onRemove(selection)}
                  >
                    <XIcon />
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="min-w-0 flex-1 text-muted-foreground text-xs">
            <T>Check a fact or select a message to add it. Inspecting does not select.</T>
          </p>
        )}
        <div className="flex gap-2">
          <Button
            disabled={count === 0 && !props.attached}
            size="sm"
            variant="outline"
            onClick={props.onClear}
          >
            <T>Clear selection</T>
          </Button>
          <Button disabled={props.busy || count === 0} size="sm" onClick={props.onAttach}>
            <T>Preview and attach</T>
          </Button>
        </div>
      </div>
      {props.preview ? (
        <div className="flex flex-col gap-2">
          <section
            aria-label={gt("Attached preview")}
            className="max-h-48 overflow-auto rounded-md border bg-background p-2 text-sm"
          >
            {props.preview.items ? (
              <ul className="flex flex-col gap-3">
                {props.preview.items.map((item, index) => (
                  <li
                    key={selectionKey(props.preview!.context.selections[index]!)}
                    className="flex flex-col gap-1"
                  >
                    <h4 className="font-medium">{item.label}</h4>
                    <p className="whitespace-pre-wrap">{item.text}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">
                <T>
                  This server cannot provide a readable preview. Expand the exact payload to review
                  what will be sent.
                </T>
              </p>
            )}
          </section>
          <details>
            <summary className="cursor-pointer text-xs">
              <T>Show exact payload</T>
            </summary>
            <pre
              role="region"
              aria-label={gt("Exact payload")}
              className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-2 text-xs"
            >
              {props.preview.text}
            </pre>
          </details>
        </div>
      ) : null}
    </section>
  );
}
