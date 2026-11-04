const BAR_WIDTHS = ["h-4 w-2/5", "h-3 w-3/5", "h-3 w-1/2"];

/**
 * Shown while a pull request panel's code loads. It stays this small because the registry
 * imports it eagerly; the panel's own ghosts take over once its code has arrived.
 */
export function PullRequestPanelPending({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="motion-safe:animate-skeleton space-y-2 p-4">
      {BAR_WIDTHS.map((width) => (
        <div key={width} aria-hidden className={`${width} rounded bg-muted-foreground/15`} />
      ))}
    </div>
  );
}
