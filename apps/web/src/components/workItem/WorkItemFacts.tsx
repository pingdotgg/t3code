import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface WorkItemFact {
  /** The fact's name in words, such as "Labels". */
  readonly name: string;
  /** What is set, in order. */
  readonly values: ReadonlyArray<{ readonly key: string; readonly node: ReactNode }>;
  /** People sit further apart than chips, so a name does not read as the next avatar's. */
  readonly people?: boolean;
  /** The picker: worded on its own while nothing is set, after the values otherwise. */
  readonly control?: ReactNode;
  /** Said when nothing is set and there is no control, such as "No labels". */
  readonly emptyText: ReactNode;
}

/**
 * An issue's or pull request's facts under its description, as one paragraph of name and value
 * pairs. A fact breaks onto a new line whole, and never between its name and first value.
 */
export function WorkItemFacts({ facts }: { facts: ReadonlyArray<WorkItemFact | null> }) {
  const shown = facts.filter((fact) => fact !== null);
  if (shown.length === 0) return null;
  return (
    // The gap between facts only falls between two facts on one line, so it never indents a line.
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-0.5 text-meta">
      {shown.map((fact) => {
        const [first, ...rest] = fact.values;
        if (first === undefined) {
          return fact.control ? (
            // The worded control lines its icon up with the text around it.
            <span key={fact.name} className="-ml-1.75 flex min-h-6 items-center">
              {fact.control}
            </span>
          ) : (
            <span key={fact.name} className="flex min-h-6 items-center text-muted-foreground">
              {fact.emptyText}
            </span>
          );
        }
        const items = [
          {
            key: first.key,
            node: (
              <>
                <span className="shrink-0 text-muted-foreground">{fact.name}</span>
                {first.node}
              </>
            ),
          },
          ...rest,
          ...(fact.control ? [{ key: "control", node: fact.control }] : []),
        ];
        // Each fact wraps as a unit: it moves to a new line whole, and only splits when wider than one.
        return (
          <span
            key={fact.name}
            className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1 gap-y-0.5"
          >
            {items.map((item, itemIndex) => (
              <span
                key={item.key}
                className={cn(
                  "flex min-h-6 min-w-0 items-center gap-1.5",
                  fact.people && item.key !== "control" && itemIndex < items.length - 1 && "mr-1.5",
                )}
              >
                {item.node}
              </span>
            ))}
          </span>
        );
      })}
    </div>
  );
}
