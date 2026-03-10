import type { ProjectDotenvSyncConfig } from "@t3tools/contracts";
import { normalizeDotenvSyncPath, normalizeDotenvSyncPaths } from "@t3tools/shared/dotenvSync";
import { SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

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
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface ProjectDotenvSyncDialogProps {
  open: boolean;
  dotenvSync: ProjectDotenvSyncConfig | null;
  activeWorktreePath: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (dotenvSync: ProjectDotenvSyncConfig | null) => Promise<void> | void;
  onRunSync: () => Promise<void> | void;
  onDetectPaths: () => Promise<string[]> | string[];
}

export default function ProjectDotenvSyncDialog({
  open,
  dotenvSync,
  activeWorktreePath,
  onOpenChange,
  onSave,
  onRunSync,
  onDetectPaths,
}: ProjectDotenvSyncDialogProps) {
  const [paths, setPaths] = useState<string[]>(() => [...(dotenvSync?.paths ?? [])]);
  const [newPath, setNewPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setPaths([...(dotenvSync?.paths ?? [])]);
    setNewPath("");
    setError(null);
    setNotice(null);
  }, [dotenvSync, open]);

  const hasSavedPaths = (dotenvSync?.paths.length ?? 0) > 0;
  const canRunSync = Boolean(activeWorktreePath) && hasSavedPaths && !isSaving && !isSyncing;
  const isDirty = useMemo(() => {
    const current = dotenvSync?.paths ?? [];
    if (current.length !== paths.length) {
      return true;
    }
    return current.some((path, index) => path !== paths[index]);
  }, [dotenvSync, paths]);

  const mergePaths = useCallback(
    (candidates: Iterable<string>, duplicateMode: "ignore" | "reject") => {
      const nextPaths = [...paths];
      const seen = new Set(nextPaths);

      for (const candidate of candidates) {
        const result = normalizeDotenvSyncPath(candidate);
        if (!result.normalizedPath) {
          return { nextPaths: null, addedCount: 0, error: result.error ?? "Invalid dotenv path." };
        }
        if (seen.has(result.normalizedPath)) {
          if (duplicateMode === "reject") {
            return {
              nextPaths: null,
              addedCount: 0,
              error: `Dotenv path already added: ${result.normalizedPath}`,
            };
          }
          continue;
        }
        seen.add(result.normalizedPath);
        nextPaths.push(result.normalizedPath);
      }

      const validated = normalizeDotenvSyncPaths(nextPaths);
      if (validated.error) {
        return { nextPaths: null, addedCount: 0, error: validated.error };
      }

      return {
        nextPaths: validated.normalizedPaths,
        addedCount: validated.normalizedPaths.length - paths.length,
        error: null,
      };
    },
    [paths],
  );

  const addPath = () => {
    const result = mergePaths([newPath], "reject");
    if (!result.nextPaths) {
      setError(result.error);
      setNotice(null);
      return;
    }
    setPaths(result.nextPaths);
    setNewPath("");
    setError(null);
    setNotice(null);
  };

  const detectPaths = async () => {
    setIsDetecting(true);
    setError(null);
    setNotice(null);
    try {
      const detectedPaths = await onDetectPaths();
      const result = mergePaths(detectedPaths, "ignore");
      if (!result.nextPaths) {
        setError(result.error);
        return;
      }
      setPaths(result.nextPaths);
      setNotice(
        result.addedCount > 0
          ? result.addedCount === 1
            ? "Added 1 detected dotenv file."
            : `Added ${result.addedCount} detected dotenv files.`
          : "No new dotenv files detected in this project.",
      );
    } catch (detectError) {
      setError(
        detectError instanceof Error ? detectError.message : "Failed to detect dotenv files.",
      );
    } finally {
      setIsDetecting(false);
    }
  };

  const save = async () => {
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      await onSave(paths.length > 0 ? { paths } : null);
      onOpenChange(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save dotenv sync.");
    } finally {
      setIsSaving(false);
    }
  };

  const runSync = async () => {
    if (!canRunSync) {
      return;
    }
    setIsSyncing(true);
    setError(null);
    setNotice(null);
    try {
      await onRunSync();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Failed to sync dotenv files.");
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Dotenv Sync</DialogTitle>
          <DialogDescription>
            Copy selected dotenv files from the project root into newly created worktrees.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="dotenv-sync-path">Add dotenv path</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="dotenv-sync-path"
                  placeholder=".env.local"
                  value={newPath}
                  spellCheck={false}
                  onChange={(event) => {
                    setNewPath(event.target.value);
                    if (error) {
                      setError(null);
                    }
                    if (notice) {
                      setNotice(null);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") {
                      return;
                    }
                    event.preventDefault();
                    addPath();
                  }}
                />
                <Button type="button" variant="outline" onClick={addPath}>
                  Add
                </Button>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="shrink-0"
                        aria-label="Detect dotenv files in project"
                        disabled={isDetecting || isSaving || isSyncing}
                        onClick={() => {
                          void detectPaths();
                        }}
                      >
                        <SearchIcon />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">
                    {isDetecting ? "Detecting dotenv files..." : "Detect dotenv files in project"}
                  </TooltipPopup>
                </Tooltip>
              </div>
              <p className="text-xs text-muted-foreground">
                Use project-relative dotenv paths like <code>.env.local</code> or{" "}
                <code>apps/web/.env</code>.
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>Configured dotenv files: {paths.length}</span>
                {paths.length > 0 ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      setPaths([]);
                      setError(null);
                    }}
                  >
                    Clear all
                  </Button>
                ) : null}
              </div>

              {paths.length > 0 ? (
                <div className="space-y-2">
                  {paths.map((path) => (
                    <div
                      key={path}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                    >
                      <code className="min-w-0 flex-1 truncate text-xs text-foreground">{path}</code>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          setPaths((existing) => existing.filter((entry) => entry !== path));
                          setError(null);
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                  No dotenv files configured.
                </div>
              )}
            </div>

            {activeWorktreePath ? (
              <div className="rounded-lg border border-border bg-background px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">Sync current worktree</p>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      {activeWorktreePath}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={!canRunSync}
                    onClick={() => {
                      void runSync();
                    }}
                  >
                    {isSyncing ? "Syncing..." : "Sync now"}
                  </Button>
                </div>
                {!hasSavedPaths ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Save at least one dotenv path to enable manual sync.
                  </p>
                ) : null}
              </div>
            ) : null}

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            {!error && notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!isDirty || isSaving || isSyncing} onClick={() => void save()}>
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
