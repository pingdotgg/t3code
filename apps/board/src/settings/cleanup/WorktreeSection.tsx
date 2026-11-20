import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

import { projectWorktreesAtom } from "../../state/projects";
import { SettingsSection } from "../SettingsSection";
import { ProjectWorktrees } from "./ProjectWorktrees";

export function WorktreeSection({
  project,
  projects,
  removedPaths,
}: {
  project: EnvironmentProject | null;
  projects: ReadonlyArray<EnvironmentProject>;
  removedPaths: ReadonlySet<string>;
}) {
  const known = useAtomValue(projectWorktreesAtom);
  const shown = (project === null ? projects : [project]).filter(
    (entry) => (known.get(entry.id)?.length ?? 0) > 0,
  );
  return (
    <SettingsSection title="Delete a worktree">
      {shown.length === 0 && <p className="px-3 py-2.5 text-xs text-faint">No worktrees in use.</p>}
      {shown.map((entry) => (
        <ProjectWorktrees
          key={entry.id}
          project={entry}
          titled={project === null}
          removedPaths={removedPaths}
        />
      ))}
    </SettingsSection>
  );
}
