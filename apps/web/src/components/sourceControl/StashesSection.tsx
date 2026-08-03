/**
 * Stashes + the panel's own discard backups, collapsed at the bottom of the
 * Changes tab.
 *
 * Load-on-expand, never polled: a stash list costs a subprocess and nothing
 * about it changes while the section is shut.
 *
 * The "Recent backups" group is what makes discard undoable after the toast has
 * gone — it is the same `stash@{n}` list filtered to the fork's own prefixed
 * entries (`isDiscardBackup`).
 *
 * fork: f4 source-control panel
 */
import type { WorkingCopyStashEntry } from "@t3tools/contracts";
import { Archive, ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "~/components/ui/button";

export function StashesSection(props: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly stashes: ReadonlyArray<WorkingCopyStashEntry>;
  readonly backups: ReadonlyArray<WorkingCopyStashEntry>;
  readonly isLoading: boolean;
  readonly dirty: boolean;
  readonly onStash: () => void;
  readonly onPopLatest: () => void;
  readonly onApply: (ref: string) => void;
  readonly onDrop: (ref: string, label: string) => void;
  readonly onRestoreBackup: (ref: string) => void;
}) {
  const plainStashes = props.stashes.filter((entry) => !entry.isDiscardBackup);

  return (
    <section className="flex-none border-border/60 border-t" aria-label="Stashes">
      <div className="flex h-8 items-center gap-1.5 px-2 text-xs">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left font-medium text-muted-foreground uppercase tracking-wide"
          onClick={props.onToggle}
          aria-expanded={props.open}
        >
          {props.open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <Archive className="size-3" />
          Stashes
          <span className="text-muted-foreground/70">{plainStashes.length}</span>
        </button>
        {props.open ? (
          <span className="flex shrink-0 items-center gap-1">
            <Button size="xs" variant="ghost" disabled={!props.dirty} onClick={props.onStash}>
              Stash…
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={plainStashes.length === 0}
              onClick={props.onPopLatest}
            >
              Pop
            </Button>
          </span>
        ) : null}
      </div>
      {props.open ? (
        <div className="max-h-56 overflow-auto pb-1">
          {props.isLoading ? (
            <p className="px-3 py-2 text-muted-foreground text-xs">Loading…</p>
          ) : null}
          {plainStashes.map((stash) => (
            <StashRow
              key={stash.ref}
              label={stash.label}
              createdAt={stash.createdAt}
              actions={
                <>
                  <RowButton onClick={() => props.onApply(stash.ref)}>Apply</RowButton>
                  <RowButton onClick={() => props.onDrop(stash.ref, stash.label)} danger>
                    Drop
                  </RowButton>
                </>
              }
            />
          ))}
          {props.backups.length > 0 ? (
            <>
              <p className="px-3 pt-2 pb-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
                Recent backups
              </p>
              {props.backups.map((backup) => (
                <StashRow
                  key={backup.ref}
                  label={backup.label}
                  createdAt={backup.createdAt}
                  actions={
                    <RowButton onClick={() => props.onRestoreBackup(backup.ref)}>Restore</RowButton>
                  }
                />
              ))}
            </>
          ) : null}
          {!props.isLoading && plainStashes.length === 0 && props.backups.length === 0 ? (
            <p className="px-3 py-2 text-muted-foreground text-xs">No stashes.</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function StashRow(props: { label: string; createdAt: string; actions: React.ReactNode }) {
  return (
    <div className="group flex h-8 items-center gap-2 px-3 text-sm hover:bg-accent/50">
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      <time className="shrink-0 text-muted-foreground text-xs group-hover:hidden">
        {relativeDate(props.createdAt)}
      </time>
      <span className="hidden shrink-0 items-center gap-1 text-xs group-hover:flex">
        {props.actions}
      </span>
    </div>
  );
}

function RowButton(props: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className={
        props.danger
          ? "rounded-sm border border-border px-1.5 py-0.5 text-destructive-foreground hover:bg-destructive/10"
          : "rounded-sm border border-border px-1.5 py-0.5 hover:bg-accent"
      }
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function relativeDate(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
