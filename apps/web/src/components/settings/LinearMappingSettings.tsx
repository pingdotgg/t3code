import type { LinearConnectionStatus, LinearMapping, ProjectId } from "@t3tools/contracts";
import { ArrowRightIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { LinearTeamBadge } from "../linear/linearIcons";
import { LinearProjectSelect } from "../linear/LinearProjectSelect";
import { useLinearEnvironmentId, useLinearProjects } from "../linear/useLinearData";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  buildLinearMappingRows,
  removeLinearMapping,
  upsertLinearMapping,
  type LinearMappingDraft,
  type LinearMappingRow,
} from "./linearSettings.logic";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const ROW_GRID =
  "grid grid-cols-[minmax(0,1.4fr)_1rem_minmax(0,1.2fr)_5.5rem_2rem] items-center gap-3 px-4 max-sm:grid-cols-[minmax(0,1fr)_2rem] max-sm:gap-y-1.5";

export function LinearMappingSettings({ status }: { readonly status: LinearConnectionStatus }) {
  const environmentId = useLinearEnvironmentId();
  if (environmentId === null) return null;
  return <MappingSection environmentId={environmentId} status={status} />;
}

type DialogState =
  | null
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly row: LinearMappingRow };

function MappingSection({
  environmentId,
  status,
}: {
  readonly environmentId: NonNullable<ReturnType<typeof useLinearEnvironmentId>>;
  readonly status: LinearConnectionStatus;
}) {
  const mappings = useEnvironmentSettings(environmentId, (settings) => settings.linear.mappings);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const linearProjects = useLinearProjects(undefined).data ?? [];
  const t3Projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [dialog, setDialog] = useState<DialogState>(null);

  const rows = buildLinearMappingRows({
    teams: status.teams,
    projects: linearProjects,
    mappings,
  });
  const save = (next: ReadonlyArray<LinearMapping>) =>
    updateSettings({ linear: { mappings: next } });
  const setProject = (row: LinearMappingRow, projectId: ProjectId) =>
    save(
      upsertLinearMapping(
        mappings,
        {
          kind: row.kind,
          linearId: row.linearId,
          linearName: row.name,
          projectId,
          baseBranch: row.mapping?.baseBranch ?? "",
        },
        randomUUID,
      ),
    );

  return (
    <>
      <SettingsSection
        {...searchableSetting("linear-mapping")}
        title="Project mapping"
        headerAction={
          <Button size="xs" variant="outline" onClick={() => setDialog({ mode: "add" })}>
            <PlusIcon aria-hidden className="size-3" />
            Add mapping
          </Button>
        }
      >
        <p className="px-4 pt-3 pb-2 text-xs text-muted-foreground">
          Pick which T3 project an issue opens in. A project mapping wins over its team&apos;s
          mapping. Unmapped issues ask each time.
        </p>
        <div
          className={`${ROW_GRID} pb-1.5 text-2xs font-medium text-muted-foreground max-sm:hidden`}
        >
          <span>Linear</span>
          <span />
          <span>T3 project</span>
          <span>Base branch</span>
          <span />
        </div>
        {rows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">No teams are visible yet.</p>
        ) : (
          rows.map((row) => (
            <div key={row.key} className={`${ROW_GRID} min-h-12 py-2`}>
              <div className="flex min-w-0 items-center gap-2 text-sm max-sm:row-start-1">
                {row.teamKey ? <LinearTeamBadge teamKey={row.teamKey} /> : null}
                <span className="truncate font-medium text-foreground">{row.name}</span>
                {row.kind === "project" ? (
                  <>
                    {row.parentTeamName ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        in {row.parentTeamName}
                      </span>
                    ) : null}
                    <span className="shrink-0 rounded bg-muted px-1.5 py-px text-2xs text-muted-foreground">
                      Project
                    </span>
                  </>
                ) : (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-px text-2xs text-muted-foreground">
                    Team
                  </span>
                )}
              </div>
              <ArrowRightIcon
                aria-hidden
                className="size-3.5 text-muted-foreground max-sm:hidden"
              />
              <div className="min-w-0 max-sm:col-start-1 max-sm:row-start-2">
                {row.mapping ? (
                  <LinearProjectSelect
                    projects={t3Projects}
                    value={row.mapping.projectId}
                    onValueChange={(projectId) => void setProject(row, projectId)}
                    aria-label={`T3 project for ${row.name}`}
                  />
                ) : (
                  <span className="text-sm text-muted-foreground">Ask each time</span>
                )}
              </div>
              <span className="font-mono text-xs text-muted-foreground max-sm:col-start-1 max-sm:row-start-3 max-sm:empty:hidden">
                {row.mapping ? (
                  <>
                    <span className="font-sans sm:hidden">Base branch </span>
                    {row.mapping.baseBranch ?? "default"}
                  </>
                ) : null}
              </span>
              <div className="max-sm:col-start-2 max-sm:row-start-1">
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={`Actions for ${row.name}`}
                      />
                    }
                  >
                    <MoreHorizontalIcon aria-hidden />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem onClick={() => setDialog({ mode: "edit", row })}>
                      {row.mapping ? "Edit mapping" : "Map to a T3 project"}
                    </MenuItem>
                    {row.mapping ? (
                      <MenuItem
                        variant="destructive"
                        onClick={() => void save(removeLinearMapping(mappings, row.mapping!.id))}
                      >
                        Remove mapping
                      </MenuItem>
                    ) : null}
                  </MenuPopup>
                </Menu>
              </div>
            </div>
          ))
        )}
      </SettingsSection>
      {dialog !== null ? (
        <MappingDialog
          key={dialog.mode === "edit" ? dialog.row.key : "add"}
          state={dialog}
          status={status}
          linearProjects={linearProjects}
          t3Projects={t3Projects}
          onClose={() => setDialog(null)}
          onSave={(draft) => {
            void save(upsertLinearMapping(mappings, draft, randomUUID));
            setDialog(null);
          }}
        />
      ) : null}
    </>
  );
}

