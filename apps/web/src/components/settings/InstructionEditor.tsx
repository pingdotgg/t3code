import { INSTRUCTION_MAX_CHARS, type EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { FileSaveCoordinator } from "../files/fileSaveCoordinator";
import { instructionErrorReason, isSaveConflict } from "./InstructionsSettings.logic";
import { SkillMarkdown } from "./SkillMarkdown";

/** The same wait the files panel gives an edit before it saves. */
const AUTOSAVE_DEBOUNCE_MS = 500;
/** The editor and the preview share one height, so the page doesn't jump between them. */
const PANE_HEIGHT = "h-[26rem]";

type SaveStatus = "idle" | "saving" | "saved" | "failed" | "conflict";

export type InstructionText = {
  readonly contents: string;
  /** Null when the file isn't there yet. */
  readonly revision: string | null;
};

/**
 * Saves edits as they are made. Each save says which version of the file it was made from, so a
 * file that changed on disk is never overwritten: the save is refused, saving stops, and the
 * person picks which version to keep.
 */
function useInstructionAutosave({
  environmentId,
  cwd,
  id,
  initial,
  resave,
  onSaved,
}: {
  environmentId: EnvironmentId;
  cwd: string | null;
  id: string;
  initial: InstructionText;
  /** The text should be saved as soon as the editor opens. */
  resave: boolean;
  /** A save went through; the list can read the file again. */
  onSaved: () => void;
}) {
  const write = useAtomCommand(serverEnvironment.writeInstruction, { reportFailure: false });
  const [status, setStatus] = useState<SaveStatus>("idle");
  // What the editor opened with. Later saves build on the version the last one made.
  const start = useRef({ ...initial, resave });
  const revision = useRef(initial.revision);
  const latest = useRef(initial.contents);
  const coordinator = useRef<FileSaveCoordinator | null>(null);
  const notifySaved = useEffectEvent(onSaved);

  useEffect(() => {
    // Set once the file turns out to have changed: nothing more is sent until a person decides.
    let refused: Awaited<ReturnType<typeof write>> | null = null;
    const current = new FileSaveCoordinator({
      debounceMs: AUTOSAVE_DEBOUNCE_MS,
      onPendingChange: (pending) => {
        if (!refused) setStatus(pending ? "saving" : "saved");
      },
      onConfirmed: () => undefined,
      persist: async (contents) => {
        if (refused) return refused;
        const result = await write({
          environmentId,
          input: {
            ...(cwd ? { cwd } : {}),
            id,
            contents,
            expectedRevision: revision.current,
          },
        });
        if (result._tag === "Success") {
          revision.current = result.value.revision;
          notifySaved();
        } else if (isSaveConflict(instructionErrorReason(squashAtomCommandFailure(result)))) {
          refused = result;
          setStatus("conflict");
        } else if (!isAtomCommandInterrupted(result)) {
          setStatus("failed");
        }
        return result;
      },
    });
    coordinator.current = current;
    if (start.current.resave) {
      start.current.resave = false;
      current.change(start.current.contents);
    }
    return () => {
      coordinator.current = null;
      // Whatever is still waiting goes out now, unless the file changed under it.
      current.dispose();
    };
  }, [write, environmentId, cwd, id]);

  return {
    status,
    change: (contents: string) => {
      latest.current = contents;
      coordinator.current?.change(contents);
    },
    retry: () => coordinator.current?.change(latest.current),
  };
}

/**
 * The file's text, edited in place and saved as it changes, or just read. The Edit / Preview
 * choice lives in the page's header, so `mode` comes from there.
 */
export function InstructionEditor({
  environmentId,
  cwd,
  id,
  fileName,
  initial,
  canEdit,
  mode,
  creating,
  resave,
  onSaved,
  onResolve,
}: {
  environmentId: EnvironmentId;
  cwd: string | null;
  id: string;
  fileName: string;
  initial: InstructionText;
  /** Reading is all there is: a managed file, or a session that can't change things. */
  canEdit: boolean;
  mode: "edit" | "preview";
  /** The file doesn't exist yet; the first edit creates it. */
  creating: boolean;
  /** The text came from a choice to keep it over the file, so it is saved at once. */
  resave: boolean;
  onSaved: () => void;
  /**
   * The file changed on disk and the person chose: the file as it is now (`reload`), or this text
   * over it (`keep`). The editor opens again from the result; false when the file couldn't be read.
   */
  onResolve: (choice: "reload" | "keep", mine: string) => Promise<boolean>;
}) {
  const [text, setText] = useState(initial.contents);
  const autosave = useInstructionAutosave({ environmentId, cwd, id, initial, resave, onSaved });
  const [resolving, setResolving] = useState(false);
  const [resolveFailed, setResolveFailed] = useState(false);
  const resolve = async (choice: "reload" | "keep") => {
    setResolving(true);
    setResolveFailed(false);
    // Success opens a fresh editor in this one's place.
    if (!(await onResolve(choice, text))) {
      setResolving(false);
      setResolveFailed(true);
    }
  };
  const editing = canEdit && mode === "edit";

  return (
    <div className="min-w-0 space-y-2.5">
      {autosave.status === "conflict" && (
        <Alert variant="warning">
          <AlertTitle>Changed outside T3 Code</AlertTitle>
          {resolveFailed && <AlertDescription>Couldn't read the file. Try again.</AlertDescription>}
          <AlertAction className="flex-wrap">
            <Button
              size="xs"
              variant="outline"
              disabled={resolving}
              onClick={() => void resolve("reload")}
            >
              Reload
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={resolving}
              onClick={() => void resolve("keep")}
            >
              Keep mine
            </Button>
          </AlertAction>
        </Alert>
      )}

      <div className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card/40">
        {editing ? (
          // An editor surface, not a form field: it needs a fixed, taller pane and a monospace
          // face, which the Textarea control doesn't offer.
          <textarea
            aria-label={`Edit ${fileName}`}
            value={text}
            maxLength={INSTRUCTION_MAX_CHARS}
            spellCheck={false}
            placeholder={creating ? "Write the instructions your agents should follow." : undefined}
            className={`block ${PANE_HEIGHT} w-full resize-none bg-transparent p-3 font-mono text-xs leading-5 outline-none placeholder:text-muted-foreground`}
            onChange={(event) => {
              setText(event.target.value);
              autosave.change(event.target.value);
            }}
          />
        ) : (
          <div className={`${PANE_HEIGHT} overflow-y-auto px-4 py-3 text-sm break-words`}>
            {text.trim() === "" ? (
              <p className="text-muted-foreground">Nothing here yet.</p>
            ) : (
              <SkillMarkdown text={text} />
            )}
          </div>
        )}

        <div className="flex min-h-8 items-center justify-end gap-2 border-t border-border/60 px-3 py-1 text-xs text-muted-foreground">
          {!canEdit && <span>Read-only</span>}
          {canEdit && autosave.status === "saving" && <span role="status">Saving…</span>}
          {canEdit &&
            (autosave.status === "saved" || (autosave.status === "idle" && !creating)) && (
              <span role="status">Saved</span>
            )}
          {autosave.status === "failed" && (
            <>
              <span role="alert" className="text-warning-foreground">
                Couldn't save. Your changes are still here.
              </span>
              <Button size="xs" variant="ghost-muted" onClick={autosave.retry}>
                Try again
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
