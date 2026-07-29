import { describe, expect, it, vi } from "vite-plus/test";

import { removeProjectGroupMembersSequentially } from "./projectGroupRemoval";

describe("removeProjectGroupMembersSequentially", () => {
  it("removes and cleans each member before starting the next", async () => {
    const steps: string[] = [];

    await removeProjectGroupMembersSequentially(
      ["local", "remote"],
      async (member) => {
        steps.push(`remove:${member}`);
      },
      (member) => {
        steps.push(`cleanup:${member}`);
      },
    );

    expect(steps).toEqual(["remove:local", "cleanup:local", "remove:remote", "cleanup:remote"]);
  });

  it("keeps earlier cleanup when a later member removal fails", async () => {
    const failure = new Error("remote deletion failed");
    const removeMember = vi.fn(async (member: string) => {
      if (member === "remote") throw failure;
    });
    const onMemberRemoved = vi.fn<(member: string) => void>();

    await expect(
      removeProjectGroupMembersSequentially(
        ["local", "remote", "backup"],
        removeMember,
        onMemberRemoved,
      ),
    ).rejects.toBe(failure);

    expect(removeMember.mock.calls).toEqual([["local"], ["remote"]]);
    expect(onMemberRemoved.mock.calls).toEqual([["local"]]);
  });
});
