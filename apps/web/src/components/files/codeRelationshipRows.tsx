import type { ProjectCodeCoverage, ProjectCodeEdge } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export const GRADE_RANK: Record<ProjectCodeEdge["evidenceGrade"], number> = {
  "compiler-indexed": 0,
  "static-candidate": 1,
  "heuristic-candidate": 2,
};
export const GRADE_LABEL: Record<ProjectCodeEdge["evidenceGrade"], string> = {
  "compiler-indexed": "compiler indexed",
  "static-candidate": "static candidate",
  "heuristic-candidate": "heuristic",
};

// Only languages seen in this checkout; `languages` is the analyzer's catalog.
function indexedLanguagesSuffix(coverage: ProjectCodeCoverage): string {
  return coverage.indexedLanguages?.length ? ` (${coverage.indexedLanguages.join(", ")})` : "";
}

function coverageSummary(coverage: ProjectCodeCoverage): string {
  switch (coverage.state) {
    case "complete":
      return `Static candidates · ${coverage.filesIndexed} files indexed${indexedLanguagesSuffix(coverage)}`;
    case "partial":
      return `Static candidates · partial coverage, ${coverage.filesIndexed} of ${coverage.filesListed} files indexed${indexedLanguagesSuffix(coverage)}`;
    case "stale":
      return "Stale · some returned files changed since indexing. Verify in source.";
    case "unavailable":
      return "The code index is not ready for this checkout.";
  }
}

export function CoverageNote(props: { readonly coverage: ProjectCodeCoverage }) {
  const { coverage } = props;
  const warn = coverage.state === "stale" || coverage.state === "unavailable";
  return (
    <details className="px-2 text-2xs text-muted-foreground">
      <summary className={cn("cursor-pointer select-none", warn && "text-warning-foreground")}>
        {coverageSummary(coverage)}
      </summary>
      <ul className="mt-1 flex list-disc flex-col gap-0.5 ps-4">
        {coverage.limitations.map((limitation) => (
          <li key={limitation}>{limitation}</li>
        ))}
      </ul>
    </details>
  );
}

export function LocationRow(props: {
  readonly label: string;
  readonly location: string;
  readonly detail: string | null;
  readonly pressed?: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      onClick={props.onOpen}
      className={cn(
        "flex w-full min-w-0 items-baseline gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        props.pressed && "bg-accent",
      )}
    >
      <span className="min-w-0 truncate font-mono text-foreground">{props.label}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{props.location}</span>
      {props.detail ? (
        <span className="shrink-0 text-2xs text-muted-foreground">{props.detail}</span>
      ) : null}
    </button>
  );
}

export function QueryState(props: {
  readonly pending: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly pendingLabel?: string;
}) {
  if (props.error !== null) {
    return (
      <div role="alert" className="flex items-center gap-2 px-2 py-1 text-xs text-destructive">
        <span className="min-w-0 flex-1">{props.error}</span>
        <Button variant="ghost-muted" size="micro" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (props.pending) {
    return (
      <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
        {props.pendingLabel ?? "Indexing… the first query on a checkout can take a while."}
      </p>
    );
  }
  return null;
}

export function EmptyNote(props: { readonly children: string }) {
  return <p className="px-2 py-1 text-xs text-muted-foreground">{props.children}</p>;
}
