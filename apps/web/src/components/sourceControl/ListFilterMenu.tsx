/**
 * The control strip over a list of issues or of pull requests: the search, and the one menu every
 * filter lives behind. Both surfaces narrow by the same things — a state, an involvement, a host, a
 * project — and each keeps its own vocabulary for what those values are, so what is written here is
 * the chrome around the choice and never the choice itself.
 *
 * Named `ListFilterMenu` rather than a bar: there are no pills to overflow and nothing to clear all
 * of. Two controls wide is the whole design, and the trigger's dot is what says the list is
 * narrowed.
 */
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { FolderGit2Icon, LayersIcon, ListFilterIcon, LoaderIcon, SearchIcon } from "lucide-react";
import type { ElementType, ReactNode } from "react";

import { cn } from "~/lib/utils";

import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ListFilterOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /**
   * Carries the option's own tone, so an icon reads the same here as it does on a row. Left
   * uncoloured, which lets the item's selected state stay the thing the eye follows.
   */
  readonly Icon: ElementType<{ className?: string }>;
  /** Why it cannot be chosen, carried onto the item as its title. */
  readonly unavailable?: string | undefined;
}

const ALL_PROJECTS_VALUE = "all";

export function ListSearchInput({
  label,
  placeholder = label,
  value,
  busy,
  onChange,
}: {
  /** What is being searched, said in the box and to the reader who is being read to. */
  label: string;
  /** A visible hint when the search accepts more than plain text. */
  placeholder?: string;
  value: string;
  /** A search is on its way to the hosts, said where the typing is rather than over the list. */
  busy?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <InputGroup className="min-w-0 flex-1 **:[input]:h-9 sm:**:[input]:h-8">
      <InputGroupAddon>
        {busy ? <LoaderIcon aria-hidden className="animate-spin" /> : <SearchIcon aria-hidden />}
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        aria-label={label}
      />
    </InputGroup>
  );
}

export function ListFilterMenu({
  label,
  filterCount,
  children,
}: {
  label: string;
  filterCount: number;
  children: ReactNode;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            className={cn(filterCount > 0 && "[--control-icon-color:currentColor]")}
            size="default"
            variant="outline"
            aria-label={label}
          />
        }
      >
        <ListFilterIcon className="size-4" />
        <span>Filters</span>
        {filterCount > 0 ? (
          <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
            {filterCount}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-56">
        {children}
      </MenuPopup>
    </Menu>
  );
}

export function ListFilterRadioGroup<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<ListFilterOption<Value>>;
  onChange: (value: Value) => void;
}) {
  return (
    <MenuRadioGroup
      value={value}
      onValueChange={(next) => {
        if (next !== value) onChange(next as Value);
      }}
    >
      <MenuGroupLabel>{label}</MenuGroupLabel>
      {options.map((option) => {
        const item = (
          <MenuRadioItem
            key={option.value}
            value={option.value}
            className={option.unavailable ? "data-disabled:pointer-events-auto" : undefined}
            // A host the server has already said it cannot read is not a choice here: offering
            // it would answer the press by replacing a working list with that failure.
            disabled={option.unavailable !== undefined}
          >
            <span className="flex min-w-0 items-center gap-2">
              <option.Icon aria-hidden className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        );
        if (!option.unavailable) return item;
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger render={item} />
            <TooltipPopup side="top" className="max-w-80">
              {option.unavailable}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </MenuRadioGroup>
  );
}

/** The projects themselves, which are the workspace's and belong to neither surface. */
export function ListProjectFilterGroup({
  environmentId,
  projects,
  projectId,
  unavailable,
  onProject,
}: {
  /** Where the projects' own favicons are read from; null before the environment is known. */
  environmentId: EnvironmentId | null;
  projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
  }>;
  projectId: ProjectId | undefined;
  /**
   * Projects whose repository could not be read this time round. They are named here, where
   * the reader is already choosing between projects, rather than as a count above the list
   * that says something is missing without saying which.
   */
  unavailable: ReadonlyMap<ProjectId, string>;
  onProject: (projectId: ProjectId | undefined) => void;
}) {
  return (
    <MenuRadioGroup
      value={projectId ?? ALL_PROJECTS_VALUE}
      onValueChange={(next) => {
        const nextProjectId = next === ALL_PROJECTS_VALUE ? undefined : (next as ProjectId);
        if (nextProjectId !== projectId) onProject(nextProjectId);
      }}
    >
      <MenuGroupLabel>Project</MenuGroupLabel>
      <MenuRadioItem value={ALL_PROJECTS_VALUE}>
        <span className="flex min-w-0 items-center gap-2">
          <LayersIcon aria-hidden className="size-3.5" />
          <span className="flex-1">All projects</span>
          <MenuRadioItemIndicator />
        </span>
      </MenuRadioItem>
      {/* The ones that can be chosen first: a list that opens with three disabled rows reads
          as a broken menu rather than as a workspace with three unreadable repositories. */}
      {projects
        .toSorted(
          (left, right) => Number(unavailable.has(left.id)) - Number(unavailable.has(right.id)),
        )
        .map((project) => {
          const reason = unavailable.get(project.id);
          const item = (
            <MenuRadioItem
              key={project.id}
              value={project.id}
              className={reason !== undefined ? "data-disabled:pointer-events-auto" : undefined}
              disabled={reason !== undefined}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {environmentId === null ? (
                  <FolderGit2Icon aria-hidden className="size-3.5 shrink-0" />
                ) : (
                  <ProjectFavicon
                    project={{ ...project, environmentId }}
                    fallbackIcon={FolderGit2Icon}
                    className="size-3.5 shrink-0"
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{project.title}</span>
                <MenuRadioItemIndicator />
                {reason === undefined ? null : (
                  <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-600 dark:text-amber-400/90">
                    Unavailable
                  </span>
                )}
              </span>
            </MenuRadioItem>
          );
          if (reason === undefined) return item;
          return (
            <Tooltip key={project.id}>
              <TooltipTrigger render={item} />
              <TooltipPopup side="top" className="max-w-80">
                {reason}
              </TooltipPopup>
            </Tooltip>
          );
        })}
    </MenuRadioGroup>
  );
}
