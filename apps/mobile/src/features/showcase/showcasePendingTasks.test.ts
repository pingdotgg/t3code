import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { buildShowcasePendingTasks } from "./showcasePendingTasks";

const projects: ReadonlyArray<EnvironmentProject> = [
  {
    environmentId: EnvironmentId.make("moonbase-terminal"),
    id: ProjectId.make("t3code"),
    title: "T3 Code",
    workspaceRoot: "/workspace/t3code",
    repositoryIdentity: null,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    scripts: [],
    createdAt: "2026-07-16T08:00:00.000Z",
    updatedAt: "2026-07-16T08:00:00.000Z",
  },
  {
    environmentId: EnvironmentId.make("suspense-station"),
    id: ProjectId.make("react"),
    title: "React",
    workspaceRoot: "/workspace/react",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-16T08:00:00.000Z",
    updatedAt: "2026-07-16T08:00:00.000Z",
  },
];

it("waits until every referenced project has hydrated", () => {
  assert.equal(buildShowcasePendingTasks(projects.slice(0, 1), Date.now()).length, 1);
});
