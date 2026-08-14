import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderIcon, FolderPlusIcon, XIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { inferProjectTitleFromPath, resolveProjectPathForDispatch } from "../lib/projectPaths";
import { filesystemEnvironment } from "../state/filesystem";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { stackedThreadToast, toastManager } from "./ui/toast";

export interface MultiRepoProjectDraft {
  readonly token: number;
  readonly environmentId: EnvironmentId;
  readonly roots: ReadonlyArray<string>;
  readonly stage: "form" | "folder-picker";
  readonly title: string;
  readonly titleSource: "automatic" | "user";
}

function titleForPrimaryRoot(draft: MultiRepoProjectDraft, roots: ReadonlyArray<string>): string {
  if (draft.titleSource === "user") return draft.title;
  return roots[0] ? inferProjectTitleFromPath(roots[0]) : "";
}

export function useCommandPaletteMultiRepoDraft(input: {
  readonly currentProjectCwd: string | null;
}) {
  const [draft, setDraft] = useState<MultiRepoProjectDraft | null>(null);
  const draftTokenRef = useRef(0);
  const scanGitRepos = useAtomQueryRunner(filesystemEnvironment.scanGitRepos, {
    reportFailure: false,
  });
  const startDraft = useCallback((environmentId: EnvironmentId) => {
    draftTokenRef.current += 1;
    setDraft({
      token: draftTokenRef.current,
      environmentId,
      roots: [],
      stage: "form",
      title: "",
      titleSource: "automatic",
    });
  }, []);
  const clearDraft = useCallback(() => {
    draftTokenRef.current += 1;
    setDraft(null);
  }, []);
  const attachRoot = useCallback(
    async (rawPath: string): Promise<boolean> => {
      if (!draft) return false;
      const draftToken = draft.token;
      const path = resolveProjectPathForDispatch(rawPath, input.currentProjectCwd);
      if (!path) return false;
      const result = await scanGitRepos({
        environmentId: draft.environmentId,
        input: { parentPath: path },
      });
      if (draftTokenRef.current !== draftToken) return false;
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
        return false;
      }
      const normalizedPath = result.value.parentPath;
      setDraft((current) => {
        if (!current || current.token !== draftToken) return current;
        if (current.roots.includes(normalizedPath)) return current;
        const roots = [...current.roots, normalizedPath];
        return { ...current, roots, title: titleForPrimaryRoot(current, roots) };
      });
      return true;
    },
    [draft, input.currentProjectCwd, scanGitRepos],
  );
  const setTitle = useCallback((title: string) => {
    setDraft((current) =>
      current ? { ...current, title, titleSource: "user" as const } : current,
    );
  }, []);
  const makePrimary = useCallback((root: string) => {
    setDraft((current) => {
      if (!current || !current.roots.includes(root)) return current;
      const roots = [root, ...current.roots.filter((candidate) => candidate !== root)];
      return { ...current, roots, title: titleForPrimaryRoot(current, roots) };
    });
  }, []);
  const removeRoot = useCallback((root: string) => {
    setDraft((current) => {
      if (!current) return current;
      const roots = current.roots.filter((candidate) => candidate !== root);
      return { ...current, roots, title: titleForPrimaryRoot(current, roots) };
    });
  }, []);
  const showFolderPicker = useCallback(() => {
    setDraft((current) => (current ? { ...current, stage: "folder-picker" } : current));
  }, []);
  const showForm = useCallback(() => {
    setDraft((current) => (current ? { ...current, stage: "form" } : current));
  }, []);
  return {
    attachRoot,
    clearDraft,
    draft,
    makePrimary,
    removeRoot,
    setTitle,
    showFolderPicker,
    showForm,
    startDraft,
  };
}

