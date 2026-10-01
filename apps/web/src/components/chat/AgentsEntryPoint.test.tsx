import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { InstalledPackage } from "../../extensions/installedController";
import { AGENTS_PACK_SURFACE_ID } from "../../extensions/installedSurfaceOpen";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";

const installed = vi.hoisted(() => ({ installations: [] as readonly unknown[] }));
vi.mock("../../extensions/installedEnvironment", () => ({
  useInstalledExtensions: () => ({ installations: installed.installations }),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: unknown }) => children,
  TooltipTrigger: ({ children }: { children: unknown }) => children,
  TooltipPopup: () => null,
}));

import { AgentsHeaderBadge } from "./AgentsEntryPoint";
import { PanelLayoutControls } from "./PanelLayoutControls";

const project = { id: ProjectId.make("project-a"), workspaceRoot: "/work/project-a" };
let renderer: ReactTestRenderer | null = null;
let threadIndex = 0;

function agentsPack(): InstalledPackage {
  return {
    id: "local.agents-pack",
    contentHash: "hash",
    enabled: true,
    installationGeneration: 1,
    grants: { capabilities: [], projectIds: [project.id] },
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
          },
        ],
      },
    },
  } as unknown as InstalledPackage;
}

/** Mounts the header controls with the badge, as ChatView composes them. */
async function mountHeader(liveCount: number) {
  const ref = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make(`thread-${threadIndex++}`));
  const store = useRightPanelStore.getState();
  // Files was the last panel shown, then the user hid the panel.
  store.open(ref, "files");
  store.toggleVisibility(ref);
  await act(() => {
    renderer = create(
      <PanelLayoutControls
        terminalAvailable
        terminalOpen={false}
        terminalShortcutLabel={null}
        rightPanelAvailable
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        liveAgentCount={liveCount}
        agentsBadge={
          <AgentsHeaderBadge
            count={liveCount}
            threadRef={ref}
            project={project}
            worktreePath={null}
          />
        }
        onToggleTerminal={() => {}}
        onToggleRightPanel={() => useRightPanelStore.getState().toggleVisibility(ref)}
      />,
    );
  });
  const active = () =>
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref);
  const badge = () => renderer!.root.findAll((node) => node.props["data-agents-header-badge"]);
  return { active, badge };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installed.installations = [];
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("header live-agent badge", () => {
  it("opens the Agents roster, not the last panel the toggle would restore", async () => {
    const { active, badge } = await mountHeader(2);
    expect(active()).toBeNull();
    await act(() => badge()[0]!.props.onClick());
    expect(active()?.kind).toBe("agents");
  });

  it("switches an open panel to Agents instead of closing it", async () => {
    const { active, badge } = await mountHeader(1);
    await act(() =>
      renderer!.root
        .findByProps({ "aria-label": "Toggle right panel, 1 agent working" })
        .props.onPressedChange(),
    );
    expect(active()?.kind).toBe("files");
    await act(() => badge()[0]!.props.onClick());
    expect(active()?.kind).toBe("agents");
  });

  it("opens the Agents pack's roster when the pack is installed", async () => {
    installed.installations = [agentsPack()];
    const { active, badge } = await mountHeader(3);
    await act(() => badge()[0]!.props.onClick());
    const surface = active();
    expect(surface?.kind === "extension" && surface.record.surfaceId).toBe(AGENTS_PACK_SURFACE_ID);
  });

  it("is absent when no agents are live", async () => {
    const { badge } = await mountHeader(0);
    expect(badge()).toHaveLength(0);
  });
});
