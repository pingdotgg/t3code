import type { WorkspaceRepository } from "@t3tools/contracts";
import { ChevronDownIcon, FolderGit2Icon } from "lucide-react";

import { includedRepositoryCount, isRepositoryIncluded } from "~/lib/multiRepo";
import { useWorktreeRepositorySelectionStore } from "~/worktreeRepositorySelectionStore";
import { ComposerContextLabel } from "../ComposerContextLabel";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

/**
 * Which tracked repos a new task folder gets. Every repo starts checked and from its own default
 * branch, so sending without opening this needs no choices.
 */
export function ComposerReposControl({
  selectionKey,
  repositories,
}: {
  selectionKey: string;
  repositories: ReadonlyArray<WorkspaceRepository>;
}) {
  const selection = useWorktreeRepositorySelectionStore((store) => store.byKey[selectionKey]);
  const setIncluded = useWorktreeRepositorySelectionStore((store) => store.setIncluded);
  const setBaseRef = useWorktreeRepositorySelectionStore((store) => store.setBaseRef);
  const composerFloatingLayerProps = useComposerMenuProps();
  const included = includedRepositoryCount(repositories, selection);
  const label =
    included === repositories.length ? "Repos" : `Repos ${included}/${repositories.length}`;

  return (
    <Popover>
      <PopoverTrigger
        render={<ComposerControl size="xs" />}
        className="min-w-0 shrink"
        aria-label={`Repositories for the new worktree: ${included} of ${repositories.length}`}
        data-composer-context-control
      >
        <FolderGit2Icon className="size-3 shrink-0 mx-0!" />
        <ComposerContextLabel>{label}</ComposerContextLabel>
        <ChevronDownIcon className="size-3 shrink-0 mx-0!" />
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        width="lg"
        padding="compact"
        {...composerFloatingLayerProps}
      >
        <div className="flex flex-col gap-1">
          {repositories.map((repository) => {
            const checked = isRepositoryIncluded(selection, repository.originalPath);
            return (
              <div key={repository.originalPath} className="flex min-w-0 items-center gap-2">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) =>
                      setIncluded(selectionKey, repository.originalPath, next)
                    }
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">{repository.name}</span>
                    <span className="flex min-w-0 font-mono text-muted-foreground text-xs">
                      <MiddleTruncate value={repository.originalPath} />
                    </span>
                  </span>
                </label>
                <Input
                  size="compact"
                  font="mono"
                  className="w-32 shrink-0"
                  placeholder="default branch"
                  aria-label={`Base branch for ${repository.name}`}
                  disabled={!checked}
                  spellCheck={false}
                  autoComplete="off"
                  value={selection?.baseRefs[repository.originalPath] ?? ""}
                  onChange={(event) =>
                    setBaseRef(selectionKey, repository.originalPath, event.target.value)
                  }
                />
              </div>
            );
          })}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
