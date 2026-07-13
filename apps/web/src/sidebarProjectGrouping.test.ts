import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { derivePhysicalProjectKey } from "./logicalProject";
import {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectSnapshots,
} from "./sidebarProjectGrouping";
import type { Project } from "./types";

const forkKey = "github.com/felixleopold/t3code";
const upstreamKey = "github.com/pingdotgg/t3code";
const settings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function makeProject(input: {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly workspaceRoot: string;
  readonly hasUpstream: boolean;
}): Project {
  return {
    id: input.id,
    environmentId: input.environmentId,
    title: input.hasUpstream ? "pingdotgg/t3code" : "felixleopold-t3code",
    workspaceRoot: input.workspaceRoot,
    repositoryIdentity: {
      canonicalKey: input.hasUpstream ? upstreamKey : forkKey,
      remoteKeys: input.hasUpstream ? [forkKey, upstreamKey] : [forkKey],
      locator: {
        source: "git-remote",
        remoteName: input.hasUpstream ? "upstream" : "origin",
        remoteUrl: input.hasUpstream
          ? "git@github.com:pingdotgg/t3code.git"
          : "git@github.com:felixleopold/t3code.git",
      },
      displayName: input.hasUpstream ? "pingdotgg/t3code" : "felixleopold/t3code",
      provider: "github",
      owner: input.hasUpstream ? "pingdotgg" : "felixleopold",
      name: "t3code",
    },
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    scripts: [],
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

describe("sidebar project grouping", () => {
  it("groups a fork-only clone with an upstream checkout regardless of discovery order", () => {
    const forkOnly = makeProject({
      environmentId: EnvironmentId.make("env-conductor"),
      id: ProjectId.make("project-conductor"),
      workspaceRoot: "/srv/nas_share/conductor/t3-projects/felixleopold-t3code",
      hasUpstream: false,
    });
    const withUpstream = makeProject({
      environmentId: EnvironmentId.make("env-local"),
      id: ProjectId.make("project-local"),
      workspaceRoot: "/srv/nas_share/t3code-src",
      hasUpstream: true,
    });

    for (const projects of [
      [forkOnly, withUpstream],
      [withUpstream, forkOnly],
    ]) {
      const physicalToLogical = buildPhysicalToLogicalProjectKeyMap({ projects, settings });
      const snapshots = buildSidebarProjectSnapshots({
        projects,
        settings,
        primaryEnvironmentId: EnvironmentId.make("env-local"),
        resolveEnvironmentLabel: () => null,
      });

      expect(physicalToLogical.get(derivePhysicalProjectKey(forkOnly))).toBe(upstreamKey);
      expect(physicalToLogical.get(derivePhysicalProjectKey(withUpstream))).toBe(upstreamKey);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        projectKey: upstreamKey,
        groupedProjectCount: 2,
      });
    }
  });
});
