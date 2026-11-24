import type { DraftId } from "~/composerDraftStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { isTriagePrompt } from "@t3tools/shared/triagePrompt";
import { useGT } from "gt-react";

import { useScratchProject } from "~/hooks/useScratchProject";
import { useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { TriageDraftHero } from "./TriageDraftHero";

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
}

export function DraftHeroHeadline({ draftId, activeProjectRef }: DraftHeroHeadlineProps) {
  const gt = useGT();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const { scratchWorkspaceRootFor } = useScratchProject();
  // A boolean, so typing in a draft does not re-render the hero.
  const isTriageDraftPrompt = useComposerDraftStore((store) =>
    draftId ? isTriagePrompt(store.getComposerDraft(draftId)?.prompt ?? "") : false,
  );
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const isScratchDraft =
    activeProject !== null &&
    isScratchProject(activeProject, scratchWorkspaceRootFor(activeProject.environmentId));

  if (isScratchDraft && isTriageDraftPrompt) {
    const environment = environments.find(
      (entry) => entry.environmentId === activeProject.environmentId,
    );
    return (
      <TriageDraftHero
        machineLabel={environment?.label ?? null}
        serverVersion={environment?.serverConfig?.environment.serverVersion ?? null}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <div
        aria-hidden="true"
        className="mb-3 flex size-12 items-center justify-center text-muted-foreground/55"
      >
        <svg
          viewBox="0 0 48 48"
          fill="none"
          className="size-11"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 11.2a6.4 6.4 0 0 1 11.9-.3 6.2 6.2 0 0 1 8.4 6.6 6.2 6.2 0 0 1 1.3 10.6 6.3 6.3 0 0 1-7.4 8.5 6.4 6.4 0 0 1-11.2 1.6 6.3 6.3 0 0 1-9.9-4.1 6.2 6.2 0 0 1-2.2-10.3 6.2 6.2 0 0 1 3.6-10.3A6.2 6.2 0 0 1 18 11.2Z" />
          <path d="m17.5 20 4.3 3.7-4.3 3.7" />
          <path d="M24.2 27.6h5.5" />
        </svg>
      </div>
      <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        {gt("What should we build?")}
      </h1>
    </div>
  );
}
