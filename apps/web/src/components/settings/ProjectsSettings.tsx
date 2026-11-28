import { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import {
  FolderOpenIcon,
  FolderPlusIcon,
  GitBranchIcon,
  LayersIcon,
  MessageSquareDashedIcon,
  PencilIcon,
  PlayIcon,
} from "lucide-react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useScratchProject } from "../../hooks/useScratchProject";
import { usePrimaryEnvironmentId } from "../../state/environments";

import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectActionsSettings } from "./ProjectActionsSettings";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingsEmptyState,
  SettingsEmptyTile,
  SettingsEmptyTiles,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import {
  ALL_ENVIRONMENTS_VALUE,
  projectScopeMenuGroups,
  selectEnvironmentAxis,
  selectProjectAxis,
} from "./settingsScopeAxis";

export function ProjectsSettings() {
  const { search: value, scope, selectScope } = useSettingsScope();
  const unavailable =
    scope.kind === "unavailable" ? (
      <SettingsPageContainer>
        <div className="flex flex-col items-start gap-3">
          <p className="text-body text-muted-foreground">{scope.message}</p>
          {value.machine || value.checkout ? (
            <Button
              variant="secondary"
              size="xs"
              onClick={() => selectScope(selectEnvironmentAxis(value, ALL_ENVIRONMENTS_VALUE))}
            >
              <LayersIcon />
              <T>Show all environments</T>
            </Button>
          ) : null}
        </div>
        <ImportProjectsSection />
      </SettingsPageContainer>
    ) : null;
  // Keep the panel mounted so it can follow members when regrouping changes the project key.
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {value.project && projectScope ? (
        <ProjectSettingsPanel
          projectKey={value.project}
          environmentId={value.machine ? EnvironmentId.make(value.machine) : null}
          checkoutKey={value.checkout ?? null}
          unavailable={unavailable}
          header={<ImportProjectsSection />}
        />
      ) : unavailable ? (
        unavailable
      ) : (
        <ProjectChooser />
      )}
    </div>
  );
}

/** Environment-wide, so it sits in each page state's column after that state's primary content. */
function ImportProjectsSection() {
  const gt = useGT();
  const { environment } = useSettingsScope();
  if (!environment) return null;
  const title = gt("Import projects and their threads");
  return (
    <SettingsSection title={title} hideTitle className="w-full text-left">
      <SettingsRow
        title={title}
        description={environment.label}
        control={
          <Button
            size="sm"
            variant="secondary"
            render={<Link to="/welcome" hash={`projects:${environment.environmentId}`} />}
          >
            <T context="verb, opens a page">Open</T>
          </Button>
        }
      />
    </SettingsSection>
  );
}

const SKELETON_LINES = (
  <span aria-hidden className="mt-2 flex flex-col gap-1.5">
    <span className="h-1.5 w-full rounded-full surface-raised" />
    <span className="h-1.5 w-3/5 rounded-full surface-raised" />
  </span>
);

function AddProjectButton({ primary = false }: { primary?: boolean }) {
  return (
    <Button
      size="standard"
      variant={primary ? "default" : "secondary"}
      onClick={() => openCommandPalette({ open: "add-project" })}
    >
      <FolderPlusIcon />
      <T>Add project</T>
    </Button>
  );
}

/** With no project in scope: every project to pick from, or what a project holds when there are none. */
function ProjectChooser() {
  const gt = useGT();
  const { search, selectScope } = useSettingsScope();
  const groups = projectScopeMenuGroups(useSettingsProjectGroups(), search);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const scratchTarget = scratchEnvironmentId(primaryEnvironmentId);
  if (groups.length === 0) {
    return (
      <SettingsPageContainer centered className="max-w-[648px] gap-4">
        <SettingsEmptyState
          icon={<FolderOpenIcon />}
          title={gt("No projects yet")}
          description={gt(
            "A project is a folder T3 Code works in. Add one to set its name, icon, checkouts and actions here.",
          )}
        >
          <div className="flex flex-wrap justify-center gap-2">
            <AddProjectButton primary />
            {scratchTarget !== null ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void startScratchThread(scratchTarget)}
              >
                <MessageSquareDashedIcon />
                <T>Chat without a project</T>
              </Button>
            ) : null}
          </div>
          <ImportProjectsSection />
          <SettingsEmptyTiles title={gt("What you'll set for each project")}>
            <SettingsEmptyTile
              icon={<PencilIcon />}
              title={gt("Name and icon")}
              description={gt("Shown in the sidebar")}
            >
              {SKELETON_LINES}
            </SettingsEmptyTile>
            <SettingsEmptyTile
              icon={<GitBranchIcon />}
              title={gt("Checkouts")}
              description={gt("One per machine")}
            >
              {SKELETON_LINES}
            </SettingsEmptyTile>
            <SettingsEmptyTile
              icon={<PlayIcon />}
              title={gt("Actions")}
              description={gt("Dev server, typecheck…")}
            >
              {SKELETON_LINES}
            </SettingsEmptyTile>
          </SettingsEmptyTiles>
        </SettingsEmptyState>
        <ProjectActionsSettings />
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer centered className="max-w-[648px] gap-4">
      <SettingsEmptyState
        icon={<FolderOpenIcon />}
        title={gt("Choose a project")}
        description={gt("Choose a project to manage its name, icon, checkouts and actions.")}
      >
        <AddProjectButton />
      </SettingsEmptyState>
      <ImportProjectsSection />
      <SettingsSection title={gt("Your projects")}>
        <div className="p-1">
          {groups.map((group) => {
            const location =
              group.memberProjects.length === 1
                ? group.memberProjects[0]?.workspaceRoot
                : gt("{count, plural, one {{count} checkout} other {{count} checkouts}}", {
                    count: group.memberProjects.length,
                  });
            return (
              <Tooltip key={group.projectKey}>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      className="w-full justify-start"
                      aria-label={gt("Open {project} settings", { project: group.displayName })}
                      onClick={() => selectScope(selectProjectAxis(search, group.projectKey))}
                    />
                  }
                >
                  <ProjectFavicon project={group} className="size-4 shrink-0" />
                  <span className="min-w-0 truncate text-label">{group.displayName}</span>
                  <span className="min-w-0 flex-1 truncate text-left text-meta text-dim-foreground">
                    {location}
                  </span>
                </TooltipTrigger>
                <TooltipPopup side="top">
                  <span className="flex flex-col gap-0.5">
                    <span>{group.displayName}</span>
                    <span>{location}</span>
                  </span>
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </div>
      </SettingsSection>
      <ProjectActionsSettings />
    </SettingsPageContainer>
  );
}
