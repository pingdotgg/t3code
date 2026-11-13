import {
  resolveWorktreeRepositorySelection,
  type WorktreeRepositoryChoice,
} from "@t3tools/client-runtime/state/thread-repositories";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { FolderGitIcon } from "lucide-react";
import { memo, useState } from "react";

import { type ComposerThreadTarget, useComposerDraftStore } from "../composerDraftStore";
import { useWorktreeRepositoryChoices } from "../hooks/useWorktreeRepositoryChoices";
import { cn } from "../lib/utils";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { ComposerControl } from "./chat/ComposerControl";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuItemLabel,
  MenuPopup,
  MenuSearchInput,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";

/** A checklist this long gets a filter. */
const FILTER_ABOVE_CHOICES = 8;

function matchesFilter(choice: WorktreeRepositoryChoice, filter: string): boolean {
  return (
    choice.name.toLowerCase().includes(filter) ||
    (choice.relativePath ?? choice.repositoryPath).toLowerCase().includes(filter)
  );
}

/**
 * Which tracked repositories a new worktree thread gets a worktree of. The choice lives in the
 * draft thread; until the user makes one, the server's default applies.
 */
export const WorktreeRepositoriesControl = memo(function WorktreeRepositoriesControl(props: {
  project: EnvironmentProject;
  draftTarget: ComposerThreadTarget;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const { choices } = useWorktreeRepositoryChoices(props.project);
  const chosen = useComposerDraftStore(
    (store) => store.getDraftThread(props.draftTarget)?.worktreeRepositories,
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const [filter, setFilter] = useState("");

  if (choices === null || choices.length === 0) return null;

  const selection = resolveWorktreeRepositorySelection({ choices, chosen });
  const selected = new Set(selection.selected);
  const choose = (paths: ReadonlyArray<string>) =>
    setDraftThreadContext(props.draftTarget, { worktreeRepositories: paths });
  const normalizedFilter = filter.trim().toLowerCase();
  const visible =
    normalizedFilter === ""
      ? choices
      : choices.filter((choice) => matchesFilter(choice, normalizedFilter));

  return (
    <Menu onOpenChange={(open) => (open ? undefined : setFilter(""))}>
      <MenuTrigger
        render={<ComposerControl size="xs" />}
        className={cn(
          "min-w-0 flex-initial justify-start",
          selection.needsChoice && "text-warning-foreground dark:text-warning-foreground",
        )}
        aria-label={`Repositories in the new worktree: ${selection.label}`}
        data-composer-context-control
      >
        <FolderGitIcon className="size-3 shrink-0" aria-hidden />
        <ComposerContextLabel>{selection.label}</ComposerContextLabel>
      </MenuTrigger>
      <MenuPopup align="start" side="top" {...composerFloatingLayerProps}>
        {choices.length > FILTER_ABOVE_CHOICES ? (
          <MenuSearchInput
            autoFocus
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            placeholder="Filter repositories"
            aria-label="Filter repositories"
          />
        ) : null}
        <MenuGroupLabel>
          {selection.needsChoice
            ? "Choose the repositories this thread works on"
            : "Each gets its own worktree on the thread's branch"}
        </MenuGroupLabel>
        {visible.length === 0 ? <MenuItem disabled>No repositories match</MenuItem> : null}
        {visible.map((choice) => (
          <MenuCheckboxItem
            key={choice.repositoryPath}
            checked={selected.has(choice.repositoryPath)}
            closeOnClick={false}
            onCheckedChange={(next) =>
              choose(
                choices.flatMap((candidate) =>
                  (
                    candidate.repositoryPath === choice.repositoryPath
                      ? next
                      : selected.has(candidate.repositoryPath)
                  )
                    ? [candidate.repositoryPath]
                    : [],
                ),
              )
            }
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <MenuItemLabel>{choice.name}</MenuItemLabel>
              {choice.relativePath !== undefined && choice.relativePath !== choice.name ? (
                <MenuItemDetail>{choice.relativePath}</MenuItemDetail>
              ) : null}
            </span>
          </MenuCheckboxItem>
        ))}
        <MenuSeparator />
        <MenuItem
          closeOnClick={false}
          disabled={selected.size === choices.length}
          onClick={() => choose(choices.map((choice) => choice.repositoryPath))}
        >
          Select all
        </MenuItem>
        <MenuItem
          closeOnClick={false}
          disabled={chosen !== undefined && selected.size === 0}
          onClick={() => choose([])}
        >
          Select none
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});
