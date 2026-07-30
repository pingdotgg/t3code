import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectHeaderThreads, shouldShowOpenInPicker } from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });

  it("hides the picker when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
      }),
    ).toBe(false);
  });

  it("hides the picker for remote environments", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });
});

describe("selectHeaderThreads", () => {
  const environmentId = EnvironmentId.make("environment-primary");
  const projectId = ProjectId.make("project-one");
  const shell = (
    id: string,
    overrides: Partial<EnvironmentThreadShell> = {},
  ): EnvironmentThreadShell =>
    ({
      environmentId,
      id: ThreadId.make(id),
      projectId,
      title: id,
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      latestUserMessageAt: null,
      ...overrides,
    }) as EnvironmentThreadShell;

  it("keeps active siblings scoped to the physical project and environment", () => {
    const siblings = selectHeaderThreads(
      [
        shell("older", { updatedAt: "2026-01-02T00:00:00.000Z" }),
        shell("newer", { updatedAt: "2026-01-03T00:00:00.000Z" }),
        shell("archived", { archivedAt: "2026-01-04T00:00:00.000Z" }),
        shell("other-project", { projectId: ProjectId.make("project-two") }),
        shell("other-environment", {
          environmentId: EnvironmentId.make("environment-remote"),
        }),
      ],
      environmentId,
      projectId,
      "updated_at",
    );

    expect(siblings.map((thread) => thread.id)).toEqual([
      ThreadId.make("newer"),
      ThreadId.make("older"),
    ]);
  });

  it("respects the configured created-at ordering", () => {
    const siblings = selectHeaderThreads(
      [
        shell("older", { createdAt: "2026-01-02T00:00:00.000Z" }),
        shell("newer", { createdAt: "2026-01-03T00:00:00.000Z" }),
      ],
      environmentId,
      projectId,
      "created_at",
    );

    expect(siblings.map((thread) => thread.id)).toEqual([
      ThreadId.make("newer"),
      ThreadId.make("older"),
    ]);
  });
});
