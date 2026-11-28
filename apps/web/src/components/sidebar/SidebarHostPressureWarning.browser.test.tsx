import { CALM_HOST_PRESSURE, EnvironmentId, type HostPressure, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { SidebarHostPressureWarning } from "./SidebarHostPressureWarning";

type Machine = { readonly environment: { readonly label: string }; hostPressure: HostPressure };
const state = vi.hoisted(() => ({
  configs: new Map<string, Machine>(),
  disconnected: new Set<string>(),
  presentationsAtom: Symbol("presentationsAtom"),
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: state.presentationsAtom },
}));
vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    useAtomValue: (atom: unknown, ...rest: ReadonlyArray<unknown>) =>
      atom === state.presentationsAtom
        ? new Map(
            [...state.configs.keys()].map((id) => [
              id,
              { connection: { phase: state.disconnected.has(id) ? "offline" : "connected" } },
            ]),
          )
        : (actual.useAtomValue as (...args: ReadonlyArray<unknown>) => unknown)(atom, ...rest),
  };
});
vi.mock("../../state/entities", () => ({
  useServerConfigs: () => state.configs,
  useThreadShell: () => null,
}));
vi.mock("../chat/useForceStopThread", () => ({
  useForceStopThread: () => ({
    canForceStop: false,
    stoppingThreadId: null,
    forceStopThread: async () => {},
  }),
}));

function setup(machines: Record<string, Partial<HostPressure>>, disconnected: string[] = []) {
  state.disconnected = new Set(disconnected);
  state.configs = new Map(
    Object.entries(machines).map(([label, pressure]) => [
      EnvironmentId.make(label),
      {
        environment: { label },
        hostPressure: {
          ...CALM_HOST_PRESSURE,
          heaviestAgents: [
            {
              threadId: ThreadId.make(`${label}-thread`),
              agent: "codex",
              memoryBytes: 6_000_000_000,
              cpuCores: 2,
            },
          ],
          ...pressure,
        },
      },
    ]),
  );
}

describe("SidebarHostPressureWarning", () => {
  it("names the machine when only one of several is strained", async () => {
    setup({ cups: { memory: "severe" }, nucbox: {} });
    await using screen = await render(<SidebarHostPressureWarning />);
    expect(screen.container.querySelectorAll("[data-host-pressure]")).toHaveLength(1);
    expect(screen.container.textContent).toBe("Memory is slowing agents on cups");
  });

  it("collapses strained machines into one notice listing each", async () => {
    setup({ cups: { memory: "severe" }, nucbox: { memory: "severe" }, vps: {} });
    await using screen = await render(<SidebarHostPressureWarning />);
    const pills = screen.container.querySelectorAll<HTMLButtonElement>("[data-host-pressure]");
    expect(pills).toHaveLength(1);
    expect(pills[0]!.textContent).toBe("Memory is slowing agents on 2 machines");

    await act(() => pills[0]!.click());
    await vi.waitFor(() => {
      const popup = document.querySelector('[data-slot="popover-popup"]');
      expect(popup?.textContent).toContain("cups");
      expect(popup?.textContent).toContain("nucbox");
      expect(popup?.textContent).not.toContain("vps");
    });
  });

  it("falls back to a generic title when machines are strained differently", async () => {
    setup({ cups: { memory: "severe" }, nucbox: { disk: "severe", diskFreeBytes: 1_000_000 } });
    await using screen = await render(<SidebarHostPressureWarning />);
    expect(screen.container.textContent).toBe("2 machines need attention");
  });

  it("leaves out a disconnected machine's last reading", async () => {
    setup({ cups: { memory: "severe" }, nucbox: { memory: "severe" } }, ["nucbox"]);
    await using screen = await render(<SidebarHostPressureWarning />);
    expect(screen.container.textContent).toBe("Memory is slowing agents on cups");
  });
});
