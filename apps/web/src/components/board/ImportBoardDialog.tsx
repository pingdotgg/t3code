import type {
  EnvironmentApi,
  WorkflowDefinitionEncoded,
  WorkflowLintError,
} from "@t3tools/contracts";
import type { ProjectId } from "@t3tools/contracts";
import { UploadIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { lintErrorKey } from "~/workflow/editorModel";
import { importBoard } from "~/workflow/boardRpc";

export interface ImportBoardDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly api: EnvironmentApi;
  readonly projectId: ProjectId;
  /** Called with the new boardId once the import succeeds and warnings (if any) are dismissed. */
  readonly onSuccess: (boardId: string) => void;
}

/**
 * A dialog that lets the user paste (or upload) a board definition JSON and
 * import it into the given project via boardRpc.importBoard.
 *
 * - Client-side JSON.parse guard: an invalid JSON string never reaches the RPC.
 * - On {ok:false}: lint errors are shown inline (same style as the editor).
 * - On {ok:true, warnings}: warnings surface with a "Go to board" button.
 * - On {ok:true, no warnings}: closes immediately and calls onSuccess.
 */
export function ImportBoardDialog({
  open,
  onOpenChange,
  api,
  projectId,
  onSuccess,
}: ImportBoardDialogProps) {
  const [json, setJson] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [lintErrors, setLintErrors] = useState<ReadonlyArray<WorkflowLintError>>([]);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<ReadonlyArray<string>>([]);
  const [successBoardId, setSuccessBoardId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const clearFeedback = () => {
    setParseError(null);
    setLintErrors([]);
    setRpcError(null);
    setWarnings([]);
    setSuccessBoardId(null);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      // Reset all state when closing
      setJson("");
      clearFeedback();
      setLoading(false);
    }
    onOpenChange(next);
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result;
      if (typeof text === "string") {
        setJson(text);
        clearFeedback();
      }
    };
    reader.readAsText(file);
    // Reset so the same file can be re-selected after a correction
    event.target.value = "";
  };

  const handleImport = async () => {
    clearFeedback();

    // Client-side guard: parse first — no RPC call if invalid JSON.
    // The server performs the real schema validation; the cast here lets the
    // call compile while keeping the client-side guard clean.
    let definition: WorkflowDefinitionEncoded;
    try {
      definition = JSON.parse(json) as WorkflowDefinitionEncoded;
    } catch {
      setParseError("Invalid JSON — fix the syntax and try again.");
      return;
    }

    setLoading(true);
    try {
      const result = await importBoard(api, { projectId, definition });

      if (!result.ok) {
        setLintErrors(result.lintErrors);
        return;
      }

      if (result.warnings.length > 0) {
        // Stay open: show warnings + "Go to board" button
        setSuccessBoardId(result.boardId);
        setWarnings(result.warnings);
        return;
      }

      // Success, no warnings — close immediately.
      handleOpenChange(false);
      onSuccess(result.boardId);
    } catch (cause) {
      setRpcError(cause instanceof Error ? cause.message : "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoToBoard = () => {
    if (!successBoardId) {
      return;
    }
    const boardId = successBoardId;
    handleOpenChange(false);
    onSuccess(boardId);
  };

  const showWarningState = warnings.length > 0 && successBoardId !== null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import board from JSON</DialogTitle>
          <DialogDescription>
            Paste a board definition below or upload a <code>.json</code> file.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          {/* File upload affordance */}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
            >
              <UploadIcon className="size-3.5" />
              Upload file
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={handleFileChange}
            />
            <span className="text-xs text-muted-foreground">or paste JSON below</span>
          </div>

          {/* JSON textarea */}
          <textarea
            className="h-48 w-full resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-64"
            placeholder='{ "name": "My board", "lanes": [ … ] }'
            value={json}
            onChange={(e) => {
              setJson(e.target.value);
              clearFeedback();
            }}
            disabled={loading}
            spellCheck={false}
          />

          {/* JSON parse error */}
          {parseError !== null ? (
            <p className="text-xs text-destructive-foreground" role="alert">
              {parseError}
            </p>
          ) : null}

          {/* Lint errors from the server — dialog stays open for retry */}
          {lintErrors.length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-destructive-foreground">
                The board definition has errors:
              </p>
              <ul className="rounded-md border border-warning/45 bg-warning/8 p-2 text-sm text-warning-foreground">
                {lintErrors.map((err) => (
                  <li key={lintErrorKey(err)}>
                    <span className="font-mono text-xs opacity-70">{err.code}</span>
                    {err.laneKey !== undefined ? (
                      <span className="opacity-70"> · lane {String(err.laneKey)}</span>
                    ) : null}
                    {err.stepKey !== undefined ? (
                      <span className="opacity-70"> / step {String(err.stepKey)}</span>
                    ) : null}
                    {" — "}
                    {err.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Unexpected RPC error */}
          {rpcError !== null ? (
            <p className="text-xs text-destructive-foreground" role="alert">
              {rpcError}
            </p>
          ) : null}

          {/* Warnings after a successful import — offer navigation */}
          {showWarningState ? (
            <div className="rounded-md border border-warning/45 bg-warning/8 p-3 space-y-2">
              <p className="text-sm font-medium text-warning-foreground">
                Board created. These need attention for this environment:
              </p>
              <ul className="list-disc list-inside space-y-0.5 text-sm text-warning-foreground">
                {warnings.map((w, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Standing disclaimer */}
          <p className="text-xs text-muted-foreground">
            Connections (work sources / outbound) and agent instances aren&apos;t imported —
            reconfigure them after importing.
          </p>
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={loading}>
            Cancel
          </Button>

          {showWarningState ? (
            <Button onClick={handleGoToBoard}>Go to board</Button>
          ) : (
            <Button
              onClick={() => void handleImport()}
              disabled={loading || json.trim().length === 0}
            >
              {loading ? "Importing…" : "Import"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
