import { RegistryContext } from "@effect/atom-react";
import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type EnvironmentPresentation as SourcePresentation,
  type NetworkStatus,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const sources = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  const presentations = Atom.make<ReadonlyMap<EnvironmentId, SourcePresentation>>(new Map());
  const catalog = Atom.make<EnvironmentCatalogState>({ isReady: false, entries: new Map() });
  const network = Atom.make<NetworkStatus>("unknown");
  const lifecycle = { acquired: 0, released: 0 };
  function tracked<A>(source: Atom.Atom<A>) {
    return Atom.make((get) => {
      lifecycle.acquired++;
      get.addFinalizer(() => lifecycle.released++);
      return get(source);
    });
  }
  return {
    presentations,
    catalog,
    network,
    lifecycle,
    presentationsAtom: tracked(presentations),
    catalogValueAtom: tracked(catalog),
    networkStatusValueAtom: tracked(network),
    projectsAtom: Atom.make<readonly EnvironmentProject[]>([]),
  };
});

// Replace service-backed source atoms, leaving the production hooks and registry intact.
vi.mock("./presentation", () => ({
  environmentPresentations: { presentationsAtom: sources.presentationsAtom },
}));
vi.mock("../connection/catalog", () => ({
  environmentCatalog: {
    catalogValueAtom: sources.catalogValueAtom,
    networkStatusValueAtom: sources.networkStatusValueAtom,
  },
}));
vi.mock("./projects", () => ({ environmentProjects: { projectsAtom: sources.projectsAtom } }));
vi.mock("./preferences", () => ({ mobilePreferencesAtom: Atom.make(AsyncResult.initial()) }));
vi.mock("./threads", () => ({ environmentThreadDetails: {}, environmentThreadShells: {} }));
vi.mock("./server", () => ({
  serverEnvironment: {},
  environmentServerConfigsAtom: Atom.make(new Map()),
}));
vi.mock("./assets", () => ({ projectFaviconUrlAtom: vi.fn() }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../native/ProjectChipIconImages", () => ({
  projectGlyphImageAtom: vi.fn(),
  projectGlyphKey: vi.fn(),
}));

import { useEnvironments } from "./environments";
import {
  SettingsEnvironmentFilterProvider,
  useSettingsEnvironmentFilter,
} from "../features/settings/settings-environment-filter";

type EnvironmentView = ReturnType<typeof useEnvironments>;
type FilterView = ReturnType<typeof useSettingsEnvironmentFilter>;

function presentation(index: number, version = 0): SourcePresentation {
  const environmentId = EnvironmentId.make(`environment-${index}`);
  return {
    entry: {
      target: new PrimaryConnectionTarget({
        environmentId,
        label: `Machine ${index} version ${version}`,
        httpBaseUrl: `https://machine-${index}.example.test`,
        wsBaseUrl: `wss://machine-${index}.example.test`,
      }),
      profile: Option.none(),
      enabled: true,
    },
    connection: { phase: index === 7 ? "offline" : "connected", error: null, traceId: null },
    // These consumers only test presence and pass the config through unchanged.
    serverConfig:
      index === 6
        ? null
        : ({ cwd: `/workspace-${version}` } as NonNullable<SourcePresentation["serverConfig"]>),
  };
}

function entries(count = 8, version = 0) {
  return Array.from({ length: count }, (_, index) => {
    const value = presentation(index, version);
    return [value.entry.target.environmentId, value] as const;
  });
}

