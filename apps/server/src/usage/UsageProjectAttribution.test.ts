import { ProjectId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { projectsBySession, sessionKey } from "./UsageProjectAttribution.ts";

it("gives a session to its project unless two projects claim it", () => {
  const row = (nativeId: string, project: string) => ({
    driver: "claudeAgent",
    nativeId,
    projectId: ProjectId.make(project),
    title: project === "p-app" ? "App" : "",
    workspaceRoot: `/work/${project}`,
  });
  const projects = projectsBySession([
    row("bound", "p-app"),
    row("bound", "p-app"),
    row("untitled", "p-other"),
    row("ambiguous", "p-app"),
    row("ambiguous", "p-other"),
  ]);

  expect(projects.get(sessionKey("claudeAgent", "bound"))).toEqual({
    projectId: "p-app",
    title: "App",
  });
  expect(projects.get(sessionKey("claudeAgent", "untitled"))?.title).toBe("p-other");
  expect(projects.has(sessionKey("claudeAgent", "ambiguous"))).toBe(false);
});
