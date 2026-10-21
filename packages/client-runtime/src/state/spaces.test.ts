import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { ClientSettingsSchema, DEFAULT_SPACES_STATE } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  assignProjectSpace,
  assignThreadSpace,
  assignNewThreadSpace,
  createSpace,
  cycleSpace,
  filterSpaceEntities,
  rememberSpaceThread,
  removeSpace,
  resolveProjectSpace,
  resolveThreadSpace,
  selectSpace,
  spaceIdForIndex,
  updateSpace,
} from "./spaces.ts";

const decodeClientSettings = Schema.decodeSync(ClientSettingsSchema);
const environmentId = EnvironmentId.make("local");
const remoteEnvironmentId = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const project = { environmentId, id: projectId };
const thread = { environmentId, id: threadId, projectId };
const projectRef = { environmentId, projectId };
const threadRef = { environmentId, threadId };
const state = {
  ...DEFAULT_SPACES_STATE,
  spaces: [
    { id: "work", name: "Work", theme: null },
    { id: "personal", name: "Personal", theme: "light" },
  ],
};

describe("Spaces membership", () => {
  it("lets new threads inherit in All Spaces and matching contexts, overriding only other projects", () => {
    const work = assignProjectSpace(state, projectRef, "work");
    for (const selected of [null, "work"]) {
      const created = assignNewThreadSpace(work, thread, selected);
      expect(Object.hasOwn(created.threadSpaces, "local:thread")).toBe(false);
      expect(resolveThreadSpace(created, thread)).toBe("work");
      expect(resolveThreadSpace(assignProjectSpace(created, projectRef, "personal"), thread)).toBe(
        "personal",
      );
    }
    expect(resolveThreadSpace(assignNewThreadSpace(work, thread, "personal"), thread)).toBe(
      "personal",
    );
  });
  it("does not recreate memberships when a captured Space is deleted before creation finishes", () => {
    const deleted = removeSpace(state, "work");
    expect(
      resolveProjectSpace(assignProjectSpace(deleted, projectRef, "work"), projectRef),
    ).toBeNull();
    const assigned = assignProjectSpace(deleted, projectRef, "personal");
    expect(resolveThreadSpace(assignThreadSpace(assigned, threadRef, "work"), thread)).toBeNull();
    expect(assignThreadSpace(assigned, threadRef, "work").threadSpaces["local:thread"]).toBeNull();
  });
  it("defaults existing client settings to All Spaces", () => {
    expect(decodeClientSettings({}).spaces).toEqual(DEFAULT_SPACES_STATE);
  });

  it("inherits a project's membership dynamically", () => {
    const work = assignProjectSpace(state, projectRef, "work");
    expect(resolveProjectSpace(work, projectRef)).toBe("work");
    expect(resolveThreadSpace(work, thread)).toBe("work");
    expect(resolveThreadSpace(assignProjectSpace(work, projectRef, "personal"), thread)).toBe(
      "personal",
    );
  });

  it("keeps an explicit override or No Space until inheritance is restored", () => {
    const work = assignProjectSpace(state, projectRef, "work");
    const overridden = assignThreadSpace(work, threadRef, "personal");
    expect(resolveThreadSpace(overridden, thread)).toBe("personal");
    expect(resolveThreadSpace(assignThreadSpace(overridden, threadRef, null), thread)).toBeNull();
    expect(resolveThreadSpace(assignThreadSpace(overridden, threadRef, undefined), thread)).toBe(
      "work",
    );
  });

  it("keeps matching project and thread IDs in different environments independent", () => {
    const work = assignProjectSpace(state, projectRef, "work");
    const remote = { ...thread, environmentId: remoteEnvironmentId };
    const overridden = assignThreadSpace(
      work,
      { ...threadRef, environmentId: remoteEnvironmentId },
      "personal",
    );
    expect(resolveThreadSpace(overridden, thread)).toBe("work");
    expect(resolveThreadSpace(overridden, remote)).toBe("personal");
    expect(
      resolveProjectSpace(overridden, { ...projectRef, environmentId: remoteEnvironmentId }),
    ).toBeNull();
  });

  it("filters threads while retaining the parent project of a matching override", () => {
    const otherProject = { environmentId, id: ProjectId.make("other") };
    const otherThread = { ...thread, id: ThreadId.make("other"), projectId: otherProject.id };
    const assigned = assignThreadSpace(
      assignProjectSpace(state, projectRef, "work"),
      { environmentId, threadId: otherThread.id },
      "work",
    );
    expect(
      filterSpaceEntities(
        selectSpace(assigned, "work"),
        [project, otherProject],
        [thread, otherThread],
      ),
    ).toEqual({
      projects: [project, otherProject],
      threads: [thread, otherThread],
    });
    const excluded = assignThreadSpace(assigned, threadRef, "personal");
    expect(
      filterSpaceEntities(
        selectSpace(excluded, "work"),
        [project, otherProject],
        [thread, otherThread],
      ).threads,
    ).toEqual([otherThread]);
    expect(
      filterSpaceEntities(
        selectSpace(excluded, null),
        [project, otherProject],
        [thread, otherThread],
      ).threads,
    ).toEqual([thread, otherThread]);
  });

  it("deletes only Space configuration and prevents a removed override from reinheriting", () => {
    const assigned = assignThreadSpace(
      assignProjectSpace(state, projectRef, "personal"),
      threadRef,
      "work",
    );
    const remembered = rememberSpaceThread(selectSpace(assigned, "work"), threadRef);
    const removed = removeSpace(remembered, "work");
    expect(removed.spaces.map((space) => space.id)).toEqual(["personal"]);
    expect(removed.activeSpaceId).toBeNull();
    expect(removed.lastThreadBySpace.work).toBeUndefined();
    expect(resolveThreadSpace(removed, thread)).toBeNull();
    expect(resolveProjectSpace(removed, projectRef)).toBe("personal");
    expect(resolveProjectSpace(removeSpace(removed, "personal"), projectRef)).toBeNull();
  });

  it("creates, renames and themes Spaces and remembers a thread per selection", () => {
    const created = createSpace(DEFAULT_SPACES_STATE, { id: "work", name: " Work ", theme: null });
    const renamed = updateSpace(created, "work", { name: " Writing ", theme: "dark" });
    expect(renamed.spaces).toEqual([{ id: "work", name: "Writing", theme: "dark" }]);
    expect(
      rememberSpaceThread(selectSpace(renamed, "work"), threadRef).lastThreadBySpace.work,
    ).toEqual(threadRef);
    expect(
      rememberSpaceThread(selectSpace(renamed, null), threadRef).lastThreadBySpace.all,
    ).toEqual(threadRef);
    expect(selectSpace(renamed, "missing").activeSpaceId).toBeNull();
    expect(updateSpace(renamed, "work", { name: " " })).toEqual(renamed);
  });

  it("cycles through All Spaces and named Spaces in both directions", () => {
    expect(cycleSpace(state, 1).activeSpaceId).toBe("work");
    expect(cycleSpace(selectSpace(state, "work"), 1).activeSpaceId).toBe("personal");
    expect(cycleSpace(selectSpace(state, "personal"), 1).activeSpaceId).toBeNull();
    expect(cycleSpace(state, -1).activeSpaceId).toBe("personal");
    expect(cycleSpace(selectSpace(state, "personal"), -1).activeSpaceId).toBe("work");
    expect(cycleSpace(selectSpace(state, "work"), -1).activeSpaceId).toBeNull();
  });

  it("keeps an empty Spaces configuration unchanged when cycling", () => {
    expect(cycleSpace(DEFAULT_SPACES_STATE, 1)).toBe(DEFAULT_SPACES_STATE);
    expect(cycleSpace(DEFAULT_SPACES_STATE, -1)).toBe(DEFAULT_SPACES_STATE);
  });

  it("selects named Spaces by one-based index without including All Spaces", () => {
    expect(spaceIdForIndex(state, 1)).toBe("work");
    expect(spaceIdForIndex(state, 2)).toBe("personal");
    expect(spaceIdForIndex(state, 0)).toBeUndefined();
    expect(spaceIdForIndex(state, 3)).toBeUndefined();
    expect(spaceIdForIndex(DEFAULT_SPACES_STATE, 1)).toBeUndefined();
  });
});
