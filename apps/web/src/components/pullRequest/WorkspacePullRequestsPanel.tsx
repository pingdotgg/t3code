import type {
  ProjectId,
  ScopedThreadRef,
  VcsStatusResult,
  WorkspaceRepository,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { GitPullRequestIcon } from "lucide-react";
import { Tabs } from "@base-ui/react/tabs";
import { PullRequestDetailPanel } from "./PullRequestDetailPanel";
import GitActionsControl from "../GitActionsControl";
import { Button } from "../ui/button";
import type { DraftId } from "../../composerDraftStore";

export function WorkspacePullRequestsPanel({
  threadRef,
  projectId,
  repositories,
  statuses,
  initialRepositoryPath,
  composerDraftTarget,
  error,
  isPending,
  onRefresh,
}: {
  threadRef: ScopedThreadRef;
  projectId: ProjectId;
  repositories: readonly WorkspaceRepository[];
  statuses: readonly {
    repository: WorkspaceRepository;
    status: VcsStatusResult | null;
    error: string | null;
    isPending: boolean;
  }[];
  initialRepositoryPath: string | null;
  composerDraftTarget: ScopedThreadRef | DraftId;
  error: string | null;
  isPending: boolean;
  onRefresh: () => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const statusesByPath = new Map(statuses.map((entry) => [entry.repository.path, entry]));
  const initial = initialRepositoryPath ? statusesByPath.get(initialRepositoryPath) : undefined;
  const activePath =
    selectedPath ??
    (initial?.status?.pr ? initial.repository.path : null) ??
    statuses.find((entry) => entry.status?.pr)?.repository.path ??
    initialRepositoryPath ??
    repositories[0]?.path ??
    ".";
  const repository = repositories.find((entry) => entry.path === activePath);
  const state = statusesByPath.get(activePath);
  const pr = state?.status?.pr;
  const identity = repository?.repositoryIdentity;
  const remoteRepository =
    identity?.provider === "azure-devops" ? identity.name : identity?.displayName;
  let content: ReactNode;
  if (!repository) {
    content = (
      <p className="p-4 text-xs text-muted-foreground">
        {isPending
          ? "Loading workspace repositories…"
          : "This repository is no longer in the workspace."}
      </p>
    );
  } else if (!repository.available) {
    content = (
      <p className="p-4 text-xs text-muted-foreground">
        This repository is unavailable. Initialize it in the workspace, then refresh.
      </p>
    );
  } else if (state?.error) {
    content = (
      <p role="alert" className="p-4 text-xs text-error">
        {state.error}
      </p>
    );
  } else if (pr && remoteRepository) {
    content = (
      <PullRequestDetailPanel
        key={`${threadRef.environmentId}:${threadRef.threadId}:${repository.path}:${pr.number}`}
        environmentId={threadRef.environmentId}
        threadRef={threadRef}
        reference={{
          projectId,
          repository: remoteRepository,
          number: pr.number,
          workspace: { threadId: threadRef.threadId, repositoryPath: repository.path },
        }}
        context="thread"
        composerDraftTarget={composerDraftTarget}
        onActed={onRefresh}
        browserUrl={pr.url}
      />
    );
  } else {
    let message = "Checking this branch for a pull request…";
    if (state?.status) {
      message = pr
        ? "The repository remote could not be resolved."
        : `No pull request for ${state.status.refName ?? "this checkout"}.`;
    }
    content = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center text-xs text-muted-foreground">
        <div className="rounded-full bg-muted p-3">
          <GitPullRequestIcon className="size-5" />
        </div>
        <p className="font-medium text-foreground">{message}</p>
        {state?.status && !pr && (
          <>
            <p className="max-w-xs">
              Use Git actions to open a pull request for {repository.name}, or choose another
              repository above.
            </p>
            <GitActionsControl
              key={repository.cwd}
              gitCwd={repository.cwd}
              activeThreadRef={threadRef}
              syncThreadBranch={repository.path === "."}
              onOpenPullRequest={onRefresh}
            />
          </>
        )}
      </div>
    );
  }
  return (
    <Tabs.Root
      value={activePath}
      onValueChange={(value) => setSelectedPath(String(value))}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2">
        <Tabs.List
          aria-label="Workspace pull requests"
          className="flex min-w-0 flex-1 overflow-x-auto"
        >
          {repositories.map((entry) => {
            const entryPr = statusesByPath.get(entry.path)?.status?.pr;
            return (
              <Tabs.Tab
                key={entry.path}
                value={entry.path}
                className="shrink-0 border-b-2 border-transparent px-3 py-2 text-xs text-muted-foreground outline-none data-[active]:border-primary data-[active]:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {entry.name}
                {entryPr ? ` #${entryPr.number}` : ""}
              </Tabs.Tab>
            );
          })}
        </Tabs.List>
        <Button size="xs" variant="ghost" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-error">
          {error}
        </p>
      )}
      <Tabs.Panel value={activePath} className="flex min-h-0 flex-1 flex-col">
        {content}
      </Tabs.Panel>
    </Tabs.Root>
  );
}
