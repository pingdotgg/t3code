import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  continueOnMachineAvailability,
  continueOnMachineInput,
  continueTargets,
  hasUnpushedWork,
  unpushedWork,
} from "./continueOnMachine";

const now = DateTime.makeUnsafe("2026-11-27T00:00:00.000Z");

const repositoryProject = {
  repositoryIdentity: {
    canonicalKey: "github.com/t3/app",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/t3/app.git",
    },
  },
} as const;

function runtime(status: ThreadRuntimeSummary["status"]): ThreadRuntimeSummary {
  return {
    status,
    activeRunId: status === "idle" ? null : RunId.make("run"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: "2026-11-27T00:00:00.000Z",
  };
}

function link(target: string, overrides: Partial<PeerLinkSummary> = {}): PeerLinkSummary {
  return {
    environmentId: EnvironmentId.make(target),
    label: target,
    urls: [`https://${target}.example`],
    access: "full-access",
    status: "reachable",
    linkedAt: now,
    lastReachedAt: now,
    lastError: null,
    expiresAt: DateTime.makeUnsafe("2026-12-27T00:00:00.000Z"),
    ...overrides,
  };
}

function availability(
  overrides: Partial<Parameters<typeof continueOnMachineAvailability>[0]> = {},
) {
  return continueOnMachineAvailability({
    project: repositoryProject,
    linkedEnvironmentsOffered: true,
    runtime: null,
    ...overrides,
  });
}

describe("continueOnMachineAvailability", () => {
  it("is ready for an idle thread in a project with a Git remote", () => {
    expect(availability()).toBe("ready");
  });

  it("is busy for every run status the server refuses as still working", () => {
    const statuses = ["preparing", "starting", "running", "waiting"] as const;
    expect(statuses.map((status) => availability({ runtime: runtime(status) }))).toEqual([
      "busy",
      "busy",
      "busy",
      "busy",
    ]);
  });

  it("is hidden for a No project thread, a project without a remote, or an unknown project", () => {
    const hidden = [
      { ...repositoryProject, isScratch: true as const },
      { repositoryIdentity: null },
      null,
    ].map((project) => availability({ project }));
    expect(hidden).toEqual(["hidden", "hidden", "hidden"]);
  });

  it("is hidden while the environment does not offer linked environments", () => {
    expect(availability({ linkedEnvironmentsOffered: false })).toBe("hidden");
  });
});

describe("continueTargets", () => {
  it("lets only reachable Full access links receive the thread", () => {
    const targets = continueTargets(
      [
        link("mac"),
        link("laptop", { access: "read-only" }),
        link("old", { status: "expired" }),
        link("server", { status: "unreachable", lastError: "Timed out" }),
      ],
      now,
    );
    expect(targets.map((target) => [target.label, target.block])).toEqual([
      ["mac", null],
      ["laptop", "access"],
      ["old", "expired"],
      ["server", "unreachable"],
    ]);
  });

  it("treats a link past its expiry as expired before the server marks it", () => {
    const [target] = continueTargets(
      [link("mac", { expiresAt: DateTime.makeUnsafe("2026-11-26T00:00:00.000Z") })],
      now,
    );
    expect(target?.block).toBe("expired");
  });
});

describe("unpushedWork", () => {
  it("finds nothing to push on a clean branch level with its upstream", () => {
    const work = unpushedWork({ hasWorkingTreeChanges: false, hasUpstream: true, aheadCount: 0 });
    expect(hasUnpushedWork(work)).toBe(false);
  });

  it("reports uncommitted changes, commits ahead, and a branch never pushed", () => {
    expect(unpushedWork({ hasWorkingTreeChanges: true, hasUpstream: true, aheadCount: 2 })).toEqual(
      { uncommittedChanges: true, unpushedCommits: 2, branchNotPushed: false },
    );
    const unpublished = unpushedWork({
      hasWorkingTreeChanges: false,
      hasUpstream: false,
      aheadCount: 0,
    });
    expect(unpublished.branchNotPushed).toBe(true);
    expect(hasUnpushedWork(unpublished)).toBe(true);
  });
});

describe("continueOnMachineInput", () => {
  const base = {
    threadId: ThreadId.make("thread"),
    targetEnvironmentId: EnvironmentId.make("mac"),
    commitAndPush: true,
  };

  it("leaves out a blank message so the new thread waits for the user", () => {
    expect(continueOnMachineInput({ ...base, message: "   " })).toEqual(base);
  });

  it("sends a trimmed message that starts the first turn", () => {
    expect(continueOnMachineInput({ ...base, message: "  Run the tests \n" })).toEqual({
      ...base,
      message: "Run the tests",
    });
  });
});
