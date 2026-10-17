import {
  EnvironmentId,
  IssueTrackerKind,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type IssueTrackerConnectionList,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { listBrowserImportSources, trackerState } = vi.hoisted(() => ({
  trackerState: {
    environmentId: null as string | null,
    phase: "connected",
    scopeListeners: new Set<() => void>(),
    canEdit: true,
    data: null as IssueTrackerConnectionList | null,
    connect: vi.fn(),
    connections: vi.fn(),
  },
  listBrowserImportSources: vi.fn().mockResolvedValue([]),
}));

vi.mock(import("../preview/previewBridge"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    previewBridge: { ...actual.previewBridge, listBrowserImportSources } as never,
  };
});
vi.mock(import("../../env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [], isReady: true })) as never,
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
  useClientSettingsHydrated: () => true,
  usePrimarySettingsAvailable: () => true,
  usePrimarySettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
  useUpdatePrimarySettings: (() => vi.fn()) as never,
}));
vi.mock(import("./ProjectDefaultsSettings"), async (original) => ({
  ...(await original()),
  ProjectDefaultsSettings: (() => null) as never,
}));
vi.mock(import("../../state/issueTrackers"), async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await importOriginal()),
    issueTrackerEnvironment: {
      connections: trackerState.connections,
      connect: { permissionAtom: () => Atom.make(trackerState.canEdit), label: "test-connect" },
      bindProject: { permissionAtom: () => Atom.make(trackerState.canEdit) },
      scopes: () => null,
    } as never,
  };
});
vi.mock(import("../../state/query"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    useEnvironmentQuery: ((query: Parameters<typeof original.useEnvironmentQuery>[0]) =>
      trackerState.connections.mock.results.some((result) => result.value === query)
        ? { data: trackerState.data, isPending: false, error: null }
        : original.useEnvironmentQuery(query)) as typeof original.useEnvironmentQuery,
  };
});
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    useAtomCommand: <A, E, W>(...args: Parameters<typeof original.useAtomCommand<A, E, W>>) => {
      const command = original.useAtomCommand(...args);
      return args[0].label === "test-connect" ? trackerState.connect : command;
    },
  };
});
vi.mock(import("./SettingsScopeContext"), async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal()),
    useSettingsScope: (() => {
      useSyncExternalStore(
        (listener) => {
          trackerState.scopeListeners.add(listener);
          return () => {
            trackerState.scopeListeners.delete(listener);
          };
        },
        () => JSON.stringify([trackerState.environmentId, trackerState.phase]),
      );
      return {
        scope: { kind: "all", environmentIds: [] },
        search: {},
        environment:
          trackerState.environmentId === null
            ? null
            : {
                environmentId: trackerState.environmentId,
                connection: { phase: trackerState.phase },
              },
        environments: [],
        target: null,
        connectedEnvironments: [],
        targets: [],
      };
    }) as never,
    useOptionalSettingsScope: () => null,
  };
});

import { IntegrationsSettingsPanel } from "./IntegrationsSettings";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listBrowserImportSources.mockClear();
  trackerState.environmentId = null;
  trackerState.phase = "connected";
  trackerState.canEdit = true;
  trackerState.data = null;
  trackerState.connections.mockReset().mockReturnValue(trackerState.connections);
  trackerState.connect.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function openSettings() {
  const router = createRouter({
    routeTree: createRootRoute({ component: IntegrationsSettingsPanel }),
    history: createMemoryHistory(),
  });
  await router.load();
  await act(async () =>
    root.render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    ),
  );
  await vi.waitFor(() => expect(container.querySelector("section#browser")).not.toBeNull());
}

describe("Integrations browser discovery", () => {
  it("does not scan browser files when entering or revisiting settings", async () => {
    await openSettings();
    expect(listBrowserImportSources).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    root = createRoot(container);
    await openSettings();
    expect(listBrowserImportSources).not.toHaveBeenCalled();
  });
});

async function openIntegrationsDom() {
  const router = createRouter({
    routeTree: createRootRoute({ component: IntegrationsSettingsPanel }),
    history: createMemoryHistory(),
  });
  await router.load();
  await act(async () => {
    trackerState.scopeListeners.forEach((listener) => listener());
    root.render(<RouterProvider router={router} />);
  });
}

describe("Integrations issue tracker setup", () => {
  it.each(["linear", "jira"] as const)("connects %s in the selected environment", async (kind) => {
    const tracker = IssueTrackerKind.make(kind);
    const displayName = kind === "linear" ? "Linear" : "Jira";
    trackerState.environmentId = "remote";
    trackerState.data = {
      trackers: [
        {
          tracker,
          displayName,
          host: null,
          scopeNoun: "project",
          credential: { label: "API key", helpUrl: null },
          connected: false,
          account: null,
          detail: null,
          scopes: [],
        },
      ],
      accounts: [],
      projectBindings: {},
      bindings: {},
    };
    await openIntegrationsDom();
    const section = container!.querySelector<HTMLElement>("#issue-trackers");
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain(displayName);
    expect([...container!.querySelectorAll("section")].indexOf(section!)).toBeLessThan(
      [...container!.querySelectorAll("section")].findIndex((item) => item.id === "browser"),
    );
    const credential = section!.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(credential).not.toBeNull();
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        credential,
        "fake-test-key",
      );
      credential.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      section!
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(trackerState.connect).toHaveBeenCalledExactlyOnceWith({
      environmentId: EnvironmentId.make("remote"),
      input: { tracker, token: { value: "fake-test-key" } },
    });
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        credential,
        "fake-unsaved-draft",
      );
      credential.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(credential.value).toBe("fake-unsaved-draft");
    trackerState.environmentId = "local";
    trackerState.canEdit = false;
    await openIntegrationsDom();
    expect(trackerState.connections).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: {},
    });
    const localSection = container!.querySelector("#issue-trackers")!;
    expect(localSection.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
    expect(localSection.querySelector("fieldset")!.disabled).toBe(true);
    await act(async () => {
      localSection
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(trackerState.connect).toHaveBeenCalledTimes(1);
  });

  it.each([null, "disconnected"])(
    "does not load tracker setup for an unavailable environment (%s)",
    async (phase) => {
      trackerState.environmentId = phase === null ? null : "remote";
      trackerState.phase = phase ?? "connected";
      await openIntegrationsDom();
      expect(trackerState.connections).not.toHaveBeenCalled();
      expect(container!.querySelector("#issue-trackers")).toBeNull();
    },
  );
});
