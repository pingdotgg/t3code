// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  presentations: new Map() as LimitPresentations,
  navigate: vi.fn(),
  setOpenMobile: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => testState.presentations }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: {} },
}));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-09-03T12:00" }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => testState.navigate }));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({
    isMobile: false,
    open: true,
    openMobile: false,
    setOpenMobile: testState.setOpenMobile,
  }),
}));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../usage/UsageLimits", () => ({ barColor: () => "#d97757", PaceIcon: () => null }));

import { SidebarUsageLimits } from "./SidebarUsageLimits";

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const codex = provider({
  usageLimits: {
    checkedAt: "2026-09-03T11:00:00.000Z",
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 38,
        windowDurationMins: 300,
        resetsAt: "2026-09-03T14:00:00.000Z",
      },
    ],
  },
});

function presentationsFor(providers: readonly ServerProvider[]): LimitPresentations {
  return new Map([
    [
      EnvironmentId.make("test-environment"),
      { entry: { target: { label: "Local" } }, serverConfig: { providers } },
    ],
  ]);
}

describe("SidebarUsageLimits", () => {
  let renderer: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    testState.navigate.mockClear();
    testState.presentations = presentationsFor([codex]);
    container = document.createElement("div");
    document.body.append(container);
    renderer = createRoot(container);
  });

  afterEach(async () => {
    await act(() => renderer.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows each provider's remaining quota and opens Usage on click", async () => {
    await act(() => {
      renderer.render(<SidebarUsageLimits />);
    });

    const row = container.querySelector("button[aria-label^='Codex:']");
    expect(row?.getAttribute("aria-label")).toBe("Codex: Session 62% left, resets in 2h 0m");
    expect(row?.textContent).toContain("62%");
    expect(row?.textContent).toContain("↻ 2h 0m");

    await act(() => {
      (row as HTMLButtonElement).click();
    });
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/usage" });
  });

  it("renders nothing when no provider reports usable limits", async () => {
    testState.presentations = presentationsFor([
      provider({
        usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [] },
      }),
    ]);
    await act(() => {
      renderer.render(<SidebarUsageLimits />);
    });

    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("");
  });
});
