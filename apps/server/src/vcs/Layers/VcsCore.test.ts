import * as NodeServices from "@effect/platform-node/NodeServices";
import type { GitStatusResult, VcsCapabilities } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { GitManager, type GitManagerShape } from "../../git/Services/GitManager.ts";
import type { VcsServiceError } from "../Errors.ts";
import { VcsCoreLive } from "./VcsCore.ts";
import { VcsCore, type VcsCoreShape } from "../Services/VcsCore.ts";
import { VcsProcess, type VcsProcessShape } from "../Services/VcsProcess.ts";
import { VcsResolver, type VcsResolverShape } from "../Services/VcsResolver.ts";

const JJ_CAPABILITIES: VcsCapabilities = {
  supportsPull: false,
  supportsRunStackedAction: false,
  supportsCreateWorkspace: true,
  supportsRemoveWorkspace: true,
  supportsCreateRef: false,
  supportsCheckoutRef: false,
  supportsInit: true,
  supportsCheckpointing: false,
};

const CLEAN_GIT_STATUS: GitStatusResult = {
  branch: null,
  hasWorkingTreeChanges: false,
  workingTree: {
    files: [],
    insertions: 0,
    deletions: 0,
  },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

function unexpectedCall(label: string) {
  return Effect.die(new Error(`Unexpected call: ${label}`));
}

function makeGitCore(overrides: Partial<GitCoreShape> = {}): GitCoreShape {
  return {
    status: () => unexpectedCall("GitCore.status"),
    statusDetails: () => unexpectedCall("GitCore.statusDetails"),
    prepareCommitContext: () => unexpectedCall("GitCore.prepareCommitContext"),
    commit: () => unexpectedCall("GitCore.commit"),
    pushCurrentBranch: () => unexpectedCall("GitCore.pushCurrentBranch"),
    readRangeContext: () => unexpectedCall("GitCore.readRangeContext"),
    readConfigValue: () => unexpectedCall("GitCore.readConfigValue"),
    listBranches: () => unexpectedCall("GitCore.listBranches"),
    pullCurrentBranch: () => unexpectedCall("GitCore.pullCurrentBranch"),
    createWorktree: () => unexpectedCall("GitCore.createWorktree"),
    removeWorktree: () => unexpectedCall("GitCore.removeWorktree"),
    renameBranch: () => unexpectedCall("GitCore.renameBranch"),
    createBranch: () => unexpectedCall("GitCore.createBranch"),
    checkoutBranch: () => unexpectedCall("GitCore.checkoutBranch"),
    initRepo: () => unexpectedCall("GitCore.initRepo"),
    listLocalBranchNames: () => unexpectedCall("GitCore.listLocalBranchNames"),
    ...overrides,
  };
}

function makeGitManager(overrides: Partial<GitManagerShape> = {}): GitManagerShape {
  return {
    status: () => unexpectedCall("GitManager.status"),
    runStackedAction: () => unexpectedCall("GitManager.runStackedAction"),
    ...overrides,
  };
}

function makeVcsProcess(execute: VcsProcessShape["execute"]): VcsProcessShape {
  return { execute };
}

function makeVcsResolver(overrides: Partial<VcsResolverShape> = {}): VcsResolverShape {
  return {
    resolve: () =>
      Effect.succeed({
        backend: "jj",
        capabilities: JJ_CAPABILITIES,
        workspaceRoot: "/repo",
      }),
    ...overrides,
  };
}

async function runWithVcsCore<T>(input: {
  gitCore?: Partial<GitCoreShape>;
  gitManager?: Partial<GitManagerShape>;
  vcsProcess: VcsProcessShape["execute"];
  resolver?: Partial<VcsResolverShape>;
  effect: (vcsCore: VcsCoreShape) => Effect.Effect<T, VcsServiceError, never>;
}) {
  const dependencyLayer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(GitCore, makeGitCore(input.gitCore)),
    Layer.succeed(GitManager, makeGitManager(input.gitManager)),
    Layer.succeed(VcsProcess, makeVcsProcess(input.vcsProcess)),
    Layer.succeed(VcsResolver, makeVcsResolver(input.resolver)),
  );
  const layer = VcsCoreLive.pipe(Layer.provide(dependencyLayer));

  return await Effect.runPromise(
    Effect.gen(function* () {
      const vcsCore = yield* VcsCore;
      return yield* input.effect(vcsCore);
    }).pipe(Effect.provide(layer)),
  );
}

