import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AGENT_SESSION_TRANSCRIPT_MAX_CHARS,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FileTextIcon } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { create } from "zustand";

import { agentSessionTranscriptImport } from "../state/agentSessions";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { toastManager } from "./ui/toast";

interface TranscriptImportTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectName: string;
}

const useTarget = create<{ target: TranscriptImportTarget | null }>(() => ({ target: null }));

export function requestTranscriptImport(target: TranscriptImportTarget) {
  useTarget.setState({ target });
}

export function TranscriptImportDialogHost() {
  const target = useTarget((state) => state.target);
  return target ? <TranscriptImportDialog target={target} /> : null;
}

function TranscriptImportDialog({ target }: { readonly target: TranscriptImportTarget }) {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const importTranscript = useAtomCommand(agentSessionTranscriptImport, { reportFailure: false });

  const importFile = async (file: File | undefined) => {
    if (file === undefined || importing) return;
    // UTF-8 never uses fewer bytes than characters, so this bounds the decoded text too.
    if (file.size > AGENT_SESSION_TRANSCRIPT_MAX_CHARS) {
      setError("This file is larger than 8 MiB.");
      return;
    }
    setError(null);
    setImporting(true);
    const result = await importTranscript({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, contents: await file.text() },
    });
    setImporting(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Conversation imported",
        description: `${result.value.messageCount} messages in ${target.projectName}.`,
      });
      if (useTarget.getState().target !== target) return;
      useTarget.setState({ target: null });
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(target.environmentId, result.value.threadId)),
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "The import failed.");
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropTarget(false);
    void importFile(event.dataTransfer.files[0]);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) useTarget.setState({ target: null });
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import Claude Code conversation</DialogTitle>
          <DialogDescription>
            Choose a .txt file saved with <code>/export</code>. It opens as a new thread in{" "}
            {target.projectName}, and your next message gives the agent its history.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div
            className={`flex flex-col items-center gap-3 rounded-lg border border-dashed p-6 text-center ${dropTarget ? "border-primary bg-accent" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setDropTarget(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDropTarget(true);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setDropTarget(false);
            }}
            onDrop={onDrop}
          >
            <FileTextIcon className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Drop the exported file here, or</p>
            <input
              ref={fileInputRef}
              accept=".txt,text/plain"
              className="sr-only"
              type="file"
              onChange={(event) => {
                void importFile(event.currentTarget.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
            <Button
              disabled={importing}
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              {importing ? "Importing…" : "Choose file"}
            </Button>
          </div>
          {error === null ? null : <p className="mt-3 text-sm text-destructive">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => useTarget.setState({ target: null })}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
