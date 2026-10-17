import {
  CivilizationDefaultConfig,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type CivilizationEffectiveConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyCivilizationConfigFanout,
  civilizationConfigExpectedRevision,
  civilizationContextInspectionQueryKey,
  civilizationConfigTargetsKey,
  civilizationOverviewQueryKey,
  mergeCivilizationRevisionPage,
  prepareCivilizationImportPreview,
} from "./civilization";

describe("civilization overview query identity", () => {
  it("is stable for the same environment/project pair and separates scopes", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const projectId = ProjectId.make("project-a");

    expect(civilizationOverviewQueryKey(environmentId, projectId)).toBe(
      civilizationOverviewQueryKey(environmentId, projectId),
    );
    expect(civilizationOverviewQueryKey(environmentId, null)).not.toBe(
      civilizationOverviewQueryKey(environmentId, projectId),
    );
    expect(civilizationOverviewQueryKey(EnvironmentId.make("environment-b"), projectId)).not.toBe(
      civilizationOverviewQueryKey(environmentId, projectId),
    );
  });

  it("stabilizes multi-target identity without broadening physical project scopes", () => {
    const environmentA = EnvironmentId.make("environment-a");
    const environmentB = EnvironmentId.make("environment-b");
    const projectA = ProjectId.make("project-a");
    const projectB = ProjectId.make("project-b");

    expect(
      civilizationConfigTargetsKey([
        { environmentId: environmentB, projectId: projectB },
        { environmentId: environmentA, projectId: projectA },
      ]),
    ).toBe(
      civilizationConfigTargetsKey([
        { environmentId: environmentA, projectId: projectA },
        { environmentId: environmentB, projectId: projectB },
      ]),
    );
    expect(
      civilizationConfigTargetsKey([
        { environmentId: environmentA, projectId: projectA },
        { environmentId: environmentB, projectId: projectB },
      ]),
    ).not.toBe(
      civilizationConfigTargetsKey([
        { environmentId: environmentA, projectId: projectA },
        { environmentId: environmentB, projectId: projectA },
      ]),
    );
  });
});

describe("civilization context-inspection query identity", () => {
  it("is stable for identical metadata filters and separates attempts/turns", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const projectId = ProjectId.make("project-a");
    const base = {
      threadId: ThreadId.make("thread-a"),
      providerInstanceId: ProviderInstanceId.make("codex-main"),
      outcome: "provider_start_accepted" as const,
      runId: RunId.make("run-a"),
      attemptId: RunAttemptId.make("attempt-a"),
      providerTurnOrdinal: 1,
    };
    const key = civilizationContextInspectionQueryKey(environmentId, projectId, base, null, 50);
    expect(key).toBe(
      civilizationContextInspectionQueryKey(environmentId, projectId, { ...base }, null, 50),
    );
    expect(key).not.toBe(
      civilizationContextInspectionQueryKey(
        environmentId,
        projectId,
        { ...base, attemptId: RunAttemptId.make("attempt-b") },
        null,
        50,
      ),
    );
    expect(key).not.toBe(
      civilizationContextInspectionQueryKey(
        environmentId,
        projectId,
        { ...base, providerTurnOrdinal: 2 },
        null,
        50,
      ),
    );
  });
});

describe("civilization config mutation planning", () => {
  const effective = {
    config: CivilizationDefaultConfig,
    environmentRevision: 11,
    projectRevision: 27,
    provenance: [],
    selectedNameProbabilities: [],
    selectedProfileProbabilities: [],
  } satisfies CivilizationEffectiveConfig;

  it("uses the captured revision for the exact edited tier", () => {
    expect(civilizationConfigExpectedRevision(effective, null)).toBe(11);
    expect(civilizationConfigExpectedRevision(effective, ProjectId.make("project-a"))).toBe(27);
  });

  it("fans out sequentially and stops at the first independent failure", async () => {
    const calls: string[] = [];
    const targets = [
      { environmentId: EnvironmentId.make("environment-a"), label: "Machine A", value: 11 },
      { environmentId: EnvironmentId.make("environment-b"), label: "Machine B", value: 22 },
      { environmentId: EnvironmentId.make("environment-c"), label: "Machine C", value: 33 },
    ] as const;

    const result = await applyCivilizationConfigFanout<(typeof targets)[number]["value"], string>(
      targets,
      async (target) => {
        calls.push(target.label);
        if (target.label === "Machine B") throw "stale revision";
        return { revision: target.value + 1 };
      },
    );

    expect(calls).toEqual(["Machine A", "Machine B"]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.target.label).toBe("Machine A");
    expect(result.failed).toEqual({ target: targets[1], error: "stale revision" });
  });

  it("preserves typed client import reasons before server validation", () => {
    expect(prepareCivilizationImportPreview("{", 100)).toMatchObject({
      ok: false,
      reason: "invalid_json",
    });
    expect(prepareCivilizationImportPreview('{"version":1}', 4)).toMatchObject({
      ok: false,
      reason: "import_too_large",
    });
    expect(prepareCivilizationImportPreview('{"version":1}', 100)).toMatchObject({
      ok: true,
      override: { version: 1 },
    });
  });
});

describe("civilization revision-consistent pagination", () => {
  it("appends pages only while the server revision remains unchanged", () => {
    const first = mergeCivilizationRevisionPage(null, { revision: 12, items: ["a", "b"] });
    const second = mergeCivilizationRevisionPage(first, { revision: 12, items: ["c"] });

    expect(second).toEqual({ status: "ready", revision: 12, items: ["a", "b", "c"] });
  });

  it("marks the cursor chain stale and restarts from the incoming page on revision change", () => {
    const first = mergeCivilizationRevisionPage(null, { revision: 12, items: ["a", "b"] });
    const stale = mergeCivilizationRevisionPage(first, { revision: 13, items: ["z"] });

    expect(stale).toEqual({ status: "stale", revision: 13, items: ["z"] });
  });
});
