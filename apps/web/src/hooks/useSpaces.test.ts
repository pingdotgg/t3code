import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_SPACES_STATE } from "@t3tools/contracts/settings";
import {
  assignProjectSpace,
  assignThreadSpace,
  selectSpace,
} from "@t3tools/client-runtime/state/spaces";
import { describe, expect, it } from "vite-plus/test";
import { resolveSpaceThread, transferDraftSpace } from "./spaces.logic";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project");
const first = { environmentId, id: ThreadId.make("first"), projectId, archivedAt: null };
const second = { ...first, id: ThreadId.make("second") };
const ref = { environmentId, threadId: first.id };
const selected = selectSpace(
  { ...DEFAULT_SPACES_STATE, spaces: [{ id: "work", name: "Work", theme: null }] },
  "work",
);

describe("Space thread restoration", () => {
  it("restores only remembered threads that still belong to the selected Space", () => {
    const state = { ...assignThreadSpace(selected, ref, "work"), lastThreadBySpace: { work: ref } };
    expect(resolveSpaceThread(state, [first])).toEqual(ref);
    expect(resolveSpaceThread(assignThreadSpace(state, ref, null), [first])).toBeNull();
    expect(resolveSpaceThread(state, [])).toBeNull();
    expect(resolveSpaceThread(state, [{ ...first, archivedAt: "2026-10-07" }])).toBeNull();
    expect(
      resolveSpaceThread(state, [{ ...first, environmentId: EnvironmentId.make("remote") }]),
    ).toBeNull();
  });
  it("does not open a different thread when the remembered thread is stale", () => {
    const state = {
      ...assignThreadSpace(selected, { environmentId, threadId: second.id }, "work"),
      lastThreadBySpace: { work: ref },
    };
    expect(resolveSpaceThread(state, [second])).toBeNull();
  });
});

describe("draft environment changes", () => {
  it("moves an override when a failed submission restores the draft with a new thread ID", () => {
    const previous = { ...ref, projectId };
    const restored = { ...previous, threadId: ThreadId.make("restored") };
    const assigned = assignThreadSpace(selected, ref, "work");
    const moved = transferDraftSpace(assigned, previous, restored);
    expect(moved.threadSpaces["local:restored"]).toBe("work");
    expect(moved.threadSpaces["local:first"]).toBeUndefined();
  });
  it("keeps new work in the selected Space when its project or environment changes", () => {
    const previous = { ...ref, projectId };
    const remote = {
      environmentId: EnvironmentId.make("remote"),
      threadId: first.id,
      projectId: ProjectId.make("other"),
    };
    const assigned = assignProjectSpace(selected, { environmentId, projectId }, "work");
    expect(transferDraftSpace(assigned, previous, remote).threadSpaces["remote:first"]).toBe(
      "work",
    );
    const sameEnvironment = { ...remote, environmentId };
    expect(
      transferDraftSpace(assigned, previous, sameEnvironment).threadSpaces["local:first"],
    ).toBe("work");
    expect(
      transferDraftSpace(selectSpace(assigned, null), previous, remote).threadSpaces[
        "remote:first"
      ],
    ).toBeUndefined();
  });
  it("copies a draft override to its new scoped thread ref, including No Space", () => {
    const destination = {
      environmentId: EnvironmentId.make("remote"),
      threadId: first.id,
      projectId,
    };
    const previous = { ...ref, projectId };
    const assigned = assignThreadSpace(selected, ref, "work");
    expect(transferDraftSpace(assigned, previous, destination).threadSpaces["remote:first"]).toBe(
      "work",
    );
    const noSpace = assignThreadSpace(assigned, ref, null);
    expect(
      transferDraftSpace(noSpace, previous, destination).threadSpaces["remote:first"],
    ).toBeNull();
    expect(transferDraftSpace(selected, previous, destination)).toBe(selected);
  });
});
