/**
 * Rendered above the scroll area whenever an operation is in progress, so a
 * blocked merge/rebase cannot be scrolled past.
 *
 * Detect and surface, do NOT automate: for anything other than a merge the
 * panel tells the user to run `git <op> --continue` in the terminal — which t3
 * has inline — rather than driving it through a non-interactive subprocess.
 *
 * fork: f4 source-control panel
 */
import type { WorkingCopyFile, WorkingCopyOperation } from "@t3tools/contracts";
import { AlertTriangle } from "lucide-react";

import { Button } from "~/components/ui/button";

import { operationGuidance, splitDisplayPath } from "./sourceControlPanel.logic";

export function ConflictsSection(props: {
  readonly operation: WorkingCopyOperation;
  readonly files: ReadonlyArray<WorkingCopyFile>;
  readonly busy: boolean;
  /** fork: f4 F-06 — per-path resolve in flight. */
  readonly busyPaths: ReadonlySet<string>;
  readonly abortBusy: boolean;
  /**
   * fork: f4 F-11 — "Commit merge" commits the composer's draft, which is
   * usually empty at this point. It used to fire anyway and hand the user a red
   * git stderr toast with no clue that the box above was the input.
   */
  readonly hasMessage: boolean;
  readonly onResolve: (path: string, side?: "ours" | "theirs") => void;
  readonly onOpen: (file: WorkingCopyFile) => void;
  readonly onAbort: () => void;
  readonly onContinue: () => void;
}) {
  const guidance = operationGuidance(props.operation);
  const remaining = props.files.length;
  const continueBlockedReason =
    remaining > 0
      ? `${remaining} file${remaining === 1 ? " is" : "s are"} still conflicted`
      : !props.hasMessage
        ? "Write a commit message in the box above"
        : props.busy
          ? "Another action is still running"
          : null;

  return (
    <section
      className="flex-none border-border/60 border-b bg-amber-500/5"
      aria-label={guidance.title}
    >
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
        <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
        <span className="font-medium">{guidance.title}</span>
        <span className="text-muted-foreground">
          {remaining === 0
            ? "all conflicts resolved"
            : `${remaining} file${remaining === 1 ? "" : "s"} still conflicted`}
        </span>
      </div>
      <ul className="max-h-40 overflow-auto">
        {props.files.map((file) => {
          const { name, dir } = splitDisplayPath(file.path);
          return (
            <li
              key={file.path}
              className="group flex h-8 items-center gap-2 px-2 text-sm hover:bg-accent/50"
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                onClick={() => props.onOpen(file)}
              >
                {name}
                {dir ? <span className="ml-1.5 text-muted-foreground text-xs">{dir}</span> : null}
              </button>
              <span className="hidden shrink-0 items-center gap-1 text-xs group-hover:flex">
                <ResolveButton
                  busy={props.busyPaths.has(file.path)}
                  onClick={() => props.onResolve(file.path, "ours")}
                >
                  Ours
                </ResolveButton>
                <ResolveButton
                  busy={props.busyPaths.has(file.path)}
                  onClick={() => props.onResolve(file.path, "theirs")}
                >
                  Theirs
                </ResolveButton>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Button
          size="xs"
          variant="destructive-outline"
          disabled={props.abortBusy}
          onClick={props.onAbort}
        >
          {props.abortBusy ? "Aborting…" : `Abort ${props.operation}`}
        </Button>
        {guidance.canContinueInPanel ? (
          <span className="ml-auto flex items-center gap-2">
            {continueBlockedReason ? (
              <span className="text-[11px] text-muted-foreground">{continueBlockedReason}</span>
            ) : null}
            <Button
              size="xs"
              disabled={continueBlockedReason !== null}
              title={continueBlockedReason ?? guidance.continueLabel}
              onClick={props.onContinue}
            >
              {guidance.continueLabel}
            </Button>
          </span>
        ) : (
          <p className="ml-auto max-w-64 text-right text-[11px] text-muted-foreground leading-snug">
            {guidance.terminalHint}
          </p>
        )}
      </div>
    </section>
  );
}

function ResolveButton(props: { busy: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="rounded-sm border border-border px-1.5 py-0.5 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      disabled={props.busy}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
