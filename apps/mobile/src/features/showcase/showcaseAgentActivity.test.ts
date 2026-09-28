import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { buildShowcaseAgentActivity } from "./showcaseAgentActivity";

const NOW = Date.parse("2026-07-16T09:00:00.000Z");

const project = (environmentId: string, id: string, title: string) =>
  ({
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title,
  }) as EnvironmentProject;

const thread = (environmentId: string, id: string, projectId: string, title: string) =>
  ({
    environmentId: EnvironmentId.make(environmentId),
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title,
  }) as EnvironmentThreadShell;

const projects = [
  project("moonbase-terminal", "t3code", "T3 Code"),
  project("suspense-station", "react", "React"),
  project("kernel-cabin", "linux", "Linux"),
];

const threads = [
  thread("moonbase-terminal", "remote-command-center", "t3code", "Make remote coding feel local"),
  thread(
    "moonbase-terminal",
    "pocket-command-center",
    "t3code",
    "Put the command center in your pocket",
  ),
  thread("suspense-station", "buttery-suspense", "react", "Make Suspense transitions buttery"),
  thread("kernel-cabin", "beautiful-boot", "linux", "Make boot logs oddly beautiful"),
];

it("waits until every staged thread and its project have loaded", () => {
  assert.isNull(buildShowcaseAgentActivity(threads.slice(1), projects, NOW));
  assert.isNull(buildShowcaseAgentActivity(threads, projects.slice(0, 2), NOW));
  assert.isNotNull(buildShowcaseAgentActivity(threads, projects, NOW));
});
