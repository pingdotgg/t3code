import type { Discovery } from "@t3tools/client-runtime/relay";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, type ButtonHTMLAttributes } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type DiscoveredEnvironments = Discovery.RelayEnvironmentDiscoveryState["environments"];

const discovery = vi.hoisted(() => ({
  state: null as Discovery.RelayEnvironmentDiscoveryState | null,
  listeners: new Set<() => void>(),
  refreshCommand: Symbol("refresh"),
  registerCommand: Symbol("register"),
  refresh: vi.fn<() => Promise<AtomCommandResult<void, never>>>(),
  register: vi.fn(),
  listEnvironments: vi.fn<() => Promise<DiscoveredEnvironments>>(),
}));

vi.mock("~/state/relay", () => ({
  relayEnvironmentDiscovery: { refresh: discovery.refreshCommand },
}));
vi.mock("~/connection/catalog", () => ({
  environmentCatalog: { register: discovery.registerCommand },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === discovery.refreshCommand ? discovery.refresh : discovery.register,
}));
vi.mock("~/state/environments", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    discovery.listeners.add(listener);
    return () => discovery.listeners.delete(listener);
  };
  const read = () => {
    if (discovery.state === null) throw new Error("Discovery fixture is not initialized");
    return discovery.state;
  };
  return { useRelayEnvironmentDiscovery: () => useSyncExternalStore(subscribe, read, read) };
});
vi.mock("../ConnectionStatusDot", () => ({ ConnectionStatusDot: () => null }));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";

const newMachineId = EnvironmentId.make("new-computer");
const linkedMachines: DiscoveredEnvironments = new Map([
  [
    newMachineId,
    {
      environment: {
        environmentId: newMachineId,
        label: "Work laptop",
        endpoint: {
          httpBaseUrl: "https://relay.example.test",
          wsBaseUrl: "wss://relay.example.test/ws",
          providerKind: "manual",
        },
        linkedAt: "2026-09-05T12:00:00.000Z",
      },
      availability: "online",
      status: Option.none(),
      error: Option.none(),
    },
  ],
]);

let renderer: ReactTestRenderer | null;
let page: EventTarget & { visibilityState: DocumentVisibilityState };
let browserWindow: EventTarget;

function publish(state: Discovery.RelayEnvironmentDiscoveryState) {
  discovery.state = state;
  for (const listener of discovery.listeners) listener();
}

async function mount(refreshWhileEmpty = true) {
  await act(async () => {
    renderer = create(
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={null}
        savedEnvironments={[]}
        showSavedEnvironments
        refreshWhileEmpty={refreshWhileEmpty}
        empty={<p>Waiting for your computer to connect.</p>}
      />,
    );
  });
}

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  page = Object.assign(new EventTarget(), { visibilityState: "visible" as const });
  browserWindow = new EventTarget();
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", browserWindow);
  renderer = null;
  discovery.listeners.clear();
  discovery.state = {
    environments: new Map(),
    refreshing: false,
    offline: false,
    error: Option.none(),
  };
  discovery.listEnvironments.mockReset().mockResolvedValue(new Map());
  discovery.refresh.mockReset().mockImplementation(async () => {
    publish({ environments: new Map(), refreshing: true, offline: false, error: Option.none() });
    const environments = await discovery.listEnvironments();
    publish({ environments, refreshing: false, offline: false, error: Option.none() });
    return AsyncResult.success(undefined);
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("cloud onboarding discovery", () => {
  it("shows a newly linked computer without remounting and stops polling once found", async () => {
    discovery.listEnvironments
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(linkedMachines);
    await mount();
    expect(renderer!.root.findByType("p").children).toEqual([
      "Waiting for your computer to connect.",
    ]);

    await advance(5_000);

    expect(renderer!.root.findAllByType("p").map((node) => node.children)).toContainEqual([
      "Work laptop",
    ]);
    expect(renderer!.root.findByType("button").children).toEqual(["Connect"]);
    await advance(30_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(2);
  });

  it("waits while hidden and refreshes immediately when visible again", async () => {
    page.visibilityState = "hidden";
    await mount();
    await advance(30_000);
    expect(discovery.listEnvironments).not.toHaveBeenCalled();

    await act(async () => {
      page.visibilityState = "visible";
      page.dispatchEvent(new Event("visibilitychange"));
    });
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(1);

    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    browserWindow.dispatchEvent(new Event("focus"));
    await advance(30_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(1);
  });

  it("does not overlap a slow refresh or restart polling after unmount", async () => {
    let resolveRefresh!: (environments: DiscoveredEnvironments) => void;
    const pending = new Promise<DiscoveredEnvironments>((resolve) => {
      resolveRefresh = resolve;
    });
    discovery.listEnvironments.mockResolvedValueOnce(new Map()).mockReturnValueOnce(pending);
    await mount();
    await advance(5_000);
    expect(renderer!.root.findByType("p").children).toEqual([
      "Waiting for your computer to connect.",
    ]);

    browserWindow.dispatchEvent(new Event("focus"));
    page.dispatchEvent(new Event("visibilitychange"));
    await advance(30_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(2);

    await act(async () => renderer!.unmount());
    renderer = null;
    await act(async () => resolveRefresh(new Map()));
    await advance(30_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(2);
  });

  it("pauses while offline and resumes when discovery is online", async () => {
    await mount();
    await act(async () => publish({ ...discovery.state!, offline: true }));
    await advance(30_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(1);

    await act(async () => publish({ ...discovery.state!, offline: false }));
    await advance(5_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(2);
  });

  it("does not add polling to other cloud lists", async () => {
    await mount(false);
    await advance(30_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(1);
  });
});
