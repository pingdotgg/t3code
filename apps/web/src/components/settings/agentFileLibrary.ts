import type { AgentFileSyncLink, AgentFileSyncSection, EnvironmentId } from "@t3tools/contracts";

export interface AgentFileLocation {
  id: string;
  environmentId: EnvironmentId;
  label: string;
  cwd?: string;
}

export interface AgentLibraryResource {
  kind: "skill" | "instructions";
  path: string;
  name: string;
  location: AgentFileLocation;
  contents?: string;
  unavailable?: boolean;
  sections: readonly AgentFileSyncSection[];
}

export interface AgentFileShare {
  environmentId: EnvironmentId;
  environmentLabel: string;
  sourceLabel: string;
  link: AgentFileSyncLink;
}

export function resourceShares(resource: AgentLibraryResource, shares: readonly AgentFileShare[]) {
  const includesResource = (link: AgentFileSyncLink) =>
    resource.kind === "skill"
      ? link.selection.skills.includes(resource.path)
      : link.selection.instructions.some((file) => file.path === resource.path);
  return {
    incoming: shares.filter(
      ({ environmentId, link }) =>
        environmentId === resource.location.environmentId &&
        link.scope.cwd === resource.location.cwd &&
        includesResource(link),
    ),
    outgoing: shares.filter(
      ({ link }) =>
        link.sourceEnvironmentId === resource.location.environmentId &&
        link.selection.cwd === resource.location.cwd &&
        includesResource(link),
    ),
  };
}

export const resourceKey = (resource: AgentLibraryResource) =>
  `${resource.location.id}:${resource.kind}:${resource.path}`;

export const resourceScopeLabel = (location: AgentFileLocation) =>
  location.cwd ? "Project" : "Global";

export const locationLabel = (location: AgentFileLocation) =>
  location.cwd
    ? `${location.label} · ${location.cwd.split(/[\\/]/).filter(Boolean).slice(-2).join("/")}`
    : location.label;
