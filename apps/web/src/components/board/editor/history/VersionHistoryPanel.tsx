import type {
  BoardId,
  EnvironmentApi,
  WorkflowBoardVersionSummary,
  WorkflowDefinitionEncoded,
  WorkflowGetBoardVersionResult,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { formatVersionTime } from "~/workflow/editorModel";

import { DiffView } from "./DiffView";

export interface VersionHistoryPanelProps {
  readonly api: EnvironmentApi;
  readonly boardId: BoardId;
  readonly currentDefinition: WorkflowDefinitionEncoded;
  readonly disabled?: boolean | undefined;
  readonly revertDisabledReason?: string | undefined;
  readonly onClose: () => void;
  readonly onRevert: (version: WorkflowGetBoardVersionResult) => void;
}

export function VersionHistoryPanel({
  api,
  boardId,
  currentDefinition,
  disabled,
  revertDisabledReason,
  onClose,
  onRevert,
}: VersionHistoryPanelProps) {
  const [versions, setVersions] = useState<ReadonlyArray<WorkflowBoardVersionSummary>>([]);
  const [selectedSummary, setSelectedSummary] = useState<WorkflowBoardVersionSummary | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<WorkflowGetBoardVersionResult | null>(
    null,
  );
  const [loadingVersions, setLoadingVersions] = useState(true);
  const [loadingVersionId, setLoadingVersionId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Selecting another version invalidates in-flight loads so a slow older
  // response can never overwrite the newer selection's preview.
  const loadRequestRef = useRef(0);

  const listBoardVersions = api.workflow.listBoardVersions;
  const getBoardVersion = api.workflow.getBoardVersion;
  const revertDisabledHintId = "workflow-version-history-revert-disabled-hint";

  useEffect(() => {
    let active = true;
    setLoadingVersions(true);
    setError(null);
    setSelectedSummary(null);
    setSelectedVersion(null);

    void listBoardVersions({ boardId })
      .then((result) => {
        if (!active) {
          return;
        }
        setVersions(result);
      })
      .catch((cause: unknown) => {
        if (!active) {
          return;
        }
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) {
          setLoadingVersions(false);
        }
      });

    return () => {
      active = false;
    };
  }, [boardId, listBoardVersions]);

  const loadVersion = useCallback(
    async (summary: WorkflowBoardVersionSummary): Promise<WorkflowGetBoardVersionResult | null> => {
      const requestId = ++loadRequestRef.current;
      setError(null);
      setSelectedSummary(summary);
      setSelectedVersion(null);
      setLoadingVersionId(summary.versionId);
      try {
        const version = await getBoardVersion({ boardId, versionId: summary.versionId });
        if (loadRequestRef.current !== requestId) {
          return null;
        }
        setSelectedVersion(version);
        return version;
      } catch (cause: unknown) {
        if (loadRequestRef.current === requestId) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        return null;
      } finally {
        if (loadRequestRef.current === requestId) {
          setLoadingVersionId(null);
        }
      }
    },
    [boardId, getBoardVersion],
  );

  const revertVersion = useCallback(
    async (summary: WorkflowBoardVersionSummary) => {
      if (summary.isCurrent || disabled) {
        return;
      }
      const version =
        selectedVersion?.versionId === summary.versionId
          ? selectedVersion
          : await loadVersion(summary);
      if (version) {
        onRevert(version);
      }
    },
    [disabled, loadVersion, onRevert, selectedVersion],
  );

  return (
    <section
      aria-label="Workflow version history"
      className="border-b border-border bg-muted/15 px-4 py-3"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">Version history</h3>
        <Button size="icon-sm" variant="ghost" aria-label="Close history" onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </div>
      {revertDisabledReason ? (
        <div id={revertDisabledHintId} className="mb-3 text-xs text-muted-foreground">
          {revertDisabledReason}
        </div>
      ) : null}

      {loadingVersions ? (
        <div className="text-sm text-muted-foreground">Loading versions...</div>
      ) : error ? (
        <div className="text-sm text-destructive">{error}</div>
      ) : versions.length === 0 ? (
        <div className="text-sm text-muted-foreground">No versions recorded.</div>
      ) : (
        <div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]">
          <div className="space-y-2">
            {versions.map((version) => (
              <div
                key={version.versionId}
                className="flex items-center gap-2 rounded-md border border-border bg-background p-2"
              >
                <Button
                  type="button"
                  variant={selectedSummary?.versionId === version.versionId ? "secondary" : "ghost"}
                  className="min-w-0 flex-1 justify-start"
                  aria-label={`Version ${version.versionId}${version.isCurrent ? " current" : ""} ${version.source}`}
                  onClick={() => {
                    void loadVersion(version);
                  }}
                >
                  <span className="truncate">
                    v{version.versionId} {version.source}
                    {version.isCurrent ? " current" : ""}
                  </span>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || version.isCurrent || loadingVersionId === version.versionId}
                  title={disabled && revertDisabledReason ? revertDisabledReason : undefined}
                  aria-describedby={
                    disabled && revertDisabledReason ? revertDisabledHintId : undefined
                  }
                  aria-label={`Revert version ${version.versionId}`}
                  onClick={() => {
                    void revertVersion(version);
                  }}
                >
                  Revert
                </Button>
              </div>
            ))}
          </div>

          <div className="min-w-0">
            {selectedSummary ? (
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>v{selectedSummary.versionId}</span>
                <span>{selectedSummary.source}</span>
                <time dateTime={selectedSummary.createdAt}>
                  {formatVersionTime(selectedSummary.createdAt)}
                </time>
              </div>
            ) : null}
            {loadingVersionId ? (
              <div className="text-sm text-muted-foreground">Loading version...</div>
            ) : selectedVersion ? (
              <DiffView
                currentDefinition={currentDefinition}
                versionDefinition={selectedVersion.definition}
              />
            ) : (
              <div className="rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
                Select a version to preview changes.
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
