import { RegistryContext } from "@effect/atom-react";
import { useContext, useState } from "react";

import { readArtifact } from "../state/artifacts";
import { writeText } from "../state/files";
import { FileConflict } from "./FileConflict";
import { buttonClass } from "./fileActions";
import {
  editSession,
  isDirty,
  keepMine,
  openSession,
  save,
  type SaveSession,
  saved,
  takeTheirs,
} from "./saveSession";
import { absolutePathOf, type FileTarget } from "./target";
import { tellOrchestrator } from "./tellOrchestrator";

// Two frames: the first commits the editor, the second runs after it has been painted. A stable
// function, so a re-render does not run it again.
function markPainted(node: HTMLElement | null) {
  if (node === null) return;
  const frame = requestAnimationFrame(() =>
    requestAnimationFrame(() => performance.mark("board:editor-painted")),
  );
  return () => cancelAnimationFrame(frame);
}

/**
 * A text file as an editor. Save writes only over the contents the editor opened. A disk that
 * changed since then shows the conflict, and neither side is overwritten until one is chosen.
 */
export function FileEditor({
  target,
  initial,
  onClose,
  onDirtyChange,
}: {
  target: FileTarget;
  /** The contents the editor opens with, which are what the preview read. */
  initial: string;
  onClose: () => void;
  /** Says whether the editor holds edits that are not on disk. */
  onDirtyChange: (dirty: boolean) => void;
}) {
  const registry = useContext(RegistryContext);
  const [session, setSession] = useState(() => openSession(initial));
  const [conflicted, setConflicted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [told, setTold] = useState<"idle" | "sent">("idle");
  const [tellFailure, setTellFailure] = useState<string | null>(null);
  const [wrote, setWrote] = useState(false);
  const dirty = isDirty(session);
  const update = (next: SaveSession) => {
    setSession(next);
    onDirtyChange(isDirty(next));
  };

  const write = async (contents: string) => {
    await writeText(registry, target.environmentId, target.cwd, target.path, contents);
    update(saved(contents));
    setConflicted(false);
    setWrote(true);
    setTold("idle");
    setTellFailure(null);
  };

  const attempt = async (work: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await work();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onSave = () =>
    attempt(async () => {
      const disk = await readArtifact(registry, target.environmentId, target.cwd, target.path);
      if (disk.kind === "binary") throw new Error("The file on disk is now binary.");
      if (disk.kind === "text" && disk.truncated) {
        throw new Error(
          "The file on disk grew too large to compare. Close the editor and reload it.",
        );
      }
      // A file that is gone compares as empty, so recreating it is a choice the conflict asks for.
      const step = save(session, disk.kind === "text" ? disk.contents : "");
      if (step.kind === "write") await write(step.contents);
      else {
        update(step.session);
        setConflicted(true);
      }
    });

  const onTell = async () => {
    const result = await tellOrchestrator(
      registry,
      target.environmentId,
      target.orchestratorThreadId,
      absolutePathOf(target),
    );
    setTold(result === null ? "sent" : "idle");
    setTellFailure(result);
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
          {target.path}
        </span>
        <span role="status" className="shrink-0 text-[11px] text-muted">
          {dirty ? "Unsaved changes" : wrote ? "Saved" : ""}
        </span>
        <button
          type="button"
          disabled={busy || !dirty || conflicted}
          onClick={() => void onSave()}
          className={buttonClass}
        >
          Save
        </button>
        <button type="button" disabled={busy} onClick={onClose} className={buttonClass}>
          {dirty ? "Discard" : "Done"}
        </button>
      </div>
      {failure !== null && (
        <p role="alert" data-testid="save-error" className="px-3 py-2 text-[12px] text-red-300">
          {failure}
        </p>
      )}
      {wrote && !dirty && target.tellable && (
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[12px]">
          {told === "sent" ? (
            <span role="status">The orchestrator was told.</span>
          ) : (
            <button type="button" onClick={() => void onTell()} className={buttonClass}>
              Tell the orchestrator
            </button>
          )}
          {tellFailure !== null && (
            <span role="alert" className="text-red-300">
              {tellFailure}
            </span>
          )}
        </div>
      )}
      {conflicted ? (
        <FileConflict
          session={session}
          busy={busy}
          onKeepMine={() => void attempt(() => write(keepMine(session).contents))}
          onTakeTheirs={() => {
            update(takeTheirs(session));
            setConflicted(false);
            setFailure(null);
          }}
        />
      ) : (
        <textarea
          ref={markPainted}
          aria-label={`Edit ${target.path}`}
          data-testid="file-editor"
          spellCheck={false}
          value={session.edits}
          onChange={(event) => update(editSession(session, event.target.value))}
          className="min-h-0 flex-1 resize-none bg-bg p-3 font-mono text-[12px] leading-5 text-fg outline-none"
        />
      )}
    </>
  );
}
