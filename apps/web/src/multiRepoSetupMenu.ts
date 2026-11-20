import type { ContextMenuItem, EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  deriveMultiRepoKey,
  listMultiRepoProjectsToSetUp,
} from "@t3tools/client-runtime/state/project-grouping";
import { msg } from "gt-react";
import type { CommandPaletteMultiRepoSetup } from "./commandPaletteBus";
import { m } from "./i18n/messages";

/** Whether an environment can clone a multi-repo project from another machine. */
export function canSetUpMultiRepoProjects(
  capabilities:
    | { readonly multiRepoProjects?: boolean; readonly projectCloneTracking?: boolean }
    | undefined,
): boolean {
  return capabilities?.multiRepoProjects === true && capabilities.projectCloneTracking === true;
}

export type MultiRepoSetupMenuId = `multi-repo-setup:${string}`;

export function isMultiRepoSetupMenuId(id: string | null): id is MultiRepoSetupMenuId {
  return id?.startsWith("multi-repo-setup:") === true;
}

/** "Set up on <machine>" items for a project's menu; built only when the menu opens. */
export function buildMultiRepoProjectSetupMenu(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connection: { readonly phase: string };
    readonly serverConfig?: {
      readonly environment: {
        readonly capabilities: {
          readonly multiRepoProjects?: boolean;
          readonly projectCloneTracking?: boolean;
        };
      };
    } | null;
  }>;
}) {
  const projectKeys = new Set(
    input.projects
      .filter((project) =>
        input.projectRefs.some(
          (ref) => ref.environmentId === project.environmentId && ref.projectId === project.id,
        ),
      )
      .flatMap((project) => {
        const key = deriveMultiRepoKey(project.multiRepo);
        return key === null ? [] : [key];
      }),
  );
  const setupsByAction = new Map<MultiRepoSetupMenuId, CommandPaletteMultiRepoSetup>();
  const items: Array<ContextMenuItem<MultiRepoSetupMenuId>> = [];
  if (projectKeys.size === 0) return { items, setupsByAction };
  for (const environment of input.environments) {
    if (
      environment.connection.phase !== "connected" ||
      !canSetUpMultiRepoProjects(environment.serverConfig?.environment.capabilities)
    ) {
      continue;
    }
    const setup = listMultiRepoProjectsToSetUp(input.projects, environment.environmentId).find(
      (candidate) => projectKeys.has(candidate.key),
    );
    if (!setup) continue;
    const id: MultiRepoSetupMenuId = `multi-repo-setup:${environment.environmentId}`;
    setupsByAction.set(id, { environmentId: environment.environmentId, setup });
    items.push({
      id,
      label: m(msg("Set up on {environment}", { environment: environment.label })),
      icon: "folder",
    });
  }
  const menuItems: ReadonlyArray<ContextMenuItem<MultiRepoSetupMenuId>> =
    items.length > 1
      ? [
          {
            id: "multi-repo-setup:submenu",
            label: m(msg("Set up on...")),
            icon: "folder",
            children: items,
          },
        ]
      : items;
  return { items: menuItems, setupsByAction };
}
