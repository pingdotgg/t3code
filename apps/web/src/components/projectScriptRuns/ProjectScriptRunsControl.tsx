import { HistoryIcon, PlayIcon } from "lucide-react";
import { useState } from "react";

import { isProjectScriptRunActive, projectScriptRunStatusLabel } from "../../projectScriptRuns";
import {
  useProjectScriptMenuEntries,
  useProjectScriptRunActions,
} from "../../hooks/useProjectScriptRuns";
import { projectScriptMenuLabel } from "@t3tools/shared/projectScripts";
import { ProjectFavicon } from "../ProjectFavicon";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { Button } from "../ui/button";
import { ProjectScriptRunStatusIcon } from "./ProjectScriptRunStatusIcon";
import { useProjectScriptRunsStore } from "../../projectScriptRunsStore";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

export function ProjectScriptRunsControl() {
  const activeRunCount = useProjectScriptRunsStore(
    (state) => Object.values(state.runs).filter(isProjectScriptRunActive).length,
  );
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <Menu open={menuOpen} onOpenChange={setMenuOpen}>
      <MenuTrigger
        render={<SidebarHeaderIconButton label="Project actions" className="overflow-visible" />}
      >
        <PlayIcon className="size-4" />
        {activeRunCount > 0 ? (
          <span className="pointer-events-none absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-3xs font-semibold text-primary-foreground">
            {activeRunCount}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup
        align="end"
        className="max-h-[min(70vh,36rem)] w-48 max-w-[calc(100vw_-_2rem)] overflow-y-auto"
      >
        <ProjectScriptRunsMenu onClose={() => setMenuOpen(false)} />
      </MenuPopup>
    </Menu>
  );
}

function ProjectScriptRunsMenu({ onClose }: { readonly onClose: () => void }) {
  const { entries, showEnvironmentLabel } = useProjectScriptMenuEntries();
  const { runsList, runScript, stopRun, selectRun } = useProjectScriptRunActions();

  if (entries.length === 0) {
    return (
      <MenuGroup>
        <MenuGroupLabel>Project actions</MenuGroupLabel>
        <p className="px-2 pb-2 text-sm text-pretty text-muted-foreground">
          No project actions configured. Add them in Settings, Projects, Actions.
        </p>
      </MenuGroup>
    );
  }

  return entries.map((entry, index) => {
    const projectKey = `${entry.project.environmentId}:${entry.project.id}`;
    return (
      <MenuGroup key={projectKey}>
        {index > 0 ? <MenuSeparator /> : null}
        <MenuGroupLabel>
          <span className="flex min-w-0 items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <ProjectFavicon project={entry.project} className="size-4 shrink-0" />
              <span className="truncate">{entry.project.title}</span>
            </span>
            {showEnvironmentLabel && entry.environmentLabel.length > 0 ? (
              <span className="truncate text-2xs font-normal text-muted-foreground">
                {entry.environmentLabel}
              </span>
            ) : null}
          </span>
        </MenuGroupLabel>
        {entry.scripts.map((script) => {
          const activeRun = runsList.find(
            (run) =>
              run.environmentId === entry.project.environmentId &&
              run.projectId === entry.project.id &&
              run.scriptId === script.id &&
              isProjectScriptRunActive(run),
          );
          const latestRun = runsList
            .filter(
              (run) =>
                run.environmentId === entry.project.environmentId &&
                run.projectId === entry.project.id &&
                run.scriptId === script.id &&
                !isProjectScriptRunActive(run),
            )
            .sort((left, right) => right.startedAt - left.startedAt)[0];
          const canRun = entry.canOperate;
          return (
            <MenuItem
              key={`${projectKey}:${script.id}`}
              disabled={!canRun}
              onClick={() => {
                if (activeRun !== undefined) void stopRun(activeRun);
                else void runScript(entry.project, script, entry.anchorThread);
              }}
            >
              <MenuItemLabel>{projectScriptMenuLabel(script)}</MenuItemLabel>
              <span className="ms-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                {activeRun !== undefined ? (
                  <span>{projectScriptRunStatusLabel(activeRun.status)}</span>
                ) : null}
                <ProjectScriptRunStatusIcon
                  status={activeRun?.status ?? latestRun?.status ?? null}
                  className={activeRun !== undefined ? "size-3.5 text-destructive" : undefined}
                />
                {activeRun === undefined && latestRun !== undefined ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-micro"
                    aria-label={`Recent runs of ${script.name}`}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onClose();
                      selectRun(latestRun.id);
                    }}
                  >
                    <HistoryIcon className="size-3" />
                  </Button>
                ) : null}
              </span>
            </MenuItem>
          );
        })}
      </MenuGroup>
    );
  });
}
