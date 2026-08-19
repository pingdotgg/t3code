import type { ThreadHandoff } from "@t3tools/contracts";

export function ThreadHandoffCard(props: {
  readonly handoff: ThreadHandoff;
  readonly busy?: boolean;
  readonly onOpen: () => void;
  readonly onDismiss: () => void;
}) {
  const { handoff, busy = false, onOpen, onDismiss } = props;
  return (
    <section
      aria-label={`Thread handoff: ${handoff.title}`}
      className="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-muted/35 px-3 py-2 text-sm sm:mx-4"
    >
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground">
          Ready to continue in <span className="font-medium text-foreground">{handoff.title}</span>.
        </p>
        {handoff.artifactReferences.length > 0 ? (
          <p className="truncate text-xs text-muted-foreground">
            {handoff.artifactReferences.join(" · ")}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={onOpen}
        className="rounded-md bg-primary px-2.5 py-1.5 font-medium text-primary-foreground disabled:opacity-50"
      >
        Open {handoff.title} thread
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onDismiss}
        className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted disabled:opacity-50"
      >
        Dismiss
      </button>
    </section>
  );
}