function MappingDialog({
  state,
  status,
  linearProjects,
  t3Projects,
  onClose,
  onSave,
}: {
  readonly state: NonNullable<DialogState>;
  readonly status: LinearConnectionStatus;
  readonly linearProjects: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly t3Projects: ReturnType<typeof useProjects>;
  readonly onClose: () => void;
  readonly onSave: (draft: LinearMappingDraft) => void;
}) {
  const editing = state.mode === "edit" ? state.row : null;
  const [target, setTarget] = useState<string | null>(
    editing ? `${editing.kind}:${editing.linearId}` : null,
  );
  const [projectId, setProjectId] = useState<ProjectId | null>(editing?.mapping?.projectId ?? null);
  const [baseBranch, setBaseBranch] = useState(editing?.mapping?.baseBranch ?? "");

  const resolveTarget = (value: string | null) => {
    if (value === null) return null;
    const separator = value.indexOf(":");
    const kind = value.slice(0, separator);
    const id = value.slice(separator + 1);
    if (kind === "team") {
      const team = status.teams.find((candidate) => candidate.id === id);
      return team ? { kind: "team" as const, linearId: id, name: team.name } : null;
    }
    const project = linearProjects.find((candidate) => candidate.id === id);
    return project ? { kind: "project" as const, linearId: id, name: project.name } : null;
  };
  const resolved = editing
    ? { kind: editing.kind, linearId: editing.linearId, name: editing.name }
    : resolveTarget(target);
  const canSave = resolved !== null && projectId !== null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing?.mapping ? "Edit mapping" : "Add mapping"}</DialogTitle>
          <DialogDescription>
            Issues from this Linear team or project open in the T3 project you pick.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <div className="space-y-1">
              <span className="text-xs font-medium text-foreground">Linear team or project</span>
              {editing ? (
                <p className="text-sm text-foreground">{editing.name}</p>
              ) : (
                <Select value={target} onValueChange={setTarget}>
                  <SelectTrigger aria-label="Linear team or project">
                    <SelectValue>
                      {() => (
                        <span className="truncate">
                          {resolved?.name ?? "Choose a team or project"}
                        </span>
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    <SelectGroup>
                      <SelectGroupLabel>Teams</SelectGroupLabel>
                      {status.teams.map((team) => (
                        <SelectItem key={team.id} value={`team:${team.id}`}>
                          {team.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    {linearProjects.length > 0 ? (
                      <SelectGroup>
                        <SelectGroupLabel>Projects</SelectGroupLabel>
                        {linearProjects.map((project) => (
                          <SelectItem key={project.id} value={`project:${project.id}`}>
                            {project.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ) : null}
                  </SelectPopup>
                </Select>
              )}
            </div>
            <div className="space-y-1">
              <span className="text-xs font-medium text-foreground">T3 project</span>
              <LinearProjectSelect
                projects={t3Projects}
                value={projectId}
                onValueChange={setProjectId}
                size="default"
                className="w-full"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="linear-base-branch" className="text-xs font-medium text-foreground">
                Base branch
              </label>
              <Input
                id="linear-base-branch"
                font="mono"
                placeholder="Project default"
                value={baseBranch}
                onChange={(event) => setBaseBranch(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                New worktrees for these issues start from this branch.
              </p>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSave}
            onClick={() => {
              if (resolved === null || projectId === null) return;
              onSave({
                kind: resolved.kind,
                linearId: resolved.linearId,
                linearName: resolved.name,
                projectId,
                baseBranch,
              });
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
