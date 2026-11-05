import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  DEFAULT_SERVER_SETTINGS,
  type ExternalHistoryRequest,
  type ExternalHistoryResponse,
} from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  config: null as unknown,
  allowed: null as unknown,
  focused: false,
  requests: [] as ExternalHistoryRequest[],
  update: vi.fn(),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => state.focused,
  useNavigation: () => ({ goBack: vi.fn(), navigate: vi.fn() }),
}));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => <header>External history</header> }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppTextInput: ({
    accessibilityLabel,
    value,
    editable,
    onChangeText,
  }: {
    accessibilityLabel: string;
    value: string;
    editable?: boolean;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      disabled={editable === false}
      onInput={(event) => onChangeText(event.currentTarget.value)}
      onChange={() => {}}
    />
  ),
}));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/SelectionRow", () => ({
  SelectionRow: ({ title, onPress }: { title: string; onPress: () => void }) => (
    <button onClick={onPress}>{title}</button>
  ),
}));
vi.mock("../settings/components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: ({
    label,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <button
      role="switch"
      aria-checked={value}
      disabled={disabled}
      onClick={() => onValueChange(!value)}
    >
      {label}
    </button>
  ),
}));
vi.mock("../../state/entities", () => ({ useProject: () => null }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => state.config,
    updateSettings: { permissionAtom: () => state.allowed },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.update }));
vi.mock("../../state/externalHistory", () => ({
  externalHistory: { query: ({ input }: { input: ExternalHistoryRequest }) => input },
}));
const ref = {
  sourceId: "codex-history",
  threadId: "native-thread",
  readCursor: "native-read-locator",
  digest: "a".repeat(64),
};
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (request: ExternalHistoryRequest) => {
    state.requests.push(request);
    const data: ExternalHistoryResponse =
      request.operation === "sources"
        ? {
            operation: "sources",
            enabled: true,
            sources: [{ id: "codex-history", label: "Native Codex", kind: "codex" }],
          }
        : request.operation === "search"
          ? {
              operation: "search",
              examinedItems: 20,
              matches: request.cursor
                ? [
                    {
                      ref,
                      threadTitle: "Compiler investigation",
                      itemId: "tool-output",
                      role: "tool",
                      excerpt: "First exact page",
                      textOffset: 0,
                      totalChars: 33,
                    },
                  ]
                : [],
              nextCursor: request.cursor ? null : "more-native-history",
            }
          : {
              operation: "read",
              ref,
              threadTitle: "Compiler investigation",
              role: "tool",
              text: request.textOffset ? "Second exact page" : "First exact page",
              textOffset: request.textOffset ?? 0,
              totalChars: 33,
              nextTextOffset: request.textOffset ? null : 16,
            };
    return { data, error: null, isPending: false, refresh: vi.fn() };
  },
}));

import { ExternalHistoryRouteScreen } from "./ExternalHistoryRouteScreen";

const configFor = (supported: boolean, enabled = true) => ({
  environment: { capabilities: supported ? { externalHistory: 1 as const } : {} },
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    externalHistory: { enabled, chatGptExportPaths: ["/remote/export.json"] },
  },
});

it("keeps remote history read-only without settings permission and stops reads when hidden, disabled or unsupported", async () => {
  const registry = AtomRegistry.make();
  const config = Atom.make(configFor(true));
  state.config = config;
  state.allowed = Atom.make(false);
  state.focused = false;
  state.requests = [];
  state.update.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <ExternalHistoryRouteScreen
            route={{ params: { environmentId: "remote", currentProjectPath: "/remote/project" } }}
          />
        </RegistryContext.Provider>,
      ),
    );
  const button = (label: string) => {
    const value = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === label,
    );
    if (!value) throw new Error("Missing button: " + label);
    return value;
  };
  const click = (label: string) => act(async () => button(label).click());
  try {
    render();
    expect(state.requests).toEqual([]);
    state.focused = true;
    act(() => registry.set(config, configFor(false)));
    expect(state.requests).toEqual([]);
    expect(container.textContent).toContain("Update this server");
    act(() => registry.set(config, configFor(true)));
    expect(button("Allow external history search").disabled).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="ChatGPT export paths"]')?.disabled,
    ).toBe(true);
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="Search external history"]',
    )!;
    await act(async () => {
      input.value = "exact";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("This project");
    await click("Search");
    expect(container.textContent).toContain("No matches on this page. Continue");
    await click("Continue search");
    expect(container.textContent).toContain("Compiler investigation");
    expect(state.requests).toContainEqual({
      operation: "search",
      sourceId: ref.sourceId,
      query: "exact",
      filterCwd: "/remote/project",
      includeArchived: false,
      cursor: "more-native-history",
    });
    await click("Open source");
    expect(container.textContent).toContain("First exact page");
    await click("More source text");
    expect(container.textContent).toContain("Second exact page");
    expect(container.textContent).not.toContain("First exact page");
    await click("Search");
    expect(container.textContent).toContain("No matches on this page. Continue");
    expect(container.textContent).not.toContain("Second exact page");
    expect(state.update).not.toHaveBeenCalled();
    act(() => registry.set(config, configFor(true, false)));
    expect(container.textContent).toContain("External history search is off");
    const readsBeforeDisable = state.requests.length;
    render();
    expect(state.requests).toHaveLength(readsBeforeDisable);
    state.focused = false;
    act(() => registry.set(config, configFor(true)));
    render();
    expect(state.requests).toHaveLength(readsBeforeDisable);
  } finally {
    act(() => root.unmount());
    registry.dispose();
    vi.unstubAllGlobals();
  }
});
