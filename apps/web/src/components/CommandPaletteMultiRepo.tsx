import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { inferProjectTitleFromPath, resolveProjectPathForDispatch } from "../lib/projectPaths";
import { filesystemEnvironment } from "../state/filesystem";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";

export interface MultiRepoProjectDraft {
  readonly token: number;
  readonly environmentId: EnvironmentId;
  readonly roots: ReadonlyArray<string>;
}

export function useCommandPaletteMultiRepoDraft(input: {
  readonly currentProjectCwd: string | null;
  readonly getInitialQuery: (environmentId: EnvironmentId) => string;
  readonly resetHighlightedItem: () => void;
  readonly setQuery: (query: string) => void;
  readonly refreshBrowse: () => void;
}) {
  const { currentProjectCwd, getInitialQuery, refreshBrowse, resetHighlightedItem, setQuery } =
    input;
  const [draft, setDraft] = useState<MultiRepoProjectDraft | null>(null);
  const draftTokenRef = useRef(0);
  const scanGitRepos = useAtomQueryRunner(filesystemEnvironment.scanGitRepos, {
    reportFailure: false,
  });
  const startDraft = useCallback((environmentId: EnvironmentId) => {
    draftTokenRef.current += 1;
    setDraft({ token: draftTokenRef.current, environmentId, roots: [] });
  }, []);
  const clearDraft = useCallback(() => {
    draftTokenRef.current += 1;
    setDraft(null);
  }, []);
  const attachRoot = useCallback(
    async (rawPath: string) => {
      if (!draft) return;
      const draftToken = draft.token;
      const path = resolveProjectPathForDispatch(rawPath, currentProjectCwd);
      if (!path) return;
      const result = await scanGitRepos({
        environmentId: draft.environmentId,
        input: { parentPath: path },
      });
      if (draftTokenRef.current !== draftToken) return;
      if (result._tag === "Failure" || !result.value.parentHasGit) {
        const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Choose a Git repository",
            description:
              error instanceof Error ? error.message : `${path} is not a Git repository.`,
          }),
        );
        return;
      }
      const normalizedPath = result.value.parentPath;
      setDraft((current) => {
        if (!current || current.token !== draftToken) return current;
        if (current.roots.includes(normalizedPath)) return current;
        return { ...current, roots: [...current.roots, normalizedPath] };
      });
      resetHighlightedItem();
      setQuery(getInitialQuery(draft.environmentId));
      refreshBrowse();
    },
    [
      currentProjectCwd,
      draft,
      getInitialQuery,
      refreshBrowse,
      resetHighlightedItem,
      scanGitRepos,
      setQuery,
    ],
  );
  const removeRoot = useCallback((root: string) => {
    setDraft((current) =>
      current
        ? { ...current, roots: current.roots.filter((candidate) => candidate !== root) }
        : null,
    );
  }, []);
  return { attachRoot, clearDraft, draft, removeRoot, startDraft };
}

export function MultiRepoDraftFooter(props: {
  readonly selectedCount: number;
  readonly isCreating: boolean;
  readonly createProject: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">{props.selectedCount} selected</span>
      <Button
        variant="outline"
        size="xs"
        disabled={props.selectedCount < 2 || props.isCreating}
        onClick={props.createProject}
      >
        {props.isCreating ? "Creating…" : "Create project"}
      </Button>
    </div>
  );
}

export function MultiRepoDraftSelection(props: {
  readonly roots: ReadonlyArray<string>;
  readonly removeRoot: (root: string) => void;
}) {
  if (props.roots.length === 0) return null;
  return (
    <div className="border-b border-border p-2 pb-1.5">
      <div className="px-2 py-1 font-medium text-muted-foreground text-xs">Repositories</div>
      <div className="space-y-0.5">
        {props.roots.map((root, index) => (
          <div key={root} className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1">
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm" title={root}>
              {root}
            </span>
            {index === 0 ? (
              <span className="text-[10px] font-medium text-muted-foreground uppercase">
                Primary
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="xs"
              aria-label={`Remove ${inferProjectTitleFromPath(root)}`}
              onClick={() => props.removeRoot(root)}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
