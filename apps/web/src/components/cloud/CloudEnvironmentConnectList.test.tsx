import type { Discovery } from "@t3tools/client-runtime/relay";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
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
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipPopup: () => null,
}));
vi.mock("../ui/checkbox", () => ({
  Checkbox: (props: {
    checked: boolean;
    disabled: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={props.checked}
      disabled={props.disabled}
      onChange={(event) => props.onCheckedChange(event.target.checked)}
    />
  ),
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogPopup: ({ children }: { children: ReactNode }) => children,
  DialogHeader: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) => children,
  DialogDescription: ({ children }: { children: ReactNode }) => children,
  DialogPanel: ({ children }: { children: ReactNode }) => children,
  DialogFooter: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../ui/input", () => ({
  Input: (props: { value: string; onChange: (event: { target: { value: string } }) => void }) => (
    <input {...props} />
  ),
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => children,
  MenuTrigger: ({ children, render }: { children: ReactNode; render: ReactNode }) => (
    <>{render ?? children}</>
  ),
  MenuPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
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
  discovery.register.mockReset().mockResolvedValue(AsyncResult.success(undefined));
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
  it("offers account deletion for a discovered environment", async () => {
    discovery.listEnvironments.mockResolvedValue(linkedMachines);
    const onDeregister = vi.fn();
    await act(async () => {
      renderer = create(
        <CloudEnvironmentConnectRows
          primaryEnvironmentId={null}
          savedEnvironments={[]}
          onDeregister={onDeregister}
        />,
      );
    });

    const deleteButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Delete from T3 Connect…"));
    expect(deleteButton).toBeDefined();
    await act(async () => deleteButton!.props.onClick());
    expect(onDeregister).toHaveBeenCalledWith(linkedMachines.get(newMachineId)!.environment);
  });

  it("renames a discovered environment for the account without adding it locally", async () => {
    discovery.listEnvironments.mockResolvedValue(linkedMachines);
    const onRenameGlobally = vi.fn().mockResolvedValue(true);
    await act(async () => {
      renderer = create(
        <CloudEnvironmentConnectRows
          primaryEnvironmentId={null}
          savedEnvironments={[]}
          onDeregister={vi.fn()}
          onRenameGlobally={onRenameGlobally}
        />,
      );
    });
    const renameButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Rename environment…"))!;
    await act(async () => renameButton.props.onClick());
    await act(async () =>
      renderer!.root.findByType("input").props.onChange({ target: { value: "Work" } }),
    );
    const saveButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Save"))!;
    await act(async () => saveButton.props.onClick());

    expect(onRenameGlobally).toHaveBeenCalledWith(newMachineId, "Work");
    expect(discovery.register).not.toHaveBeenCalled();
  });

  it("keeps a discovered environment's name draft visible during discovery refresh", async () => {
    discovery.listEnvironments.mockResolvedValue(linkedMachines);
    await act(async () => {
      renderer = create(
        <CloudEnvironmentConnectRows
          primaryEnvironmentId={null}
          savedEnvironments={[]}
          onDeregister={vi.fn()}
          onRenameGlobally={vi.fn().mockResolvedValue(true)}
        />,
      );
    });
    const renameButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Rename environment…"))!;
    await act(async () => renameButton.props.onClick());
    await act(async () =>
      renderer!.root.findByType("input").props.onChange({ target: { value: "My work laptop" } }),
    );

    await act(async () => {
      publish({ ...discovery.state!, environments: new Map(), refreshing: true });
    });

    expect(renderer!.root.findByType("input").props.value).toBe("My work laptop");
  });

  it("does not close another environment's draft when an earlier rename finishes", async () => {
    const secondMachineId = EnvironmentId.make("home-desktop");
    const firstMachine = linkedMachines.get(newMachineId)!;
    discovery.listEnvironments.mockResolvedValue(
      new Map([
        ...linkedMachines,
        [
          secondMachineId,
          {
            ...firstMachine,
            environment: {
              ...firstMachine.environment,
              environmentId: secondMachineId,
              label: "Home desktop",
            },
          },
        ],
      ]),
    );
    let finishFirstRename!: (renamed: boolean) => void;
    const onRenameGlobally = vi.fn(
      () => new Promise<boolean>((resolve) => (finishFirstRename = resolve)),
    );
    await act(async () => {
      renderer = create(
        <CloudEnvironmentConnectRows
          primaryEnvironmentId={null}
          savedEnvironments={[]}
          onDeregister={vi.fn()}
          onRenameGlobally={onRenameGlobally}
        />,
      );
    });
    const renameButtons = renderer!.root
      .findAllByType("button")
      .filter((button) => button.children.includes("Rename environment…"));
    await act(async () => renameButtons[0]!.props.onClick());
    const saveButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Save"))!;
    await act(async () => saveButton.props.onClick());
    await act(async () => renderer!.root.findByProps({ open: true }).props.onOpenChange(false));
    await act(async () => renameButtons[1]!.props.onClick());
    await act(async () =>
      renderer!.root.findByType("input").props.onChange({ target: { value: "Home draft" } }),
    );

    await act(async () => finishFirstRename(true));

    expect(renderer!.root.findByType("input").props.value).toBe("Home draft");
    expect(onRenameGlobally).toHaveBeenCalledWith(newMachineId, "Work laptop");
  });

  it("blocks deletion while adding a discovered environment", async () => {
    discovery.listEnvironments.mockResolvedValue(linkedMachines);
    let finishRegistration!: (result: AtomCommandResult<void, never>) => void;
    discovery.register.mockReturnValue(
      new Promise((resolve) => {
        finishRegistration = resolve;
      }),
    );
    await act(async () => {
      renderer = create(
        <CloudEnvironmentConnectRows
          primaryEnvironmentId={null}
          savedEnvironments={[]}
          onDeregister={vi.fn()}
        />,
      );
    });

    const addButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Add"))!;
    await act(async () => addButton.props.onClick());
    const menuButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "More actions for Work laptop")!;
    expect(menuButton.props.disabled).toBe(true);

    await act(async () => finishRegistration(AsyncResult.success(undefined)));
    expect(menuButton.props.disabled).toBe(false);
  });

  it("does not offer local rename for an incompatible discovered environment", async () => {
    const base = linkedMachines.get(newMachineId)!;
    discovery.listEnvironments.mockResolvedValue(
      new Map([
        [
          newMachineId,
          {
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
                orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1,
                capabilities: { repositoryIdentity: true },
              },
            }),
          },
        ],
      ]),
    );
    await act(async () => {
      renderer = create(
        <CloudEnvironmentConnectRows
          primaryEnvironmentId={null}
          savedEnvironments={[]}
          onDeregister={vi.fn()}
        />,
      );
    });

    expect(discovery.register).not.toHaveBeenCalled();
  });

  it("signals that the section can expand after initial discovery settles", async () => {
    let finishDiscovery!: (environments: DiscoveredEnvironments) => void;
    discovery.listEnvironments.mockReturnValue(
      new Promise((resolve) => {
        finishDiscovery = resolve;
      }),
    );
    const onDiscoveryReady = vi.fn();
    await act(async () => {
      renderer = create(
        <CloudEnvironmentConnectRows
          primaryEnvironmentId={null}
          savedEnvironments={[]}
          onDiscoveryReady={onDiscoveryReady}
        />,
      );
    });
    expect(onDiscoveryReady).not.toHaveBeenCalled();
    await act(async () => {
      finishDiscovery(linkedMachines);
    });
    expect(onDiscoveryReady).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findByType("button").children).toEqual(["Add"]);
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
    await act(async () => {
      renderer = create(<Setup />);
    });
    expect(discovery.register).not.toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenCalledWith(newMachineId, false);
    expect(renderer!.root.findByType("input").props.checked).toBe(false);
    expect(renderer!.root.findByType("input").props.disabled).toBe(true);
    expect(renderer!.root.findAllByType("span").flatMap((span) => span.children)).toContain(
      "Client not supported",
    );
    await act(async () => {
      await renderer!.root.findByType("input").props.onChange({ target: { checked: true } });
    });
    expect(discovery.register).not.toHaveBeenCalled();
    await act(async () =>
      publish({
        ...discovery.state!,
        environments: new Map([[newMachineId, entry(ORCHESTRATION_PROTOCOL_VERSION)]]),
      }),
    );
    expect(discovery.register).not.toHaveBeenCalled();
    expect(renderer!.root.findByType("input").props.checked).toBe(false);
    expect(renderer!.root.findByType("input").props.disabled).toBe(false);
    await act(async () => {
      await renderer!.root.findByType("input").props.onChange({ target: { checked: true } });
    });
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
    await act(async () => {
      renderer = create(<Setup />);
    });

    expect(discovery.register).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findByType("input").props.checked).toBe(true);
    await act(async () => {
      await renderer!.root.findByType("input").props.onChange({ target: { checked: false } });
    });
    await act(async () => {
      publish({ ...discovery.state!, environments: new Map(linkedMachines) });
    });
    expect(renderer!.root.findByType("input").props.checked).toBe(false);
    expect(discovery.register).toHaveBeenCalledTimes(1);
  });

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
    expect(renderer!.root.findByType("button").children).toEqual(["Add"]);
    await advance(30_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(2);
  });

  it("keeps a discovered computer visible when it is added to the browser", async () => {
    discovery.listEnvironments.mockResolvedValue(linkedMachines);
    await mount();
    expect(renderer!.root.findByType("button").children).toEqual(["Add"]);
    await act(async () => {
      renderer!.update(
        <CloudEnvironmentConnectRows
          primaryEnvironmentId={null}
          savedEnvironments={[
            {
              environmentId: newMachineId,
              connection: { phase: "connected", error: null, traceId: null },
            },
          ]}
          showSavedEnvironments
          refreshWhileEmpty
        />,
      );
    });
    expect(renderer!.root.findAllByType("p").map((node) => node.children)).toContainEqual([
      "Work laptop",
    ]);
    expect(renderer!.root.findByType("button").children).toEqual(["Connected"]);
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