describe("VcsCoreLive jj base bookmark inference", () => {
  it("returns the nearest local base bookmark for jj status", async () => {
    const result = await runWithVcsCore({
      gitCore: {
        status: () => Effect.succeed(CLEAN_GIT_STATUS),
      },
      vcsProcess: ({ args }) => {
        if (args[0] === "log") {
          return Effect.succeed({
            code: 0,
            stdout: '[{"name":"main"}]\n',
            stderr: "",
          });
        }
        return unexpectedCall(`VcsProcess.execute ${args.join(" ")}`);
      },
      effect: (vcsCore) => vcsCore.status({ cwd: "/repo" }),
    });

    expect(result.backend).toBe("jj");
    expect(result.refName).toBe("main");
    expect(result.refKind).toBe("bookmark");
  });

  it("marks inferred local base bookmarks as current in listRefs", async () => {
    const result = await runWithVcsCore({
      vcsProcess: ({ args }) => {
        if (args[0] === "log") {
          return Effect.succeed({
            code: 0,
            stdout: '[{"name":"main"}]\n',
            stderr: "",
          });
        }
        if (args[0] === "bookmark") {
          return Effect.succeed({
            code: 0,
            stdout: ['{"name":"main"}', '{"name":"main","remote":"origin"}'].join("\n"),
            stderr: "",
          });
        }
        return unexpectedCall(`VcsProcess.execute ${args.join(" ")}`);
      },
      effect: (vcsCore) => vcsCore.listRefs({ cwd: "/repo" }),
    });

    expect(result.backend).toBe("jj");
    expect(result.refs).toEqual([
      {
        name: "main",
        kind: "bookmark",
        current: true,
        isDefault: true,
        workspacePath: null,
      },
      {
        name: "main@origin",
        kind: "remoteBookmark",
        current: false,
        isDefault: true,
        remoteName: "origin",
        workspacePath: null,
      },
    ]);
  });

  it("keeps multiple inferred local base bookmarks current and picks the first sorted one for status", async () => {
    const statusResult = await runWithVcsCore({
      gitCore: {
        status: () => Effect.succeed(CLEAN_GIT_STATUS),
      },
      vcsProcess: ({ args }) => {
        if (args[0] === "log") {
          return Effect.succeed({
            code: 0,
            stdout: '[{"name":"release/1.2"},{"name":"main"}]\n',
            stderr: "",
          });
        }
        if (args[0] === "bookmark") {
          return Effect.succeed({
            code: 0,
            stdout: ['{"name":"release/1.2"}', '{"name":"main"}'].join("\n"),
            stderr: "",
          });
        }
        return unexpectedCall(`VcsProcess.execute ${args.join(" ")}`);
      },
      effect: (vcsCore) =>
        Effect.all({
          status: vcsCore.status({ cwd: "/repo" }),
          refs: vcsCore.listRefs({ cwd: "/repo" }),
        }),
    });

    expect(statusResult.status.refName).toBe("main");
    expect(
      statusResult.refs.refs.filter((ref) => ref.current).map((ref) => ref.name),
    ).toEqual(["main", "release/1.2"]);
  });

  it("ignores remote-only bookmarks when inferring jj base bookmarks", async () => {
    const result = await runWithVcsCore({
      gitCore: {
        status: () => Effect.succeed(CLEAN_GIT_STATUS),
      },
      vcsProcess: ({ args }) => {
        if (args[0] === "log") {
          return Effect.succeed({
            code: 0,
            stdout: "[]\n",
            stderr: "",
          });
        }
        if (args[0] === "bookmark") {
          return Effect.succeed({
            code: 0,
            stdout: '{"name":"main","remote":"origin"}\n',
            stderr: "",
          });
        }
        return unexpectedCall(`VcsProcess.execute ${args.join(" ")}`);
      },
      effect: (vcsCore) =>
        Effect.all({
          status: vcsCore.status({ cwd: "/repo" }),
          refs: vcsCore.listRefs({ cwd: "/repo" }),
        }),
    });

    expect(result.status.refName).toBeNull();
    expect(result.refs.refs[0]).toEqual({
      name: "main@origin",
      kind: "remoteBookmark",
      current: false,
      isDefault: true,
      remoteName: "origin",
      workspacePath: null,
    });
  });
});
