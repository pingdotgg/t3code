import type { WorkspaceRepository, VcsStatusResult } from "@t3tools/contracts";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

export function WorkspaceRepositorySelector({
  repositories,
  statuses,
  selectedPath,
  onSelect,
}: {
  repositories: readonly WorkspaceRepository[];
  statuses: readonly {
    repository: WorkspaceRepository;
    status: VcsStatusResult | null;
    error: string | null;
  }[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  if (repositories.length === 0 || (repositories.length === 1 && selectedPath !== null))
    return null;
  const statusesByPath = new Map(statuses.map((entry) => [entry.repository.path, entry]));
  const selected = repositories.find((repository) => repository.path === selectedPath);
  return (
    <Menu>
      <MenuTrigger
        className="inline-flex h-7 max-w-48 items-center gap-1 rounded-md px-2 text-xs hover:bg-accent"
        aria-label="Git repository"
      >
        <GitBranchIcon className="size-3.5 shrink-0" />
        <span className="truncate">{selected?.name ?? "Select repository"}</span>
        <ChevronDownIcon className="size-3 shrink-0" />
      </MenuTrigger>
      <MenuPopup align="end">
        {repositories.map((repository) => {
          const state = statusesByPath.get(repository.path);
          return (
            <MenuItem
              key={repository.path}
              disabled={!repository.available}
              onClick={() => onSelect(repository.path)}
            >
              <span className="min-w-0 flex-1 truncate">
                {repository.name}
                {repository.kind === "root" ? " (workspace)" : ""}
              </span>
              <span className="ml-3 text-xs text-muted-foreground">
                {repositoryStatusLabel(
                  repository.available,
                  state?.status ?? null,
                  state?.error ?? null,
                )}
              </span>
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}

function repositoryStatusLabel(
  available: boolean,
  status: VcsStatusResult | null,
  error: string | null,
): string {
  if (!available) return "Unavailable";
  if (error) return "Status unavailable";
  if (status) return `${status.refName ?? "Detached"} · ${status.workingTree.files.length}`;
  return "Loading…";
}
