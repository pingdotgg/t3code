import { RELAY_TUNNEL_RELEASED_MESSAGE, type Discovery } from "@t3tools/client-runtime/relay";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type DiscoveredEnvironments = Discovery.RelayEnvironmentDiscoveryState["environments"];

const discovery = vi.hoisted(() => ({
  state: null as Discovery.RelayEnvironmentDiscoveryState | null,
  listeners: new Set<() => void>(),
  refresh: vi.fn<() => Promise<AtomCommandResult<void, never>>>(),
  register: vi.fn(),
  listEnvironments: vi.fn<() => Promise<DiscoveredEnvironments>>(),
}));

vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { relayEnvironmentDiscovery } = await import("~/state/relay");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === relayEnvironmentDiscovery.refresh
        ? discovery.refresh
        : discovery.register) as never,
  };
});
vi.mock(import("~/state/environments"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    discovery.listeners.add(listener);
    return () => discovery.listeners.delete(listener);
  };
  const read = () => {
    if (discovery.state === null) throw new Error("Discovery fixture is not initialized");
    return discovery.state;
  };
  return {
    ...(await original()),
    useRelayEnvironmentDiscovery: () => useSyncExternalStore(subscribe, read, read),
  };
});

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

let root: Root | null;
let container: HTMLDivElement;
let visibility: DocumentVisibilityState;

function publish(state: Discovery.RelayEnvironmentDiscoveryState) {
  discovery.state = state;
  for (const listener of discovery.listeners) listener();
}

async function render(element: React.ReactElement) {
  root ??= createRoot(container);
  await act(async () => root!.render(element));
}

async function mount(refreshWhileEmpty = true) {
  await render(
    <CloudEnvironmentConnectRows
      primaryEnvironmentId={null}
      savedEnvironments={[]}
      showSavedEnvironments
      refreshWhileEmpty={refreshWhileEmpty}
      empty={<p>Waiting for your computer to connect.</p>}
    />,
  );
}

const text = () => container.textContent ?? "";
const button = () =>
  [...container.querySelectorAll("button")].find((element) => element.textContent !== "");
const checkbox = () => container.querySelector<HTMLElement>('[role="checkbox"]')!;
const checked = () => checkbox().getAttribute("aria-checked") === "true";
const toggle = () => act(async () => checkbox().click());
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  container = document.createElement("div");
  document.body.append(container);
  root = null;
  discovery.listeners.clear();
  discovery.state = {
    environments: new Map(),
    refreshing: false,
    offline: false,
    error: Option.none(),
  };
  discovery.listEnvironments.mockReset().mockResolvedValue(new Map());
  discovery.register.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  discovery.refresh.mockReset().mockImplementation(async () => {
    publish({ environments: new Map(), refreshing: true, offline: false, error: Option.none() });
    const environments = await discovery.listEnvironments();
    publish({ environments, refreshing: false, offline: false, error: Option.none() });
    return AsyncResult.success(undefined);
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cloud environment offline reasons", () => {
  it("tells the user to update a computer whose idle tunnel was removed", async () => {
    const base = linkedMachines.get(newMachineId)!;
    const offlineEntry = (offlineReason?: "tunnel_released") => ({
      ...base,
      availability: "offline" as const,
      status: Option.some({
        environmentId: newMachineId,
        endpoint: base.environment.endpoint,
        status: "offline" as const,
        checkedAt: "2026-09-15T00:00:00Z",
        error: "Managed endpoint health request failed.",
        ...(offlineReason ? { offlineReason } : {}),
      }),
    });

    discovery.listEnvironments.mockResolvedValue(new Map([[newMachineId, offlineEntry()]]));
    await mount();
    expect(text()).toContain("T3 Connect · Not added · Relay offline");

    await act(async () => {
      publish({
        environments: new Map([[newMachineId, offlineEntry("tunnel_released")]]),
        refreshing: false,
        offline: false,
        error: Option.none(),
      });
    });
    expect(text()).toContain(RELAY_TUNNEL_RELEASED_MESSAGE);
  });
});