function setup(initial = new Map(entries())) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sources.lifecycle.acquired = 0;
  sources.lifecycle.released = 0;
  const tasks = new Set<() => void>();
  const registry = AtomRegistry.make({
    initialValues: [[sources.presentations, initial]],
    scheduleTask: (task) => {
      tasks.add(task);
      return () => tasks.delete(task);
    },
  });
  const flush = () => {
    for (const task of tasks) {
      tasks.delete(task);
      task();
    }
  };
  const environments = new Map<number, EnvironmentView>();
  const filters = new Map<number, FilterView>();
  function EnvironmentReader({ id }: { id: number }) {
    const environment = useEnvironments();
    useLayoutEffect(() => {
      environments.set(id, environment);
    });
    return null;
  }
  function Reader({ id, includeEnvironments }: { id: number; includeEnvironments: boolean }) {
    const filter = useSettingsEnvironmentFilter();
    useLayoutEffect(() => {
      filters.set(id, filter);
    });
    return includeEnvironments ? <EnvironmentReader id={id} /> : null;
  }
  const root = createRoot(document.createElement("div"));
  return {
    registry,
    environments,
    filters,
    render(readers = 3, open = true, includeEnvironments = true) {
      act(() => {
        root.render(
          <RegistryContext.Provider value={registry}>
            {Array.from({ length: 3 }, (_, id) => (
              <SettingsEnvironmentFilterProvider key={id} open={open}>
                {id < readers && <Reader id={id} includeEnvironments={includeEnvironments} />}
              </SettingsEnvironmentFilterProvider>
            ))}
          </RegistryContext.Provider>,
        );
      });
      act(flush);
    },
    update(next: ReadonlyMap<EnvironmentId, SourcePresentation>) {
      act(() => {
        registry.set(sources.presentations, next);
        flush();
      });
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      flush();
      registry.dispose();
    },
  };
}

it.each([1, 3])("projects and filters each source version once with %s readers", (readers) => {
  const counts = { mapped: 0, filtered: 0 };
  class CountedMap extends Map<EnvironmentId, SourcePresentation> {
    override *entries(): MapIterator<[EnvironmentId, SourcePresentation]> {
      for (const entry of super.entries()) {
        counts.mapped++;
        yield entry;
      }
    }
  }
  const version = (revision: number) =>
    new CountedMap(
      entries(8, revision).map(([id, value]) => [
        id,
        {
          ...value,
          connection: {
            ...value.connection,
            get phase() {
              counts.filtered++;
              return revision === 10 && id === EnvironmentId.make("environment-0")
                ? "offline"
                : value.connection.phase;
            },
          },
        },
      ]),
    );
  using screen = setup(version(0));
  screen.render(readers, true, false);
  for (let revision = 1; revision < 11; revision++) screen.update(version(revision));
  const beforeReread = { ...counts };
  act(() => {
    screen.registry.set(sources.catalog, { isReady: true, entries: new Map() });
    screen.registry.set(sources.network, "offline");
  });
  screen.render(readers, true, false);
  expect(counts).toEqual(beforeReread);
  console.info("environment projection operations", { readers, ...counts });
  expect(counts).toEqual({ mapped: 88, filtered: 88 });
  expect(screen.filters.get(0)!.availableTargets).toHaveLength(5);
});

it("shares environments and connected targets while preserving independent Settings scopes", () => {
  using screen = setup();
  screen.render();
  const first = screen.environments.get(0)!;
  const firstTargets = screen.filters.get(0)!.availableTargets;
  for (const id of [1, 2]) {
    expect(screen.environments.get(id)!.environments).toBe(first.environments);
    expect(screen.filters.get(id)!.availableTargets).toBe(firstTargets);
  }
  const excluded = firstTargets[0]!.environmentId;
  act(() => screen.filters.get(0)!.toggleEnvironment(excluded));
  expect(
    screen.filters.get(0)!.selectedTargets.map((target) => target.environmentId),
  ).not.toContain(excluded);
  expect(screen.filters.get(1)!.selectedIds).toBeNull();
  expect(screen.filters.get(1)!.selectedTargets).toContain(firstTargets[0]);
  act(() => screen.filters.get(0)!.selectProject("page-project"));
  expect(screen.filters.get(0)!.selectedProjectKey).toBe("page-project");
  expect(screen.filters.get(1)!.selectedProjectKey).toBeNull();
  act(() => screen.filters.get(0)!.selectAll());
  expect(screen.filters.get(0)!.selectedTargets).toEqual(firstTargets);
  screen.render(3, false);
  expect(screen.filters.get(0)!.selectedProjectKey).toBeNull();
});

