import type { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createScratchProjectActions } from "./useScratchProject";

const local = "local" as EnvironmentId;
const remote = "remote" as EnvironmentId;
const other = "other" as EnvironmentId;

function scratchEnvironment(environmentId: EnvironmentId, scratchWorkspaceRoot: string | null) {
  return {
    environmentId,
    connection: { phase: "connected" },
    serverConfig: { scratchWorkspaceRoot },
  } as never;
}

function actions(
  primary: EnvironmentId | null,
  localRoot: string | null,
  remoteRoot: string | null = "/remote/scratch",
) {
  const environments = [
    scratchEnvironment(local, localRoot),
    scratchEnvironment(remote, remoteRoot),
    scratchEnvironment(other, "/other/scratch"),
  ];
  return createScratchProjectActions({
    environments: () => environments,
    primaryEnvironmentId: () => primary,
    registry: AtomRegistry.make(),
    handleNewThread: async () => null,
  });
}

describe("scratchEnvironmentId", () => {
  it("prefers the primary environment over the one on screen", () => {
    expect(actions(local, "/local/scratch").scratchEnvironmentId(remote)).toBe(local);
    expect(actions(local, "/local/scratch").scratchEnvironmentId(null)).toBe(local);
  });

  it("falls back when the primary environment offers no scratch root", () => {
    expect(actions(local, null).scratchEnvironmentId(remote)).toBe(remote);
    expect(actions(null, null).scratchEnvironmentId(remote)).toBe(remote);
    expect(actions(null, null, null).scratchEnvironmentId(remote)).toBe(other);
    expect(actions(local, null).scratchEnvironmentId(null)).toBeNull();
  });
});

describe("scratchBlocked", () => {
  const blocked = { baseDir: "/home/me/.t3", repositoryRoot: "/home/me" };
  const blockedActions = (
    primary: EnvironmentId | null,
    phase: string,
    remoteRoot: string | null = null,
  ) =>
    createScratchProjectActions({
      environments: () => [
        scratchEnvironment(remote, remoteRoot),
        {
          environmentId: local,
          connection: { phase },
          serverConfig: { scratchBlockedByRepository: blocked },
        } as never,
      ],
      primaryEnvironmentId: () => primary,
      registry: AtomRegistry.make(),
      handleNewThread: async () => null,
    });

  it("gives the reason of the primary or current machine", () => {
    expect(blockedActions(local, "connected").scratchBlocked(null)).toEqual(blocked);
    expect(blockedActions(null, "connected").scratchBlocked(local)).toEqual(blocked);
    expect(blockedActions(local, "connected").scratchBlockedFor(remote)).toBeNull();
  });

  it("stays quiet about a machine the user is not on", () => {
    expect(blockedActions(null, "connected").scratchBlocked(remote)).toBeNull();
    expect(blockedActions(local, "disconnected").scratchBlocked(local)).toBeNull();
  });

  it("stays quiet while another machine can start one", () => {
    expect(blockedActions(local, "connected", "/remote/scratch").scratchBlocked(null)).toBeNull();
  });
});
