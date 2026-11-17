import type { IssueCandidatesTarget } from "@t3tools/client-runtime/state/issues";
import type {
  EnvironmentId,
  IssueInvolvement,
  IssueListState,
  ProjectId,
} from "@t3tools/contracts";
import { FolderGit2Icon, LayersIcon, ListFilterIcon, TagIcon, UserIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSearchInput,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { useIssueFilterCandidates } from "~/state/issues";

import type { ProjectFaviconProject } from "../ProjectFavicon";

import {
  PullRequestFilterRadioSubmenu,
  pullRequestProjectKey,
  type PullRequestFilterOption,
} from "../pullRequest/PullRequestListFilters";
import { pullRequestLabelColor } from "../pullRequest/pullRequestList.logic";

const VISIBLE_CHOICES = 30;
const ALL_PROJECTS = "all";
const matches = (needle: string, ...fields: ReadonlyArray<string | null | undefined>) =>
  needle.length === 0 || fields.some((field) => field?.toLowerCase().includes(needle));

/** Every issue list filter behind one button, as the pull request page keeps its own. */
export function IssueFiltersMenu(props: {
  state: IssueListState;
  stateOptions: ReadonlyArray<PullRequestFilterOption<IssueListState>>;
  onState: (state: IssueListState) => void;
  involvement: IssueInvolvement;
  involvementOptions: ReadonlyArray<PullRequestFilterOption<IssueInvolvement>>;
  onInvolvement: (involvement: IssueInvolvement) => void;
  scopes: ReadonlyArray<IssueCandidatesTarget>;
  labels: ReadonlyArray<string>;
  onLabels: (labels: ReadonlyArray<string>) => void;
  assignee: string | undefined;
  onAssignee: (assignee: string | undefined) => void;
  projects: ReadonlyArray<ProjectFaviconProject & { readonly id: ProjectId }>;
  project: { environmentId: EnvironmentId; projectId: ProjectId } | undefined;
  onProject: (project: { environmentId: EnvironmentId; projectId: ProjectId } | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = [
    props.state !== "open",
    props.involvement !== "all",
    props.project,
    props.assignee,
    ...props.labels,
  ].filter(Boolean).length;
  const projectValue = props.project
    ? pullRequestProjectKey({
        id: props.project.projectId,
        environmentId: props.project.environmentId,
      })
    : ALL_PROJECTS;
  const projectOptions: ReadonlyArray<PullRequestFilterOption<string>> = [
    { value: ALL_PROJECTS, label: "All projects", Icon: LayersIcon },
    // A remembered project this client does not list stays shown, so the filter can be taken off.
    ...(projectValue !== ALL_PROJECTS &&
    !props.projects.some((project) => pullRequestProjectKey(project) === projectValue)
      ? [{ value: projectValue, label: "Unavailable project", Icon: FolderGit2Icon }]
      : []),
    ...props.projects.map((project) => ({
      value: pullRequestProjectKey(project),
      label: project.title,
      Icon: FolderGit2Icon,
      project,
    })),
  ];
  // Read when the menu opens, not with every listing: one request per scope.
  const scopes = open ? props.scopes : [];
  return (
    <Menu onOpenChange={setOpen}>
      <MenuTrigger render={<Button variant="outline" />}>
        <ListFilterIcon className="size-4" />
        <span>Filters</span>
        {count > 0 ? (
          <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        <PullRequestFilterRadioSubmenu
          label="State"
          value={props.state}
          options={props.stateOptions}
          onChange={props.onState}
        />
        <PullRequestFilterRadioSubmenu
          label="Involvement"
          value={props.involvement}
          options={props.involvementOptions}
          onChange={props.onInvolvement}
        />
        {props.projects.length > 1 || props.project ? (
          <PullRequestFilterRadioSubmenu
            label="Project"
            value={projectValue}
            options={projectOptions}
            onChange={(next) => {
              const project = props.projects.find((p) => pullRequestProjectKey(p) === next);
              props.onProject(
                project
                  ? { environmentId: project.environmentId, projectId: project.id }
                  : undefined,
              );
            }}
          />
        ) : null}
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger>
            <TagIcon aria-hidden className="size-3.5" />
            <span className="flex-1">Labels</span>
            <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
              {props.labels.length === 0
                ? "Any"
                : props.labels.length === 1
                  ? props.labels[0]
                  : `${props.labels.length} labels`}
            </span>
          </MenuSubTrigger>
          <MenuSubPopup>
            <LabelChoices scopes={scopes} value={props.labels} onChange={props.onLabels} />
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger>
            <UserIcon aria-hidden className="size-3.5" />
            <span className="flex-1">Assignee</span>
            <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
              {props.assignee ?? "Anyone"}
            </span>
          </MenuSubTrigger>
          <MenuSubPopup>
            <AssigneeChoices scopes={scopes} value={props.assignee} onChange={props.onAssignee} />
          </MenuSubPopup>
        </MenuSub>
      </MenuPopup>
    </Menu>
  );
}

function LabelChoices(props: {
  scopes: ReadonlyArray<IssueCandidatesTarget>;
  value: ReadonlyArray<string>;
  onChange: (value: ReadonlyArray<string>) => void;
}) {
  const [query, setQuery] = useState("");
  const known = useIssueFilterCandidates(props.scopes);
  const needle = query.trim().toLowerCase();
  const found = known.labels.filter((label) => matches(needle, label.name, label.description));
  // Chosen labels lead, so one the tracker's first page lacks can still be seen and cleared.
  const visible = [
    ...props.value
      .filter((name) => !found.some((label) => label.name === name))
      .map((name) => ({ name, color: null })),
    ...found,
  ].slice(0, VISIBLE_CHOICES);
  return (
    <>
      <MenuSearchInput
        autoFocus
        busy={known.isPending}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="Search labels"
        aria-label="Search labels"
      />
      {visible.length === 0 && !known.isPending ? (
        <MenuItem disabled>
          {known.error === null ? "No labels found" : "The labels could not be read"}
        </MenuItem>
      ) : null}
      {visible.map((label) => {
        const dot = pullRequestLabelColor(label.color);
        return (
          <MenuCheckboxItem
            key={label.name}
            checked={props.value.includes(label.name)}
            onCheckedChange={(next) =>
              props.onChange(
                next
                  ? [...props.value, label.name].slice(0, 20)
                  : props.value.filter((name) => name !== label.name),
              )
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full bg-muted-foreground"
                {...(dot ? { style: { backgroundColor: dot } } : {})}
              />
              <span className="min-w-0 flex-1 truncate">{label.name}</span>
            </span>
          </MenuCheckboxItem>
        );
      })}
      {known.truncated ? (
        <MenuItem disabled>More labels exist than are listed here.</MenuItem>
      ) : null}
    </>
  );
}

function AssigneeChoices(props: {
  scopes: ReadonlyArray<IssueCandidatesTarget>;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const [query, setQuery] = useState("");
  const known = useIssueFilterCandidates(props.scopes);
  const needle = query.trim().toLowerCase();
  const found = known.assignees.filter((actor) => matches(needle, actor.login, actor.name));
  const visible = [
    ...(props.value !== undefined && !found.some((actor) => actor.login === props.value)
      ? [{ login: props.value, name: null }]
      : []),
    ...found,
  ].slice(0, VISIBLE_CHOICES);
  return (
    <>
      <MenuSearchInput
        autoFocus
        busy={known.isPending}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="Search people"
        aria-label="Search people"
      />
      <MenuRadioGroup
        value={props.value ?? ""}
        onValueChange={(next) => props.onChange(next || undefined)}
      >
        <MenuRadioItem value="">
          <span className="flex min-w-0 items-center gap-2">
            <LayersIcon aria-hidden className="size-3.5" />
            Anyone
          </span>
        </MenuRadioItem>
        {visible.map((actor) => (
          <MenuRadioItem key={actor.login} value={actor.login}>
            <span className="min-w-0 flex-1 truncate">
              {actor.login}
              {actor.name ? <span className="text-muted-foreground"> · {actor.name}</span> : null}
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      {visible.length === 0 && !known.isPending && known.error !== null ? (
        <MenuItem disabled>The people could not be read</MenuItem>
      ) : null}
      {known.truncated ? (
        <MenuItem disabled>More people exist than are listed here.</MenuItem>
      ) : null}
    </>
  );
}
