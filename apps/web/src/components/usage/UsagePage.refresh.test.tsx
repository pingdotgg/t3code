import { EnvironmentId, ProviderInstanceId, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { StrictMode, act } from "react";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  presentations: new Map(),
  refreshProviders: vi.fn(async () => undefined),
  metric: "limits",
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "keybindings" ? DEFAULT_RESOLVED_KEYBINDINGS : state.presentations,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useCanGoBack: () => false,
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: null },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: null },
  primaryServerKeybindingsAtom: "keybindings",
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.refreshProviders }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => "24h" }));
vi.mock("../../state/usage", () => ({
  useUsage: () => ({
    merged: mergeUsage([], USAGE_CONTRACT_VERSION),
    environments: [
      {
        environmentId: EnvironmentId.make("test"),
        label: "Test",
        isPending: false,
        error: null,
        summary: null,
      },
    ],
    selectedEnvironments: [
      {
        environmentId: EnvironmentId.make("test"),
        label: "Test",
        isPending: false,
        error: null,
        summary: null,
      },
    ],
    isPending: false,
    isPartial: false,
    refresh: async () => undefined,
  }),
}));
vi.mock("./usagePagePreferences", () => ({
  readUsagePagePreferences: () => ({ metric: state.metric, windowDays: 30 }),
  saveUsagePagePreferences: vi.fn(),
}));
vi.mock("../ui/button", () => ({ Button: "button", InlineButton: "button" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectItem: "option",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "span",
}));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("../ui/tooltip", () => ({ Tooltip: "div", TooltipPopup: "div", TooltipTrigger: "div" }));
vi.mock("../ui/popover", () => ({ Popover: "div", PopoverPopup: "div", PopoverTrigger: "div" }));
vi.mock("../ui/menu", () => ({
  Menu: "div",
  MenuCheckboxItem: "div",
  MenuItem: "div",
  MenuPopup: "div",
  MenuSeparator: "hr",
  MenuTrigger: "div",
}));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./UsageProviderChart", () => ({ UsageProviderChart: "div" }));
vi.mock("./UsagePriceOverrides", () => ({ UsagePriceOverrides: () => null }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../settings/RedactedSensitiveText", () => ({ RedactedSensitiveText: "span" }));
vi.mock("../settings/providerDriverMeta", () => ({ getDriverOption: () => ({ label: "Codex" }) }));

import { UsagePage } from "./UsagePage";

let renderer: ReactTestRenderer;
let environmentNumber = 0;
beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-11T12:00:00Z"));
  environmentNumber += 1;
  state.metric = "limits";
  state.refreshProviders.mockClear();
  state.presentations = new Map([
    [
      EnvironmentId.make(`test-${environmentNumber}`),
      {
        entry: { target: { label: "Test" } },
        connection: { phase: "connected" },
        serverConfig: {
          providers: [
            {
              instanceId: ProviderInstanceId.make("codex"),
              driver: "codex",
              enabled: true,
              installed: true,
              version: null,
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: "2026-09-11T12:00:00Z",
              models: [],
              slashCommands: [],
              skills: [],
              usageLimits: {
                checkedAt: "2026-09-11T12:00:00Z",
                windows: [
                  {
                    id: "five_hour",
                    kind: "session",
                    label: "Session",
                    usedPercent: 40,
                    windowDurationMins: 300,
                    resetsAt: "2026-09-11T14:00:00Z",
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  ]);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([0, 1])(
  "refreshes the visible limits countdown with refresh button %i without switching tabs, even when quota is unchanged",
  async (buttonIndex) => {
    await act(() => {
      renderer = create(<UsagePage />);
    });
    expect(
      JSON.stringify(renderer.toJSON(), (key, value) => (key === "props" ? undefined : value)),
    ).toContain("in 2h 0m");
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-09-11T12:30:00Z"));
    await act(async () => {
      renderer.root
        .findAllByProps({ "aria-label": "Refresh limits" })
        .filter((node) => node.type === "button")
        .at(buttonIndex)!
        .props.onClick();
    });
    expect(state.refreshProviders).toHaveBeenCalledWith({
      environmentId: `test-${environmentNumber}`,
      input: {},
    });
    expect(
      JSON.stringify(renderer.toJSON(), (key, value) => (key === "props" ? undefined : value)),
    ).toContain("in 1h 30m");
    expect(
      JSON.stringify(renderer.toJSON(), (key, value) => (key === "props" ? undefined : value)),
    ).not.toContain("in 2h 0m");
  },
);

it("uses the current time when returning to limits from tokens", async () => {
  await act(() => {
    renderer = create(<UsagePage />);
  });
  const selectMetric = (metric: string) => {
    renderer.root
      .findAll((node) => node.type === "div" && node.props["aria-label"] === "Usage metric")[0]!
      .props.onValueChange([metric]);
  };
  await act(() => selectMetric("tokens"));
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-09-11T13:00:00Z"));
  await act(() => selectMetric("limits"));
  expect(
    JSON.stringify(renderer.toJSON(), (key, value) => (key === "props" ? undefined : value)),
  ).toContain("in 1h 0m");
  expect(state.refreshProviders).toHaveBeenCalledTimes(2);
});

it("refreshes once on opening Limits and suppresses rapid returns and remounts", async () => {
  state.metric = "tokens";
  await act(() => {
    renderer = create(
      <StrictMode>
        <UsagePage />
      </StrictMode>,
    );
  });
  expect(state.refreshProviders).not.toHaveBeenCalled();
  const selectMetric = (metric: string) =>
    renderer.root
      .findAll((node) => node.type === "div" && node.props["aria-label"] === "Usage metric")[0]!
      .props.onValueChange([metric]);
  await act(() => selectMetric("limits"));
  expect(state.refreshProviders).toHaveBeenCalledTimes(1);
  await act(() => selectMetric("tokens"));
  await act(() => selectMetric("limits"));
  await act(() => renderer.unmount());
  state.metric = "limits";
  await act(() => {
    renderer = create(
      <StrictMode>
        <UsagePage />
      </StrictMode>,
    );
  });
  expect(state.refreshProviders).toHaveBeenCalledTimes(1);
  await act(() => selectMetric("tokens"));
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-09-11T12:05:00Z"));
  await act(() => selectMetric("limits"));
  expect(state.refreshProviders).toHaveBeenCalledTimes(2);
});

it("waits for connection and refreshes new environments during a slow refresh", async () => {
  const [id, presentation] = [...state.presentations][0]!;
  state.presentations = new Map([[id, { ...presentation, connection: { phase: "disconnected" } }]]);
  await act(() => {
    renderer = create(<UsagePage />);
  });
  expect(state.refreshProviders).not.toHaveBeenCalled();
  let finishRefresh!: () => void;
  state.refreshProviders.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        finishRefresh = () => resolve(undefined);
      }),
  );
  state.presentations = new Map([[id, presentation]]);
  await act(() => renderer.update(<UsagePage />));
  expect(state.refreshProviders).toHaveBeenCalledTimes(1);
  const nextId = EnvironmentId.make(`${id}-next`);
  state.presentations = new Map([...state.presentations, [nextId, presentation]]);
  await act(() => renderer.update(<UsagePage />));
  expect(state.refreshProviders).toHaveBeenCalledTimes(2);
  expect(state.refreshProviders).toHaveBeenLastCalledWith({ environmentId: nextId, input: {} });
  await act(() => finishRefresh());
});

it("keeps manual refresh busy until the already-running automatic check settles", async () => {
  let finishRefresh!: () => void;
  const pending = new Promise<undefined>((resolve) => {
    finishRefresh = () => resolve(undefined);
  });
  state.refreshProviders.mockImplementationOnce(() => pending);
  await act(() => {
    renderer = create(<UsagePage />);
  });
  const button = () =>
    renderer.root.findAll(
      (node) => node.type === "button" && node.props["aria-label"] === "Refresh limits",
    )[0]!;
  expect(state.refreshProviders).toHaveBeenCalledTimes(1);
  await act(() => button().props.onClick());
  try {
    expect(button().props["aria-busy"]).toBe(true);
    expect(state.refreshProviders).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => {
      finishRefresh();
      await pending;
    });
  }
  expect(button().props["aria-busy"]).toBe(false);
});
