import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { Archive, ArchiveRestore, Folder } from "lucide-react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useContext, useState } from "react";

import { environmentProjects, projectEnvironment, threadCountsAtom } from "../state/projects";
import { CountChip } from "./CountChip";
import { ProjectHeader } from "./ProjectHeader";
import { PillRow } from "./PillRow";
import { SidebarRow } from "./SidebarRow";

// Lines the chip up with the title of a depth-1 row.
const CHIP_INDENT_PX = 8 + 14;
const COLLAPSED_KEY = "board:sidebar:collapsed-projects";

const decodeCollapsed = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

function readCollapsed(): ReadonlySet<string> {
  const stored = localStorage.getItem(COLLAPSED_KEY);
  return new Set(stored === null ? [] : Option.getOrElse(decodeCollapsed(stored), () => []));
}

export function ProjectList() {
  const registry = useContext(RegistryContext);
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const threadCounts = useAtomValue(threadCountsAtom);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    setCollapsed(next);
  };
  const setArchived = (project: (typeof projects)[number], archived: boolean) => {
    setMenuFor(null);
    void runAtomCommand(
      registry,
      projectEnvironment.update,
      { environmentId: project.environmentId, input: { projectId: project.id, archived } },
      { label: archived ? "archive-project" : "restore-project" },
    );
  };

  const visible = projects.filter((project) => project.archivedAt == null);
  const hidden = projects.filter((project) => project.archivedAt != null);
  if (visible.length === 0 && hidden.length === 0) {
    return <p className="px-2 py-1 text-faint">No projects yet</p>;
  }
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto">
      {visible.map((project) => {
        const key = `${project.environmentId}:${project.id}`;
        const open = !collapsed.has(key);
        const counts = threadCounts.get(project.id);
        return (
          <li key={key}>
            <ProjectHeader
              name={project.title}
              open={open}
              onToggle={() => toggle(key)}
              onMenu={() => setMenuFor(menuFor === key ? null : key)}
            />
            {counts && (
              <div className="py-0.5" style={{ paddingLeft: CHIP_INDENT_PX }}>
                <CountChip
                  label={`${counts.total} ${counts.total === 1 ? "thread" : "threads"}`}
                  active={counts.active}
                  open={open}
                />
              </div>
            )}
            {menuFor === key && (
              <SidebarRow
                depth={1}
                icon={<Archive className="size-3.5" />}
                title="Hide project"
                onClick={() => setArchived(project, true)}
              />
            )}
            {open && (
              <SidebarRow
                depth={1}
                icon={<Folder className="size-3.5" />}
                title={project.workspaceRoot}
              />
            )}
          </li>
        );
      })}
      {hidden.length > 0 && (
        <li>
          <PillRow
            count={hidden.length}
            label={`hidden ${hidden.length === 1 ? "project" : "projects"}`}
            onClick={() => setShowHidden((value) => !value)}
          />
        </li>
      )}
      {showHidden &&
        hidden.map((project) => (
          <li key={`${project.environmentId}:${project.id}`}>
            <SidebarRow
              depth={1}
              icon={<ArchiveRestore className="size-3.5" />}
              title={project.title}
              label={`Restore ${project.title}`}
              onClick={() => setArchived(project, false)}
            />
          </li>
        ))}
    </ul>
  );
}
