import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { CommandPaletteResult } from "./commandPaletteItems";

const { Wrap, invoke, draft } = vi.hoisted(() => ({
  Wrap: ({ children }: { children?: ReactNode }) => children,
  invoke: vi.fn(),
  draft: { environmentId: "remote", active: true },
}));
vi.mock("react-native", () => ({
  View: Wrap,
  Text: Wrap,
  KeyboardAvoidingView: Wrap,
  TextInput: () => null,
  Pressable: () => null,
  useWindowDimensions: () => ({ width: 900, height: 700 }),
  Modal: ({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) => (
    <div>
      {children}
      <button data-dismiss onClick={onDismiss}>
        Dismiss native modal
      </button>
    </div>
  ),
}));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: ({
    data,
    renderItem,
  }: {
    data: CommandPaletteResult[];
    renderItem: (info: { item: CommandPaletteResult; index: number }) => ReactNode;
  }) => (
    <>
      {data.map((item, index) => (
        <div key={item.key}>{renderItem({ item, index })}</div>
      ))}
    </>
  ),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("react-native-gesture-handler", () => ({ GestureHandlerRootView: Wrap }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "fixture" }));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../components/ui/GlassSurface", () => ({ GlassSurface: Wrap }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Wrap }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
}));
vi.mock("../../lib/reserved-regions", () => ({
  deriveBottomControlInsets: () => ({ left: 0, right: 0, top: 0, bottom: 0 }),
}));
vi.mock("../../native/native-layout-metrics", () => ({ useNativeLayoutMetrics: () => ({}) }));
vi.mock("../../native/T3KeyboardCommands", () => ({ T3KeyboardCommands: Wrap }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useVisibleThreadShells: () => [],
  useThreadShell: () => null,
  useServerConfigs: () =>
    new Map(
      ["primary", "remote"].map((id) => [
        id,
        { environment: { capabilities: { extensions: true } } },
      ]),
    ),
}));
vi.mock("../../state/queries", () => ({
  useThreadSearch: () => ({ matches: [], query: "", isPending: false }),
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { visit: {} } }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { prepareTriage: { permissionAtom: () => ({}) } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/workspace", () => ({
  useWorkspaceEnvironments: () =>
    ["primary", "remote"].map((environmentId) => ({ environmentId, connectionState: "connected" })),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));
vi.mock("../threads/thread-search-match", () => ({ ThreadSearchMatchExcerpt: () => null }));
vi.mock("../threads/threadMessageJump", () => ({ requestThreadMessageJump: () => {} }));
vi.mock("../triage/useStartTriage", () => ({ useStartTriage: () => vi.fn() }));
vi.mock("../threads/new-task-flow-provider", () => ({
  useNewTaskFlow: () => ({ selectedProject: { environmentId: draft.environmentId } }),
}));
vi.mock("../../state/active-new-task", () => ({
  useActiveNewTask: () => (draft.active ? {} : null),
}));
vi.mock("../pull-requests/pullRequestGlyphs", () => ({
  PullRequestGlyph: { pullRequest: "fixture" },
}));
vi.mock("../settings/settings-navigation", () => ({ openSettings: () => {} }));
vi.mock("../layout/workspace/useSelectWorkspaceTab", () => ({
  useSelectWorkspaceTab: () => vi.fn(),
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => vi.fn(),
}));
vi.mock("../extensions/useExtensionCommandPrompt", () => ({
  useExtensionCommandPrompt: () => invoke,
}));
vi.mock("../../state/extensions", () => ({
  extensionEnvironment: { state: (input: unknown) => input },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: ({ environmentId }: { environmentId: string }) => ({
    data: [
      {
        status: "running",
        manifest: {
          id: "fixture",
          name: "Fixture",
          commands: [{ id: "read", title: `Read ${environmentId} notes` }],
        },
      },
    ],
  }),
}));

import { CommandPalette } from "./CommandPalette";

it("lists and invokes commands on the draft owner with another environment connected first", async () => {
  draft.active = true;
  draft.environmentId = "remote";
  invoke.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  await act(async () =>
    root.render(
      <CommandPalette pathname="/draft/fixture" onClose={() => {}} onCommand={() => {}} />,
    ),
  );
  const command = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Read remote notes"),
  );
  expect(command).toBeDefined();
  await act(async () => command?.click());
  await act(async () => container.querySelector<HTMLButtonElement>("[data-dismiss]")?.click());
  expect(invoke).toHaveBeenCalledWith(
    "remote",
    expect.objectContaining({
      manifest: { id: "fixture", name: "Fixture", commands: expect.any(Array) },
    }),
    expect.objectContaining({ id: "read" }),
    undefined,
  );
});
