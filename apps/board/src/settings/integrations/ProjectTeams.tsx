import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type IssueTrackerConnection,
  type IssueTrackerConnectionList,
  IssueTrackerKind,
} from "@t3tools/contracts";
import { useContext, useState } from "react";

import { issueTrackerEnvironment } from "../../state/issues";
import { environmentProjects } from "../../state/projects";
import { Select } from "../controls/Select";
import { failureText } from "../failureText";
import { subordinateRow } from "./IntegrationCard";

const UNBOUND = "";

export function ProjectTeams({
  environmentId,
  tracker,
  bindings,
}: {
  environmentId: EnvironmentId;
  tracker: IssueTrackerConnection;
  bindings: IssueTrackerConnectionList["bindings"];
}) {
  const registry = useContext(RegistryContext);
  const projects = useAtomValue(environmentProjects.projectsAtom).filter(
    (project) => project.environmentId === environmentId && project.archivedAt == null,
  );
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  if (projects.length === 0 || tracker.scopes.length === 0) return null;

  const options = [
    { value: UNBOUND, title: `No ${tracker.scopeNoun}` },
    ...tracker.scopes.map((scope) => ({ value: scope.key, title: `${scope.name} (${scope.key})` })),
  ];
  const bind = async (projectId: (typeof projects)[number]["id"], scope: string) => {
    setPending(projectId);
    setFailure(null);
    const result = await runAtomCommand(
      registry,
      issueTrackerEnvironment.bindProject,
      {
        environmentId,
        input: {
          projectId,
          binding:
            scope === UNBOUND ? null : { tracker: IssueTrackerKind.make(tracker.tracker), scope },
        },
      },
      { reportFailure: false },
    );
    setPending(null);
    if (result._tag !== "Success") setFailure(failureText(result));
  };

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted">
        Pick the {tracker.scopeNoun} whose issues each project lists beside its repository's own.
      </p>
      {projects.map((project) => {
        const bound = bindings[project.id];
        const value = bound?.tracker === tracker.tracker ? bound.scope : UNBOUND;
        return (
          <div key={project.id} className={subordinateRow}>
            <span className="min-w-0 flex-1 truncate text-sm text-fg">{project.title}</span>
            <Select
              label={`${tracker.displayName} ${tracker.scopeNoun} for ${project.title}`}
              value={value}
              options={options}
              disabled={pending === project.id}
              onChange={(next) => void bind(project.id, next)}
            />
          </div>
        );
      })}
      {failure !== null && (
        <p role="alert" className="text-xs break-words text-red-400">
          {failure}
        </p>
      )}
    </div>
  );
}
