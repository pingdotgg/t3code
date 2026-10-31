import type { LinearIssue, LinearMilestone, LinearProject, LinearTeam } from "@t3tools/contracts";

import { NO_MILESTONE_ID, type LinearScope } from "./search.ts";

export type LinearJumpTarget =
  | {
      readonly kind: "team";
      readonly id: string;
      readonly label: string;
      readonly scope: LinearScope;
    }
  | {
      readonly kind: "project";
      readonly id: string;
      readonly label: string;
      readonly scope: LinearScope;
    }
  | {
      readonly kind: "milestone";
      readonly id: string;
      readonly label: string;
      readonly scope: LinearScope;
    }
  | {
      readonly kind: "issue";
      readonly id: string;
      readonly label: string;
      readonly identifier: string;
      readonly scope: LinearScope;
    };

const MAX_LOCAL_MATCHES = 6;

/** Where an issue sits in the drill-down, so jumping to it lands in its own milestone list. */
function scopeOfLinearIssue(issue: LinearIssue): LinearScope {
  if (issue.project === null) return { team: issue.team.id };
  return {
    team: issue.team.id,
    project: issue.project.id,
    milestone: issue.milestone?.id ?? NO_MILESTONE_ID,
  };
}

function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

/**
 * Jump-search results: loaded teams, projects and milestones that match, then the server's issue
 * matches (`linear.search`). A project naming no team is placed in `fallbackTeamId`, the open team.
 */
export function buildLinearJumpTargets(
  term: string,
  loaded: {
    readonly teams: ReadonlyArray<LinearTeam>;
    readonly projects: ReadonlyArray<LinearProject>;
    readonly milestones: ReadonlyArray<LinearMilestone>;
    readonly issues: ReadonlyArray<LinearIssue>;
    readonly fallbackTeamId?: string | undefined;
  },
): ReadonlyArray<LinearJumpTarget> {
  const needle = term.trim().toLowerCase();
  if (needle === "") return [];
  const uniqueProjects = [
    ...new Map(loaded.projects.map((project) => [project.id, project])).values(),
  ];
  const projectScopes = new Map<string, LinearScope>();
  for (const project of uniqueProjects) {
    const teamId = project.teamIds[0] ?? loaded.fallbackTeamId;
    if (teamId !== undefined) projectScopes.set(project.id, { team: teamId, project: project.id });
  }
  const teams = loaded.teams
    .filter((team) => matches(team.name, needle) || matches(team.key, needle))
    .slice(0, MAX_LOCAL_MATCHES)
    .map((team): LinearJumpTarget => ({
      kind: "team",
      id: team.id,
      label: `${team.key} · ${team.name}`,
      scope: { team: team.id },
    }));
  const projects = uniqueProjects
    .filter((project) => matches(project.name, needle))
    .slice(0, MAX_LOCAL_MATCHES)
    .flatMap((project): Array<LinearJumpTarget> => {
      const scope = projectScopes.get(project.id);
      return scope === undefined
        ? []
        : [{ kind: "project", id: project.id, label: project.name, scope }];
    });
  const milestones = loaded.milestones
    .filter((milestone) => matches(milestone.name, needle))
    .slice(0, MAX_LOCAL_MATCHES)
    .flatMap((milestone): Array<LinearJumpTarget> => {
      const project = projectScopes.get(milestone.projectId);
      return project === undefined
        ? []
        : [
            {
              kind: "milestone",
              id: milestone.id,
              label: milestone.name,
              scope: { ...project, milestone: milestone.id },
            },
          ];
    });
  const issues = loaded.issues.map((issue): LinearJumpTarget => ({
    kind: "issue",
    id: issue.id,
    identifier: issue.identifier,
    label: issue.title,
    scope: scopeOfLinearIssue(issue),
  }));
  return [...teams, ...projects, ...milestones, ...issues];
}

/** "Nov 14" for a Linear `YYYY-MM-DD` target date; the raw string when unparseable. */
export function formatLinearTargetDate(value: string | null): string | null {
  if (value === null || value === "") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  const date =
    match === null
      ? // @effect-diagnostics-next-line globalDate:off
        new Date(value)
      : // @effect-diagnostics-next-line globalDate:off
        new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
