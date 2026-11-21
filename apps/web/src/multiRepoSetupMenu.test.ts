import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";
import { buildMultiRepoProjectSetupMenu } from "./multiRepoSetupMenu";
import { reduceCommandPaletteUiState } from "./components/CommandPalette.logic";

const laptop = EnvironmentId.make("laptop");
const desktop = EnvironmentId.make("desktop");
const server = EnvironmentId.make("server");

function project(
  environmentId = laptop,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(`product-${environmentId}`),
    title: "Product",
    workspaceRoot: "/work/product",
    repositoryIdentity: null,
    multiRepo: {
      members: [
        { path: "api", remoteUrl: "git@github.com:acme/api.git" },
        { path: "web", remoteUrl: "https://github.com/acme/web.git" },
      ],
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function environment(environmentId = desktop, label = "Desktop") {
  return {
    environmentId,
    label,
    connection: { phase: "connected" },
    serverConfig: {
      environment: {
        capabilities: { multiRepoProjects: true, projectCloneTracking: true },
      },
    },
  };
}

function projectRef(source: EnvironmentProject): ScopedProjectRef {
  return { environmentId: source.environmentId, projectId: source.id };
}

const source = project();
const baseInput = {
  projects: [source],
  projectRefs: [projectRef(source)],
  canSetUp: () => true,
};

describe("multi-repo sidebar setup menu", () => {
  it("offers a direct action for one missing machine and carries the existing setup into the palette intent", () => {
    const menu = buildMultiRepoProjectSetupMenu({
      ...baseInput,
      environments: [environment(laptop, "Laptop"), environment()],
    });
    expect(menu.items).toEqual([
      { id: "multi-repo-setup:desktop", label: "Set up on Desktop", icon: "folder" },
    ]);
    const intent = menu.setupsByAction.get("multi-repo-setup:desktop")!;
    expect(intent.environmentId).toBe(desktop);
    expect(intent.setup.source).toBe(source);
    expect(intent.setup.members).toEqual(source.multiRepo?.members);
    expect(
      reduceCommandPaletteUiState(
        { open: true, mode: "files", openIntent: null, session: 1 },
        { _tag: "OpenMultiRepoSetup", ...intent },
      ),
    ).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "multi-repo-setup", ...intent },
      session: 2,
    });
  });

  it("groups multiple missing environments in a submenu", () => {
    const menu = buildMultiRepoProjectSetupMenu({
      ...baseInput,
      environments: [environment(), environment(server, "Build server")],
    });
    expect(menu.items).toEqual([
      {
        id: "multi-repo-setup:submenu",
        label: "Set up on...",
        icon: "folder",
        children: [
          { id: "multi-repo-setup:desktop", label: "Set up on Desktop", icon: "folder" },
          { id: "multi-repo-setup:server", label: "Set up on Build server", icon: "folder" },
        ],
      },
    ]);
    expect([...menu.setupsByAction.values()].map((intent) => intent.environmentId)).toEqual([
      desktop,
      server,
    ]);
  });

  it.each([
    { ...environment(), connection: { phase: "disconnected" } },
    { ...environment(), connection: { phase: "connecting" } },
    { ...environment(), serverConfig: null },
    { environmentId: desktop, label: "Desktop", connection: { phase: "connected" } },
    {
      ...environment(),
      serverConfig: {
        environment: { capabilities: { multiRepoProjects: false, projectCloneTracking: true } },
      },
    },
    {
      ...environment(),
      serverConfig: {
        environment: { capabilities: { multiRepoProjects: true, projectCloneTracking: false } },
      },
    },
    {
      ...environment(),
      serverConfig: { environment: { capabilities: {} } },
    },
  ])("omits disconnected or unsupported targets: %j", (target) => {
    const menu = buildMultiRepoProjectSetupMenu({ ...baseInput, environments: [target] });
    expect(menu.items).toEqual([]);
    expect(menu.setupsByAction.size).toBe(0);
  });

  it("omits targets this client may not set the project up on", () => {
    const menu = buildMultiRepoProjectSetupMenu({
      ...baseInput,
      environments: [environment(), environment(server, "Build server")],
      canSetUp: (environmentId) => environmentId !== desktop,
    });
    expect([...menu.setupsByAction.values()].map((intent) => intent.environmentId)).toEqual([
      server,
    ]);
  });

  it("recognizes an existing setup despite different paths, remote syntax and member order", () => {
    const existing = project(desktop, {
      workspaceRoot: "/home/me/renamed",
      multiRepo: {
        members: [
          { path: "frontend", remoteUrl: "git@github.com:acme/web.git" },
          { path: "backend", remoteUrl: "https://github.com/acme/api" },
        ],
      },
    });
    expect(
      buildMultiRepoProjectSetupMenu({
        ...baseInput,
        projects: [source, existing],
        environments: [environment()],
      }).items,
    ).toEqual([]);
  });

  it("matches by multi-repo identity even if the palette chooses another source machine", () => {
    const copy = project(server, { workspaceRoot: "/srv/product" });
    const unrelated = project(laptop, {
      id: ProjectId.make("other"),
      multiRepo: { members: [{ path: "tools", remoteUrl: "https://github.com/acme/tools" }] },
    });
    const menu = buildMultiRepoProjectSetupMenu({
      projects: [unrelated, source, copy],
      projectRefs: [projectRef(copy)],
      environments: [environment()],
      canSetUp: () => true,
    });
    expect(menu.items).toHaveLength(1);
    expect(menu.setupsByAction.get("multi-repo-setup:desktop")?.setup.source).toBe(source);
  });

  it.each([
    { multiRepo: null },
    { multiRepo: { members: [] } },
    { multiRepo: { members: [{ path: "local-only", remoteUrl: null }] } },
  ])("does not offer ordinary, empty or uncloneable projects: %j", (overrides) => {
    const source = project(laptop, overrides);
    expect(
      buildMultiRepoProjectSetupMenu({
        projects: [source, project(server)],
        projectRefs: [projectRef(source)],
        environments: [environment()],
        canSetUp: () => true,
      }).items,
    ).toEqual([]);
  });
});
