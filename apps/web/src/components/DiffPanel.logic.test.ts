import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveDiffVcsDemand } from "./DiffPanel.logic";

const environmentId = EnvironmentId.make("env-1");

describe("resolveDiffVcsDemand", () => {
  it.each([
    {
      phase: "closed",
      active: false,
      branchScopeActive: true,
      expected: { status: null, localRefs: null, remoteRefs: null },
    },
    {
      phase: "open working tree",
      active: true,
      branchScopeActive: false,
      expected: {
        status: { environmentId, input: { cwd: "/repo" } },
        localRefs: null,
        remoteRefs: null,
      },
    },
    {
      phase: "open branch scope",
      active: true,
      branchScopeActive: true,
      expected: {
        status: { environmentId, input: { cwd: "/repo" } },
        localRefs: {
          environmentId,
          input: {
            cwd: "/repo",
            includeMatchingRemoteRefs: true,
            query: "feature",
            limit: 100,
            refKind: "local",
          },
        },
        remoteRefs: {
          environmentId,
          input: {
            cwd: "/repo",
            includeMatchingRemoteRefs: true,
            query: "feature",
            limit: 100,
            refKind: "remote",
          },
        },
      },
    },
    {
      phase: "closed again",
      active: false,
      branchScopeActive: true,
      expected: { status: null, localRefs: null, remoteRefs: null },
    },
  ] as const)(
    "returns the required targets while $phase",
    ({ active, branchScopeActive, expected }) => {
      expect(
        resolveDiffVcsDemand({
          active,
          environmentId,
          statusCwd: "/repo",
          branchRefsCwd: "/repo",
          branchScopeActive,
          query: " feature ",
        }),
      ).toEqual(expected);
    },
  );
});
