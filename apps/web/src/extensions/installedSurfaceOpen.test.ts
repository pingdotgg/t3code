import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import type { InstalledPackage } from "./installedController";
import {
  AGENTS_PACK_SURFACE_ID,
  findInstalledThreadSurface,
  isAgentsRosterSurface,
  openInstalledSurface,
} from "./installedSurfaceOpen";

function agentsInstallation(
  id: string,
  overrides: {
    enabled?: boolean;
    projectIds?: readonly string[];
    surface?: Record<string, unknown>;
  } = {},
): InstalledPackage {
  return {
    id,
    contentHash: `hash-${id}`,
    enabled: overrides.enabled ?? true,
    installationGeneration: 1,
    grants: {
      capabilities: [],
      projectIds: (overrides.projectIds ?? ["project-a"]).map((projectId) =>
        ProjectId.make(projectId),
      ),
    },
    package: {
      manifest: {
        id: "t3.agents",
        apiVersion: 1,
        version: "1.0.0",
        surfaces: [
          {
            id: AGENTS_PACK_SURFACE_ID,
            title: "Agents",
            placements: ["side-panel"],
            clients: ["web", "desktop"],
            scope: "thread",
            capabilities: [],
            stateVersion: 1,
            ...overrides.surface,
          },
        ],
      },
    },
  } as unknown as InstalledPackage;
}

describe("findInstalledThreadSurface", () => {
  const find = (installations: readonly InstalledPackage[], client = "web") =>
    findInstalledThreadSurface(installations, AGENTS_PACK_SURFACE_ID, "project-a", client)
      ?.installationId ?? null;

  it("falls back to the native panel unless an eligible installation declares the surface", () => {
    expect(find([])).toBeNull();
    expect(find([agentsInstallation("off", { enabled: false })])).toBeNull();
    expect(find([agentsInstallation("elsewhere", { projectIds: ["project-b"] })])).toBeNull();
    expect(find([agentsInstallation("desktop-only", { surface: { clients: ["desktop"] } })])).toBe(
      null,
    );
    expect(find([agentsInstallation("project-scope", { surface: { scope: "project" } })])).toBe(
      null,
    );
    expect(
      find([agentsInstallation("dock-only", { surface: { placements: ["bottom-dock"] } })]),
    ).toBeNull();
  });

  it("picks the first eligible installation in order", () => {
    expect(
      find([
        agentsInstallation("off", { enabled: false }),
        agentsInstallation("first"),
        agentsInstallation("second"),
      ]),
    ).toBe("first");
    expect(
      find([agentsInstallation("desktop-only", { surface: { clients: ["desktop"] } })], "desktop"),
    ).toBe("desktop-only");
  });
});

describe("native Agents entry point with the pack installed", () => {
  it("opens the pack's roster, which then counts as the on-screen Agents surface", () => {
    const ref = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("thread-agents"));
    const target = findInstalledThreadSurface(
      [agentsInstallation("local.agents-pack")],
      AGENTS_PACK_SURFACE_ID,
      "project-a",
      "web",
    )!;
    const open = () =>
      openInstalledSurface(
        { environmentId: "env-a", client: "web" },
        ref,
        target.installationId,
        target.surface,
        "side-panel",
        {
          projectId: ProjectId.make("project-a"),
          workspaceRoot: "/work/project-a",
          worktreePath: null,
        },
      );
    expect(open()).toBe(true);
    // A second entry point (a spawn CTA after the badge's card) reuses the same tab.
    expect(open()).toBe(true);
    const state = useRightPanelStore.getState();
    const panel = selectThreadRightPanelState(state.byThreadKey, ref);
    const rosters = panel.surfaces.filter(isAgentsRosterSurface);
    expect(rosters).toHaveLength(1);
    expect(isAgentsRosterSurface(selectActiveRightPanelSurface(state.byThreadKey, ref))).toBe(true);
    expect(isAgentsRosterSurface({ id: "agents", kind: "agents" })).toBe(true);
    expect(isAgentsRosterSurface({ id: "files", kind: "files" })).toBe(false);
  });
});
