import { EnvironmentId, ProjectId, RunAttemptId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { resolveCivilizationContextSettingsLink } from "./civilizationContextInspectorLink";

const environmentId = EnvironmentId.make("environment-civilization-link");
const projectId = ProjectId.make("project-civilization-link");
const threadId = ThreadId.make("thread-civilization-link");
const runId = RunId.make("run-civilization-link");
const attemptId = RunAttemptId.make("attempt-civilization-link");
const group = {
  projectKey: "logical-project-key",
  memberProjects: [
    {
      environmentId,
      id: projectId,
      physicalProjectKey: `${environmentId}:/repo`,
    },
  ],
} as unknown as SidebarProjectSnapshot;

describe("Civilization context Settings link", () => {
  it("resolves the exact physical project and historical provider-turn identity", () => {
    expect(
      resolveCivilizationContextSettingsLink({
        groups: [group],
        environmentId,
        projectId,
        threadId,
        runId,
        attemptId,
        providerTurnOrdinal: 3,
      }),
    ).toEqual({
      project: "logical-project-key",
      machine: environmentId,
      checkout: `${environmentId}:/repo`,
      contextThread: threadId,
      contextRun: runId,
      contextAttempt: attemptId,
      contextTurn: 3,
    });
  });

  it("does not broaden an unknown project or invalid provider turn", () => {
    expect(
      resolveCivilizationContextSettingsLink({
        groups: [group],
        environmentId,
        projectId: ProjectId.make("missing-project"),
        threadId,
        runId,
        attemptId,
        providerTurnOrdinal: 3,
      }),
    ).toBeNull();
    expect(
      resolveCivilizationContextSettingsLink({
        groups: [group],
        environmentId,
        projectId,
        threadId,
        runId,
        attemptId,
        providerTurnOrdinal: 0,
      }),
    ).toBeNull();
  });
});