export function MultiRepoProjectForm(props: {
  readonly draft: MultiRepoProjectDraft;
  readonly environmentLabel: string | null;
  readonly isCreating: boolean;
  readonly onAddRepository: () => void;
  readonly onCancel: () => void;
  readonly onCreate: () => void;
  readonly onMakePrimary: (root: string) => void;
  readonly onRemoveRoot: (root: string) => void;
  readonly onTitleChange: (title: string) => void;
}) {
  const canCreate = props.draft.roots.length >= 2 && props.draft.title.trim().length > 0;
  return (
    <div data-create-project-form className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-4 px-6 pt-5 pb-4">
        <div className="min-w-0">
          <h2 className="font-heading text-xl font-semibold leading-none">Create project</h2>
          {props.environmentLabel ? (
            <p className="mt-1.5 truncate text-xs text-muted-foreground">
              On {props.environmentLabel}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close create project"
          onClick={props.onCancel}
        >
          <XIcon />
        </Button>
      </div>

      <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-5">
        <div className="space-y-1.5">
          <label htmlFor="multi-repo-project-name" className="text-sm font-medium text-foreground">
            Project name
          </label>
          <div className="relative">
            <FolderIcon className="pointer-events-none absolute start-3 top-1/2 z-10 size-4 -translate-y-1/2 text-icon-muted" />
            <Input
              id="multi-repo-project-name"
              autoFocus
              size="lg"
              className="[&_[data-slot=input]]:ps-9"
              placeholder="Project name"
              value={props.draft.title}
              onChange={(event) => props.onTitleChange(event.currentTarget.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-foreground">Source folders</span>
            {props.draft.roots.length > 0 ? (
              <span className="text-xs text-muted-foreground">
                {props.draft.roots.length} selected
              </span>
            ) : null}
          </div>

          {props.draft.roots.length === 0 ? (
            <button
              type="button"
              className="flex min-h-32 w-full flex-col items-center justify-center gap-2 rounded-lg border border-border bg-foreground/[0.015] px-6 text-center transition-colors hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              onClick={props.onAddRepository}
            >
              <FolderPlusIcon className="size-5 text-icon-muted" />
              <span className="text-sm font-medium text-foreground">Add folders</span>
              <span className="text-xs text-muted-foreground">
                Choose Git repositories T3 Code agents can read and edit
              </span>
            </button>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <ul className="max-h-60 divide-y divide-border overflow-y-auto">
                {props.draft.roots.map((root, index) => {
                  const name = inferProjectTitleFromPath(root);
                  return (
                    <li key={root} className="flex min-h-14 items-center gap-3 px-3 py-2">
                      <FolderIcon className="size-4 shrink-0 text-icon-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium" title={root}>
                          {name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground" title={root}>
                          {root}
                        </span>
                      </span>
                      {index === 0 ? (
                        <span className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
                          Primary
                        </span>
                      ) : (
                        <Button
                          type="button"
                          variant="secondary"
                          size="xs"
                          className="shrink-0"
                          onClick={() => props.onMakePrimary(root)}
                        >
                          Make primary
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="shrink-0 text-muted-foreground"
                        aria-label={`Remove ${name}`}
                        onClick={() => props.onRemoveRoot(root)}
                      >
                        <XIcon />
                      </Button>
                    </li>
                  );
                })}
              </ul>
              <button
                type="button"
                className="flex min-h-11 w-full items-center gap-3 border-t border-border px-3 text-sm font-medium transition-colors hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
                onClick={props.onAddRepository}
              >
                <FolderPlusIcon className="size-4 text-icon-muted" />
                Add folder
              </button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {props.draft.roots.length < 2 ? "Add at least two Git repositories. " : null}
            The primary repository is the default working directory and Git target.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border bg-foreground/[0.02] px-6 py-4">
        <Button type="button" variant="ghost" disabled={props.isCreating} onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="button" disabled={!canCreate || props.isCreating} onClick={props.onCreate}>
          {props.isCreating ? "Creating…" : "Create project"}
        </Button>
      </div>
    </div>
  );
}
