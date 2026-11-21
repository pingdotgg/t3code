import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { homeThreads, withoutHomeProjects, withoutHomeThreads } from "./homeSidebar.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const thread = (environmentId: EnvironmentId, id: string, projectId: string, under?: string) => ({
  environmentId,
  id: ThreadId.make(id),
  projectId: ProjectId.make(projectId),
  groupedUnderThreadId: under === undefined ? null : ThreadId.make(under),
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
    thread(local, "crew", "app", "home:abc"),
  ];

  it("moves Home and its crew to the Home entry and keeps the list untouched without them", () => {
    expect(withoutHomeThreads(threads).map((entry) => entry.id)).toEqual(["t1", "t2"]);
    expect(homeThreads(threads).map((entry) => entry.id)).toEqual(["home:abc", "crew"]);
    const plain = threads.slice(1, 3);
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