describe("cloud onboarding discovery", () => {
  it("signals that the section can expand after initial discovery settles", async () => {
    let finishDiscovery!: (environments: DiscoveredEnvironments) => void;
    discovery.listEnvironments.mockReturnValue(
      new Promise((resolve) => {
        finishDiscovery = resolve;
      }),
    );
    const onDiscoveryReady = vi.fn();
    await render(
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={null}
        savedEnvironments={[]}
        onDiscoveryReady={onDiscoveryReady}
      />,
    );
    expect(onDiscoveryReady).not.toHaveBeenCalled();
    await act(async () => {
      finishDiscovery(linkedMachines);
    });
    expect(onDiscoveryReady).toHaveBeenCalledTimes(1);
    expect(button()?.textContent).toBe("Add");
  });

  it("keeps incompatible discoveries unselected until the user enables a compatible server", async () => {
    const base = linkedMachines.get(newMachineId)!;
    const entry = (protocolVersion: number) => ({
      ...base,
      status: Option.some({
        environmentId: newMachineId,
        endpoint: base.environment.endpoint,
        status: "online" as const,
        checkedAt: "2026-09-15T00:00:00Z",
        descriptor: {
          environmentId: newMachineId,
          label: base.environment.label,
          platform: { os: "linux" as const, arch: "x64" as const },
          serverVersion: "1.0.0",
          orchestrationProtocolVersion: protocolVersion,
          capabilities: { repositoryIdentity: true },
        },
      }),
    });
    discovery.listEnvironments.mockResolvedValue(
      new Map([[newMachineId, entry(ORCHESTRATION_PROTOCOL_VERSION + 1)]]),
    );
    const onSelectionChange = vi.fn();
    const autoSelectedComputers = new Set<EnvironmentId>();
    function Setup() {
      const [selectedIds, setSelectedIds] = useState<ReadonlySet<EnvironmentId>>(
        new Set([newMachineId]),
      );
      return (
        <CloudEnvironmentConnectRows
          primaryEnvironmentId={null}
          savedEnvironments={[]}
          showSavedEnvironments
          selection={{
            autoSelectedComputers,
            selectedIds,
            onChange: (id, checked) => {
              onSelectionChange(id, checked);
              setSelectedIds((current) => {
                const next = new Set(current);
                if (checked) next.add(id);
                else next.delete(id);
                return next;
              });
            },
          }}
        />
      );
    }
    await render(<Setup />);
    expect(discovery.register).not.toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenCalledWith(newMachineId, false);
    expect(checked()).toBe(false);
    expect(checkbox().hasAttribute("data-disabled")).toBe(true);
    expect(text()).toContain("Client not supported");
    expect(text()).toContain("Update your app");
    await toggle();
    expect(discovery.register).not.toHaveBeenCalled();
    await act(async () =>
      publish({
        ...discovery.state!,
        environments: new Map([[newMachineId, entry(ORCHESTRATION_PROTOCOL_VERSION)]]),
      }),
    );
    expect(discovery.register).not.toHaveBeenCalled();
    expect(checked()).toBe(false);
    expect(checkbox().hasAttribute("data-disabled")).toBe(false);
    await toggle();
    expect(discovery.register).toHaveBeenCalledTimes(1);
  });

  it("connects and selects discovered computers by default without overwriting deselection", async () => {
    discovery.listEnvironments.mockResolvedValue(linkedMachines);
    const autoSelectedComputers = new Set<EnvironmentId>();
    function Setup() {
      const [selectedIds, setSelectedIds] = useState<ReadonlySet<EnvironmentId>>(new Set());
      return (
        <CloudEnvironmentConnectRows
          primaryEnvironmentId={null}
          savedEnvironments={[]}
          showSavedEnvironments
          selection={{
            autoSelectedComputers,
            selectedIds,
            onChange: (id, checked) =>
              setSelectedIds((current) => {
                const next = new Set(current);
                if (checked) next.add(id);
                else next.delete(id);
                return next;
              }),
          }}
        />
      );
    }
    await render(<Setup />);

    expect(discovery.register).toHaveBeenCalledTimes(1);
    expect(checked()).toBe(true);
    await toggle();
    await act(async () => {
      publish({ ...discovery.state!, environments: new Map(linkedMachines) });
    });
    expect(checked()).toBe(false);
    expect(discovery.register).toHaveBeenCalledTimes(1);
  });

  it("shows a newly linked computer without remounting and stops polling once found", async () => {
    discovery.listEnvironments
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(linkedMachines);
    await mount();
    expect(text()).toBe("Waiting for your computer to connect.");

    await advance(5_000);

    expect(text()).toContain("Work laptop");
    expect(button()?.textContent).toBe("Add");
    await advance(30_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(2);
  });

  it("keeps a discovered computer visible when it is added to the browser", async () => {
    discovery.listEnvironments.mockResolvedValue(linkedMachines);
    await mount();
    expect(button()?.textContent).toBe("Add");
    await render(
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={null}
        savedEnvironments={[
          {
            environmentId: newMachineId,
            connection: { phase: "connected", error: null, traceId: null },
            relayManaged: true,
          },
        ]}
        showSavedEnvironments
        refreshWhileEmpty
      />,
    );
    expect(text()).toContain("Work laptop");
    expect(button()?.textContent).toBe("Connected");
  });

  it("waits while hidden and refreshes immediately when visible again", async () => {
    visibility = "hidden";
    await mount();
    await advance(30_000);
    expect(discovery.listEnvironments).not.toHaveBeenCalled();

    await act(async () => setVisibility("visible"));
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    window.dispatchEvent(new Event("focus"));
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
    expect(text()).toBe("Waiting for your computer to connect.");

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(30_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(2);

    await act(async () => root!.unmount());
    root = null;
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
