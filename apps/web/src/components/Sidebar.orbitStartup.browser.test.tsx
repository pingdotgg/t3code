import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../test/render";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSidebarProjectGroups } from "../hooks/useSidebarProjectGroups";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { setEnvironmentProvider, useEnvironmentProvider } from "../orbit/environmentProvider";
import { OrbitProfileSync } from "../orbit/OrbitProfileSync";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useProjects, useQuietThreadShells, useServerConfigs } from "../state/entities";
import { makeThreadFixture } from "../test-fixtures";
import type { Project } from "../types";
import { useUiStateStore } from "../uiStateStore";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

const startupCatalog = vi.hoisted(() => ({ atom: null as unknown }));

// The secure catalog as a fresh client B reads it at startup: one enabled saved Orbit pairing.
vi.mock("../connection/catalog", async (original) => {
  const actual = await original<typeof import("../connection/catalog")>();
  const { Atom: AtomModule } = await import("effect/reactivity");
  const atom = AtomModule.make({ isReady: false, entries: new Map() } as never);
  startupCatalog.atom = atom;
  return { environmentCatalog: { ...actual.environmentCatalog, catalogValueAtom: atom } };
});
vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("../hooks/useSidebarProjectGroups", { spy: true });
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

const local = EnvironmentId.make("local");
const paired = EnvironmentId.make("paired");

function project(environmentId: EnvironmentId, id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

const thread = (environmentId: EnvironmentId, projectId: string, id: string) =>
  makeThreadFixture({
    environmentId,
    projectId: ProjectId.make(projectId),
    id: ThreadId.make(id),
    title: id,
  });

function held() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
}

describe("sidebar on a fresh Orbit client", () => {
  it("lists no pairing's rows and keeps the scope before Orbit and the profile answer", async () => {
    window.localStorage.clear();
    setEnvironmentProvider("orbit");
    useEnvironmentProvider.setState(({ state }) => ({
      state: { ...state, pairedByOrbit: [], pairAttemptedAt: {} },
      orbitInstances: {},
    }));
    const projects = [
      project(local, "home"),
      project(paired, "remote-tasks"),
      project(paired, "remote-main"),
    ];
    const hiddenIds = ["remote-target", "remote-sibling-1", "remote-sibling-2", "remote-bootstrap"];
    const threads = [
      thread(local, "home", "home-thread"),
      ...hiddenIds.map((id) => thread(paired, "remote-tasks", id)),
      thread(paired, "remote-main", "remote-legit"),
    ];
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map(
        [local, paired].map((environmentId) => [
          environmentId,
          {
            scratchWorkspaceRoot: null,
            shellThreadFamilies: false,
          } as unknown as EnvironmentServerConfig,
        ]),
      ),
    );
    // The Tasks peek's conversation is open; its project is outside the chosen scope.
    const route = { environmentId: paired, threadId: ThreadId.make("remote-target") };
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: route });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: { environmentId: local, projectId: ProjectId.make("home") },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: route,
    });

    const environments = held();
    const settings = held();
    const reply = (data: unknown) => ({ status: 200, body: JSON.stringify({ data }), error: null });
    const send = vi.fn(async (request: { method: string; path: string }) => {
      if (request.path === "/environments") {
        await environments.gate;
        return reply([
          {
            environment_id: "paired",
            label: "Paired",
            url: "https://paired.example.test",
            status: "registered",
          },
        ]);
      }
      if (request.path === "/me") {
        return reply({
          id: 1,
          name: "client-b",
          profile: { id: 7, name: "Nick", settings_version: 1, updated_at: "" },
        });
      }
      if (request.path === "/profiles/7/settings" && request.method === "GET") {
        await settings.gate;
        return reply({
          profile_id: 7,
          version: 1,
          updated_at: "",
          settings: {
            workspaces: [],
            sidebarHiddenThreads: {
              schema: 1,
              threads: hiddenIds.map((threadId) => ({ environmentId: "paired", threadId })),
            },
          },
          sections: { sidebarHiddenThreads: { version: 1 } },
        });
      }
      return { status: 503, body: null, error: null };
    });
    using _bridge = stubGlobal("desktopBridge", { orbitGatewaySend: send });
    appAtomRegistry.set(startupCatalog.atom as Atom.Writable<unknown>, {
      isReady: true,
      entries: new Map([[paired, { enabled: true, target: { _tag: "BearerConnectionTarget" } }]]),
    });

    const inserted: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) {
            for (const row of [node, ...node.querySelectorAll("[data-thread-item]")]) {
              if (row.matches("[data-thread-item]")) inserted.push(row.textContent ?? "");
            }
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    using _observer = { [Symbol.dispose]: () => observer.disconnect() };

    await using screen = await render(
      <SidebarProvider style={{ height: 600, minHeight: 600 }}>
        <OrbitProfileSync />
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const groups = vi.mocked(useSidebarProjectGroups).mock.results.at(-1)!.value as ReturnType<
      typeof useSidebarProjectGroups
    >;
    const keyOf = (id: string) =>
      groups.find((group) => group.memberProjects.some((member) => member.id === id))!.projectKey;
    const scope = [keyOf("home"), keyOf("remote-main")];
    await act(() => useUiStateStore.getState().setSidebarProjectScopeKeys(scope));
    const rows = () =>
      [...screen.container.querySelectorAll("[data-thread-item]")].map((row) => row.textContent);
    await vi.waitFor(() => expect(rows().some((text) => text?.includes("home-thread"))).toBe(true));

    // Orbit's listing arrives; the profile's marks are still held.
    environments.release();
    await vi.waitFor(() =>
      expect(send.mock.calls.some(([request]) => request.path === "/profiles/7/settings")).toBe(
        true,
      ),
    );
    expect(inserted.filter((text) => text.includes("remote-"))).toEqual([]);
    expect(useUiStateStore.getState().sidebarProjectScopeKeys).toEqual(scope);

    // The marks arrive: the unmarked row shows, the marked ones never did.
    settings.release();
    await vi.waitFor(() =>
      expect(rows().some((text) => text?.includes("remote-legit"))).toBe(true),
    );
    expect(inserted.filter((text) => hiddenIds.some((id) => text.includes(id)))).toEqual([]);
    expect(useUiStateStore.getState().sidebarProjectScopeKeys).toEqual(scope);
  });
});
