import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withoutHomeProjects, withoutHomeThreads } from "./homeSidebar.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const thread = (environmentId: EnvironmentId, id: string, projectId: string) => ({
  environmentId,
  id: ThreadId.make(id),
  projectId: ProjectId.make(projectId),
});
const project = (environmentId: EnvironmentId, id: string) => ({
  environmentId,
  id: ProjectId.make(id),
});

describe("Home in the sidebar", () => {
  const threads = [
    thread(local, "home:abc", "home-project"),
    thread(local, "t1", "app"),
    thread(remote, "t2", "home-project"),
  ];

  it("drops Home threads and keeps the list untouched without one", () => {
    expect(withoutHomeThreads(threads).map((entry) => entry.id)).toEqual(["t1", "t2"]);
    const plain = threads.slice(1);
    expect(withoutHomeThreads(plain)).toBe(plain);
  });

  it("drops only the project that holds Home in that environment", () => {
    const projects = [
      project(local, "home-project"),
      project(local, "app"),
      project(remote, "home-project"),
    ];
    expect(withoutHomeProjects(projects, threads)).toEqual([
      project(local, "app"),
      project(remote, "home-project"),
    ]);
  });
});
