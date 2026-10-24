import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  consumer: { value: null as unknown, updates: 0 },
  listShells: vi.fn(),
  allowed: true,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: () => {
    const consumer = state.consumer;
    return [
      consumer.value,
      (next: unknown) => {
        const value = typeof next === "function" ? next(consumer.value) : next;
        if (!Object.is(value, consumer.value)) consumer.updates++;
        consumer.value = value;
      },
    ];
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("../../state/terminal", () => ({
  terminalEnvironment: { listShells: { permissionAtom: () => ({}) } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.listShells }));

async function setup() {
  vi.resetModules();
  state.listShells.mockReset();
  state.allowed = true;
  const { useTerminalShells } = await import("./useTerminalShells");
  const environmentId = EnvironmentId.make("shell-test");
  const shells = [{ id: "fish", label: "fish", command: "/bin/fish", args: [] }];
  const consumer = () => {
    const entry = { value: null as unknown, updates: 0 };
    return {
      entry,
      read: (id: EnvironmentId | null = environmentId) => {
        state.consumer = entry;
        return useTerminalShells(id);
      },
    };
  };
  return { consumer, shells };
}

describe("terminal shell discovery", () => {
  it("does not discover or expose loaded shells without a terminal grant", async () => {
    const { consumer, shells } = await setup();
    state.listShells.mockResolvedValue({ _tag: "Success", value: { shells } });
    const menu = consumer();
    await menu.read().load();
    state.allowed = false;
    state.listShells.mockClear();
    await menu.read().load();
    expect(menu.read()).toMatchObject({ canLoad: false, shells: null });
    expect(state.listShells).not.toHaveBeenCalled();
  });
  it("settles a failure and retries successfully", async () => {
    const { consumer, shells } = await setup();
    state.listShells.mockResolvedValueOnce({ _tag: "Failure" });
    state.listShells.mockResolvedValueOnce({ _tag: "Success", value: { shells } });
    const menu = consumer();
    await menu.read().load();
    expect(menu.read()).toMatchObject({ status: "error", shells: null });
    await menu.read().load();
    expect(menu.read()).toMatchObject({ status: "success", shells });
    expect(state.listShells).toHaveBeenCalledTimes(2);
  });

  it("loads for a consumer that rendered before another consumer finished discovery", async () => {
    const { consumer, shells } = await setup();
    state.listShells.mockResolvedValue({ _tag: "Success", value: { shells } });
    const first = consumer();
    const second = consumer();
    const stale = second.read();
    await first.read().load();
    await stale.load();
    expect(second.entry.updates).toBeGreaterThan(0);
    expect(second.read().shells).toEqual(shells);
    await second.read().load();
    expect(state.listShells).toHaveBeenCalledTimes(3);
  });

  it("refreshes installed and removed shells on subsequent loads", async () => {
    const { consumer, shells } = await setup();
    const addedShell = { id: "zsh", label: "zsh", command: "/bin/zsh", args: [] };
    state.listShells
      .mockResolvedValueOnce({ _tag: "Success", value: { shells } })
      .mockResolvedValueOnce({ _tag: "Success", value: { shells: [...shells, addedShell] } })
      .mockResolvedValueOnce({ _tag: "Success", value: { shells: [addedShell] } });
    const menu = consumer();
    await menu.read().load();
    expect(menu.read().shells).toEqual(shells);
    await menu.read().load();
    expect(menu.read().shells).toEqual([...shells, addedShell]);
    await menu.read().load();
    expect(menu.read().shells).toEqual([addedShell]);
  });

  it("shares an in-flight request and keeps results scoped to their environment", async () => {
    const { consumer, shells } = await setup();
    let resolveResponse!: (value: unknown) => void;
    const response = new Promise<unknown>((resolve) => {
      resolveResponse = resolve;
    });
    state.listShells.mockReturnValue(response);
    const first = consumer();
    const second = consumer();
    const firstLoad = first.read().load();
    const secondLoad = second.read().load();
    expect(state.listShells).toHaveBeenCalledTimes(1);
    resolveResponse({ _tag: "Success", value: { shells } });
    await Promise.all([firstLoad, secondLoad]);
    expect(first.read().shells).toEqual(shells);
    expect(second.read().shells).toEqual(shells);
    expect(second.read(EnvironmentId.make("other"))).toMatchObject({
      status: "idle",
      shells: null,
    });
  });
});
