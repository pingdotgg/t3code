import { TicketId, type EnvironmentApi, type WorkflowTicketArtifact } from "@t3tools/contracts";
import { useState } from "react";

/**
 * The ticket's case file: scratch documents the pipeline wrote under
 * .t3/ticket/<id>/ (PLAN.md, SPEC.md, REVIEW.md, ...), loaded lazily when
 * the section is opened.
 */
export function TicketArtifacts({
  api,
  ticketId,
}: {
  readonly api: EnvironmentApi | null | undefined;
  readonly ticketId: string;
}) {
  const [artifacts, setArtifacts] = useState<ReadonlyArray<WorkflowTicketArtifact> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!api || loading || artifacts !== null) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.workflow.listTicketArtifacts({
        ticketId: TicketId.make(ticketId),
      });
      setArtifacts(result.artifacts);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load artifacts.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="rounded-md border border-border/70 bg-card/35 p-3">
      <details
        onToggle={(event) => {
          if ((event.currentTarget as HTMLDetailsElement).open) {
            void load();
          }
        }}
      >
        <summary className="cursor-pointer text-sm font-medium text-foreground select-none">
          Artifacts
          {artifacts !== null ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {artifacts.length}
            </span>
          ) : null}
        </summary>
        <div className="mt-2 space-y-2" data-testid="ticket-artifacts">
          {loading ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
          {error !== null ? (
            <p className="text-xs text-destructive-foreground" role="alert">
              {error}
            </p>
          ) : null}
          {artifacts !== null && artifacts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No artifacts yet — pipeline steps write plans and reviews here.
            </p>
          ) : null}
          {(artifacts ?? []).map((artifact) => (
            <details
              key={artifact.name}
              className="rounded-md border border-border/60 bg-background/70"
            >
              <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium text-foreground select-none">
                {artifact.name}
                {artifact.truncated === true ? (
                  <span className="ml-2 font-normal text-muted-foreground">(truncated)</span>
                ) : null}
              </summary>
              <pre className="max-h-72 overflow-auto border-t border-border/60 p-2 text-[11px] leading-4 whitespace-pre-wrap text-muted-foreground">
                {artifact.content}
              </pre>
            </details>
          ))}
        </div>
      </details>
    </section>
  );
}
