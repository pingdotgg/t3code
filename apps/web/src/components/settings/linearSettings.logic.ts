import type { LinearMapping, LinearProject, LinearTeam, ProjectId } from "@t3tools/contracts";

export interface LinearMappingDraft {
  readonly kind: LinearMapping["kind"];
  readonly linearId: string;
  readonly linearName: string;
  readonly projectId: ProjectId;
  readonly baseBranch: string;
}

export interface LinearMappingRow {
  readonly key: string;
  readonly kind: LinearMapping["kind"];
  readonly linearId: string;
  readonly name: string;
  /** Team key for team rows. */
  readonly teamKey: string | null;
  /** The team a project belongs to, for "Plaudern in JanJaap". */
  readonly parentTeamName: string | null;
  readonly mapping: LinearMapping | null;
}

/** Mapped targets in saved order, then the viewer's teams that still ask each time. */
export function buildLinearMappingRows(input: {
  readonly teams: ReadonlyArray<LinearTeam>;
  readonly projects: ReadonlyArray<LinearProject>;
  readonly mappings: ReadonlyArray<LinearMapping>;
}): ReadonlyArray<LinearMappingRow> {
  const teamsById = new Map(input.teams.map((team) => [team.id, team] as const));
  const projectsById = new Map(input.projects.map((project) => [project.id, project] as const));
  const mappedRows = input.mappings.map((mapping): LinearMappingRow => {
    if (mapping.kind === "team") {
      const team = teamsById.get(mapping.linearId);
      return {
        key: mapping.id,
        kind: "team",
        linearId: mapping.linearId,
        name: team?.name ?? mapping.linearName,
        teamKey: team?.key ?? null,
        parentTeamName: null,
        mapping,
      };
    }
    const project = projectsById.get(mapping.linearId);
    const parentTeam = project?.teamIds.map((id) => teamsById.get(id)).find((team) => team);
    return {
      key: mapping.id,
      kind: "project",
      linearId: mapping.linearId,
      name: project?.name ?? mapping.linearName,
      teamKey: null,
      parentTeamName: parentTeam?.name ?? null,
      mapping,
    };
  });
  const mappedTeamIds = new Set(
    input.mappings.filter((mapping) => mapping.kind === "team").map((mapping) => mapping.linearId),
  );
  const unmappedTeamRows = input.teams
    .filter((team) => !mappedTeamIds.has(team.id))
    .map((team): LinearMappingRow => ({
      key: `team:${team.id}`,
      kind: "team",
      linearId: team.id,
      name: team.name,
      teamKey: team.key,
      parentTeamName: null,
      mapping: null,
    }));
  return [...mappedRows, ...unmappedTeamRows];
}

/** Adds or replaces a mapping. One mapping per Linear target: re-mapping a target replaces it. */
export function upsertLinearMapping(
  mappings: ReadonlyArray<LinearMapping>,
  draft: LinearMappingDraft,
  newId: () => string,
): ReadonlyArray<LinearMapping> {
  const baseBranch = draft.baseBranch.trim();
  const existing = mappings.find(
    (mapping) => mapping.kind === draft.kind && mapping.linearId === draft.linearId,
  );
  const next: LinearMapping = {
    id: existing?.id ?? newId(),
    kind: draft.kind,
    linearId: draft.linearId,
    linearName: draft.linearName,
    projectId: draft.projectId,
    ...(baseBranch.length > 0 ? { baseBranch } : {}),
  };
  return existing === undefined
    ? [...mappings, next]
    : mappings.map((mapping) => (mapping.id === existing.id ? next : mapping));
}

export function removeLinearMapping(
  mappings: ReadonlyArray<LinearMapping>,
  id: string,
): ReadonlyArray<LinearMapping> {
  return mappings.filter((mapping) => mapping.id !== id);
}

/** The state the "Move issue" picker defaults to and names: the team's first started state. */
export function firstStartedStateName(
  states: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly position: number;
  }>,
): string | null {
  return (
    states
      .filter((state) => state.type === "started")
      .toSorted((left, right) => left.position - right.position)[0]?.name ?? null
  );
}