it("passes through presentation changes and map order, including empty and disconnected targets", () => {
  const initial = new Map(entries(2));
  using screen = setup(initial);
  screen.render();
  const [firstId, secondId] = [...initial.keys()];
  const first = initial.get(firstId!)!;
  const other = initial.get(secondId!)!;
  const check = (
    next: Map<EnvironmentId, SourcePresentation>,
    connected: readonly EnvironmentId[],
  ) => {
    screen.update(next);
    for (const id of [0, 1, 2]) {
      const view = screen.environments.get(id)!;
      expect(view.presentationById).toBe(next);
      expect(view.environments.map((entry) => entry.environmentId)).toEqual([...next.keys()]);
      expect(screen.filters.get(id)!.availableTargets.map((entry) => entry.environmentId)).toEqual(
        connected,
      );
      for (const environment of view.environments) {
        const source = next.get(environment.environmentId)!;
        expect(environment.entry).toBe(source.entry);
        expect(environment.connection).toBe(source.connection);
        expect(environment.serverConfig).toBe(source.serverConfig);
      }
    }
  };
  const added = presentation(2);
  check(new Map([...initial, [added.entry.target.environmentId, added]]), [
    firstId!,
    secondId!,
    added.entry.target.environmentId,
  ]);
  check(
    new Map([
      [secondId!, other],
      [firstId!, first],
    ]),
    [secondId!, firstId!],
  );
  const bearer = new BearerConnectionTarget({
    environmentId: firstId!,
    label: "Renamed",
    connectionId: "direct",
  });
  const profile = new BearerConnectionProfile({
    environmentId: firstId!,
    label: "Direct",
    connectionId: "direct",
    httpBaseUrl: "https://new.example.test",
    wsBaseUrl: "wss://new.example.test",
  });
  const changed: SourcePresentation = {
    ...first,
    entry: {
      target: bearer,
      profile: Option.some(profile),
      enabled: false,
      alternateRoutes: [
        {
          target: new RelayConnectionTarget({ environmentId: firstId!, label: "Relay" }),
          profile: Option.none(),
        },
      ],
    },
    serverConfig: { ...first.serverConfig!, cwd: "/changed" },
  };
  check(new Map([[firstId!, changed]]), [firstId!]);
  expect(screen.environments.get(0)!.environments[0]).toMatchObject({
    label: "Renamed",
    displayUrl: "https://new.example.test",
    relayManaged: true,
  });
  const rerouted: SourcePresentation = {
    ...changed,
    entry: {
      ...changed.entry,
      profile: Option.some(
        new BearerConnectionProfile({ ...profile, httpBaseUrl: "https://route.example.test" }),
      ),
      alternateRoutes: [],
    },
  };
  check(new Map([[firstId!, rerouted]]), [firstId!]);
  expect(screen.environments.get(0)!.environments[0]).toMatchObject({
    displayUrl: "https://route.example.test",
    relayManaged: false,
  });
  const offline: SourcePresentation = {
    ...rerouted,
    connection: { phase: "offline", error: null, traceId: null },
  };
  check(
    new Map([
      [firstId!, offline],
      [secondId!, { ...other, serverConfig: null }],
    ]),
    [],
  );
  check(
    new Map([
      [firstId!, rerouted],
      [secondId!, other],
    ]),
    [firstId!, secondId!],
  );
  check(new Map(), []);
});

it("keeps projection identity on readiness/network changes and releases the final source reader", () => {
  using screen = setup();
  screen.render(0, false);
  expect(sources.lifecycle).toEqual({ acquired: 0, released: 0 });
  screen.render();
  screen.update(new Map(entries()));
  expect(sources.lifecycle.acquired - sources.lifecycle.released).toBe(3);
  const environments = screen.environments.get(0)!.environments;
  const targets = screen.filters.get(0)!.availableTargets;
  act(() => {
    screen.registry.set(sources.catalog, { isReady: true, entries: new Map() });
    screen.registry.set(sources.network, "offline");
  });
  for (const id of [0, 1, 2]) {
    expect(screen.environments.get(id)).toMatchObject({ isReady: true, networkStatus: "offline" });
    expect(screen.environments.get(id)!.environments).toBe(environments);
    expect(screen.filters.get(id)!.availableTargets).toBe(targets);
  }
  screen.render(1);
  expect(sources.lifecycle.acquired - sources.lifecycle.released).toBe(3);
  screen.render(0, false);
  expect(sources.lifecycle.acquired).toBe(sources.lifecycle.released);
  const acquired = sources.lifecycle.acquired;
  screen.render();
  expect(sources.lifecycle.acquired).toBe(acquired + 3);
  screen.update(new Map(entries()));
  expect(screen.filters.get(0)!.availableTargets).toHaveLength(6);
  screen.render(0, false);
  expect(sources.lifecycle.acquired).toBe(sources.lifecycle.released);
});
