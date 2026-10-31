import { EnvironmentId } from "@t3tools/contracts";
import {
  ChevronRightIcon,
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
import { ALL_ENVIRONMENTS_VALUE, selectEnvironmentAxis } from "./settingsScopeAxis";

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
              Show all environments
            </Button>
          ) : null}
        </div>
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
        />
      ) : unavailable ? (
        unavailable
      ) : (
        <ProjectChooser />
      )}
    </div>
  );
}

const SKELETON_LINES = (
  <span aria-hidden className="mt-2 flex flex-col gap-1.5">
    <span className="h-1.5 w-full rounded-full surface-raised" />
    <span className="h-1.5 w-3/5 rounded-full surface-raised" />
  </span>
);

function AddProjectButton() {
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => openCommandPalette({ open: "add-project" })}
    >
      <FolderPlusIcon />
      Add project
    </Button>
  );
}

/** With no project in scope: every project to pick from, or what a project holds when there are none. */
function ProjectChooser() {
  const { selectScope } = useSettingsScope();
  const groups = useSettingsProjectGroups();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const scratchTarget = scratchEnvironmentId(primaryEnvironmentId);
  if (groups.length === 0) {
    return (
      <SettingsPageContainer centered>
        <SettingsEmptyState
          icon={<FolderOpenIcon />}
          title="No projects yet"
          description="A project is a folder T3 Code works in. Add one to set its name, icon, checkouts and actions here."
        >
          <div className="flex flex-wrap justify-center gap-2">
            <AddProjectButton />
            {scratchTarget !== null ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void startScratchThread(scratchTarget)}
              >
                <MessageSquareDashedIcon />
                Chat without a project
              </Button>
            ) : null}
          </div>
          <SettingsEmptyTiles title="What you'll set for each project">
            <SettingsEmptyTile
              icon={<PencilIcon />}
              title="Name and icon"
              description="Shown in the sidebar"
            >
              {SKELETON_LINES}
            </SettingsEmptyTile>
            <SettingsEmptyTile
              icon={<GitBranchIcon />}
              title="Checkouts"
              description="One per machine"
            >
              {SKELETON_LINES}
            </SettingsEmptyTile>
            <SettingsEmptyTile
              icon={<PlayIcon />}
              title="Actions"
              description="Dev server, typecheck…"
            >
              {SKELETON_LINES}
            </SettingsEmptyTile>
          </SettingsEmptyTiles>
        </SettingsEmptyState>
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer centered>
      <SettingsEmptyState
        icon={<FolderOpenIcon />}
        title="Choose a project"
        description="Choose a project to manage its name, icon, checkouts and actions."
      >
        <AddProjectButton />
      </SettingsEmptyState>
      <SettingsSection title="Your projects">
        {groups.map((group) => {
          const open = () => selectScope({ project: group.projectKey });
          return (
            // The whole row opens the project; the chevron only marks it as navigation.
            <SettingsRow
              key={group.projectKey}
              role="button"
              tabIndex={0}
              aria-label={`Open ${group.displayName} settings`}
              className="cursor-pointer outline-none first:rounded-t-card! last:rounded-b-card! hover:surface-ghost-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={open}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                open();
              }}
              leading={<ProjectFavicon project={group} className="size-4" />}
              title={group.displayName}
              description={group.memberProjects
                .map((member) => member.environmentLabel ?? member.workspaceRoot)
                .join(" · ")}
              trailing={
                <span
                  aria-hidden
                  className="inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground"
                >
                  <ChevronRightIcon className="size-3.5" />
                </span>
              }
            />
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
