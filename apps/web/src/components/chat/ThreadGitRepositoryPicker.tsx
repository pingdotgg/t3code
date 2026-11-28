import {
  threadGitRepositoryLabel,
  type ThreadGitRepository,
} from "@t3tools/client-runtime/state/thread-repositories";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderGitIcon } from "lucide-react";
import { useGT } from "gt-react";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";

import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

const THREAD_FOLDER = "__thread_folder__";

/**
 * Picks the repository the details panel's branch, Git actions, and Changes rows act in: the
 * thread's own folder or another repository it reaches. The row always names the one picked.
 */
export function ThreadGitRepositoryPicker(props: {
  environmentId: EnvironmentId;
  projectRoot: string | null;
  /** The thread's own folder; listed only when it is a repository itself. */
  threadFolder: { readonly name: string; readonly isRepo: boolean };
  repositories: ReadonlyArray<ThreadGitRepository>;
  /** Null for the thread's own folder. */
  selected: ThreadGitRepository | null;
  onSelect: (repositoryPath: string | null) => void;
}) {
  const gt = useGT();
  const { selected } = props;
  // Local status only, as a repository section reads it: the Git actions below hold the full one.
  const status = useEnvironmentQuery(
    selected === null
      ? null
      : vcsEnvironment.status({
          environmentId: props.environmentId,
          input: { cwd: selected.cwd, includeRemote: false },
        }),
  );
  const label =
    selected === null
      ? props.threadFolder.name
      : threadGitRepositoryLabel(selected, props.projectRoot);
  // The thread's own folder shows its branch on the branch row below this one.
  const branch =
    selected === null || status.data == null
      ? null
      : status.data.isRepo
        ? (status.data.refName ?? gt("Detached HEAD"))
        : gt("Not a Git repository");

  return (
    <Menu>
      <MenuTrigger
        render={<ThreadDetailsControl part="select" />}
        aria-label={gt("Repository: {name}", { name: label })}
      >
        <FolderGitIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className={cn("min-w-0 shrink truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
            {label}
          </span>
          {branch !== null ? (
            <span
              className={cn(
                "min-w-0 truncate font-normal text-muted-foreground",
                THREAD_DETAILS_PANEL_LABEL_CLASS,
              )}
            >
              {branch}
            </span>
          ) : null}
        </span>
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="w-(--anchor-width)">
        <MenuRadioGroup
          value={selected?.repositoryPath ?? THREAD_FOLDER}
          onValueChange={(value: string) => props.onSelect(value === THREAD_FOLDER ? null : value)}
        >
          {props.threadFolder.isRepo ? (
            <MenuRadioItem value={THREAD_FOLDER} closeOnClick>
              <span className="block min-w-0 truncate">{props.threadFolder.name}</span>
            </MenuRadioItem>
          ) : null}
          {props.repositories.map((repository) => (
            <MenuRadioItem
              key={repository.repositoryPath}
              value={repository.repositoryPath}
              closeOnClick
            >
              <span className="block min-w-0 truncate">
                {threadGitRepositoryLabel(repository, props.projectRoot)}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
