import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readEnvironmentSupportsWorkItemLinking, resolveThreadDetailRef } from "./entities";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("resolveThreadDetailRef", () => {
  it("does not subscribe to a reserved draft thread before it enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        waitForShell: true,
      }),
    ).toBeNull();
  });

  it("subscribes once the reserved draft thread enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: true,
        waitForShell: true,
      }),
    ).toBe(threadRef);
  });

  it("keeps direct server-thread lookups enabled when the shell has not loaded it", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        waitForShell: false,
      }),
    ).toBe(threadRef);
  });
});

describe("readEnvironmentSupportsWorkItemLinking", () => {
  it.each([
    { capabilities: undefined, supported: false },
    { capabilities: {}, supported: false },
    { capabilities: { issues: false }, supported: false },
    { capabilities: { issues: true }, supported: true },
    { capabilities: { threadPullRequests: true }, supported: true },
    { capabilities: { threadPullRequestLinking: true }, supported: true },
    { capabilities: { issues: true, threadPullRequests: true }, supported: true },
  ])("reads issue or PR linking support: %j", ({ capabilities, supported }) => {
    const environmentId = EnvironmentId.make("work-item-linking-test");
    const config = capabilities === undefined ? undefined : { environment: { capabilities } };
    const read = vi
      .spyOn(appAtomRegistry, "get")
      .mockReturnValue(new Map(config === undefined ? [] : [[environmentId, config]]));
    try {
      expect(readEnvironmentSupportsWorkItemLinking(environmentId)).toBe(supported);
    } finally {
      read.mockRestore();
    }
  });
});
