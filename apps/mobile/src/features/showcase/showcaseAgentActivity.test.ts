import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import {
  buildShowcaseAgentActivity,
  SHOWCASE_AGENT_ACTIVITY_ROWS,
  showcaseAndroidActivityData,
} from "./showcaseAgentActivity";

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
});

it("stages relay-shaped rows against the seeded threads", () => {
  const activity = buildShowcaseAgentActivity(threads, projects, NOW);
  assert.isNotNull(activity);
  if (!activity) return;

  assert.strictEqual(activity.activeCount, 3);
  assert.deepStrictEqual(
    activity.activities.map((row) => [row.threadId, row.status, row.projectTitle, row.updatedAt]),
    [
      ["pocket-command-center", "Approval", "T3 Code", "2026-07-16T08:59:00.000Z"],
      ["beautiful-boot", "Input", "Linux", "2026-07-16T08:56:00.000Z"],
      ["buttery-suspense", "Working", "React", "2026-07-16T08:58:00.000Z"],
      ["remote-command-center", "Done", "T3 Code", "2026-07-16T08:57:00.000Z"],
    ],
  );
  assert.strictEqual(
    activity.activities[0]?.deepLink,
    "/threads/moonbase-terminal/pocket-command-center",
  );
  assert.strictEqual(activity.activities.length, SHOWCASE_AGENT_ACTIVITY_ROWS.length);
});

it("encodes the Android Live Update and its alert like a relay push", () => {
  const activity = buildShowcaseAgentActivity(threads, projects, NOW);
  assert.isNotNull(activity);
  if (!activity) return;
  const data = showcaseAndroidActivityData(activity, NOW);

  assert.strictEqual(data.active, "true");
  assert.strictEqual(data.activity_chip, "Review");
  assert.strictEqual(data.activity_title, "3 active agents · 2 need attention");
  assert.strictEqual(
    data.activity_line_0,
    "Approval\tPut the command center in your pocket\tT3 Code",
  );
  assert.strictEqual(data.activity_line_3, "Done\tMake remote coding feel local\tT3 Code");
  assert.strictEqual(data.alert_title, "Put the command center in your pocket");
  assert.strictEqual(data.alert_body, "Approval: T3 Code");
  assert.strictEqual(data.alert_path, "/threads/moonbase-terminal/pocket-command-center");
});
