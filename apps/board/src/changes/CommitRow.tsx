import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import { filesViewAtom } from "../state/filesView";
import { ago } from "../ui/ago";
import { CommitFiles } from "./CommitFiles";

/** One commit of the branch: its subject, and when opened its date and changed files, as Orca's commit rows open. */
export function CommitRow({
  environmentId,
  cwd,
  commit,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  commit: { readonly sha: string; readonly subject: string; readonly committedAt: string };
}) {
  const [open, setOpen] = useState(false);
  const { active } = useAtomValue(filesViewAtom);
  const Chevron = open ? ChevronDown : ChevronRight;
  const shown =
    active?.diff?.kind === "commit" && active.diff.sha === commit.sha && active.cwd === cwd;
  return (
    <div data-testid="commit-row" data-sha={commit.sha}>
      <button
        type="button"
        aria-expanded={open}
        aria-current={shown}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-sm px-2 py-[3px] text-left text-[12px] hover:bg-hover"
      >
        <Chevron className="size-3.5 shrink-0 text-faint" aria-hidden />
        <span className="shrink-0 font-mono text-[11px] text-faint">{commit.sha.slice(0, 7)}</span>
        <span className="min-w-0 flex-1 truncate text-fg">{commit.subject}</span>
        <span className="shrink-0 text-[11px] text-faint">{ago(commit.committedAt)}</span>
      </button>
      {open && (
        <CommitFiles
          environmentId={environmentId}
          cwd={cwd}
          sha={commit.sha}
          committedAt={commit.committedAt}
        />
      )}
    </div>
  );
}
