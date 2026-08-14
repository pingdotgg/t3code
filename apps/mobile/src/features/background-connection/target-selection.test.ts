import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";

import { selectBackgroundConnectionThreadTargets } from "./target-selection";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");

function shell(id: string, status: "starting" | "running" | "ready"): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId,
    title: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    session: { status },
  } as EnvironmentThreadShell;
}

describe("background connection target selection", () => {
  it("keeps the retained thread followed by starting and running threads", () => {
    const retained: ScopedThreadRef = {
      environmentId,
      threadId: ThreadId.make("retained"),
    };

    expect(
      selectBackgroundConnectionThreadTargets(retained, [
        shell("settled", "ready"),
        shell("starting", "starting"),
        shell("running", "running"),
      ]),
    ).toEqual([
      retained,
      { environmentId, threadId: ThreadId.make("starting") },
      { environmentId, threadId: ThreadId.make("running") },
    ]);
  });

  it("deduplicates a retained running thread without changing order", () => {
    const retained = { environmentId, threadId: ThreadId.make("running") };
    expect(
      selectBackgroundConnectionThreadTargets(retained, [
        shell("running", "running"),
        shell("other", "starting"),
      ]),
    ).toEqual([retained, { environmentId, threadId: ThreadId.make("other") }]);
  });

  it("drops active targets after their shell settles", () => {
    expect(selectBackgroundConnectionThreadTargets(null, [shell("task", "running")])).toHaveLength(
      1,
    );
    expect(selectBackgroundConnectionThreadTargets(null, [shell("task", "ready")])).toEqual([]);
  });
});
