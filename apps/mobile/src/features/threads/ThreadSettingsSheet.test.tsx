import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    updateSettings: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android", Version: 35 },
  View: Children,
  ScrollView: Children,
  RefreshControl: () => null,
  TextInput: () => null,
  Pressable: ({
    children,
    disabled,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => (
    <button disabled={disabled} onClick={onPress} aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-reanimated", () => {
  const transition = { duration: () => transition };
  return {
    default: { View: Children },
    FadeIn: transition,
    FadeOut: transition,
    LinearTransition: transition,
    useReducedMotion: () => true,
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@legendapp/list/reanimated", () => ({
  AnimatedLegendList: (props: {
    data: ReadonlyArray<{ key: string }>;
    renderItem: (props: { item: unknown }) => ReactNode;
  }) => props.data.map((item) => <div key={item.key}>{props.renderItem({ item })}</div>),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({}),
  useRoute: () => ({}),
}));
vi.mock("@react-navigation/native-stack", () => ({}));
vi.mock("../../native/createV5StackNavigator", () => ({
  createV5StackNavigator: () => ({
    Navigator: (props: { initialRouteName: string; children: ReactNode }) => {
      const screens = (Array.isArray(props.children) ? props.children : [props.children]) as {
        props: { name: string; component: () => ReactNode };
      }[];
      const Screen = screens.find((screen) => screen.props.name === props.initialRouteName)!.props
        .component;
      return <Screen />;
    },
    Screen: () => null,
  }),
}));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => {} }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../components/ui/Toolbar", () => ({ Toolbar: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/ui/AndroidAnchoredMenu", () => ({ AndroidAnchoredMenu: () => null }));
vi.mock("../../components/ui/IconButton", () => ({ IconButton: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({ ScreenContent: Children }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../components/ui/ThemedSwitch", () => ({
  ThemedSwitch: (props: {
    accessibilityLabel: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <button
      role="switch"
      aria-checked={props.value}
      aria-label={props.accessibilityLabel}
      onClick={() => props.onValueChange(!props.value)}
    />
  ),
}));
vi.mock("../../lib/appState", () => ({ useReduceMotionEnabled: () => true }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: () => null,
  nativeHeaderScrollEdgeEffects: () => undefined,
}));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: false }));
vi.mock("../../native/native-layout-metrics", () => ({ useNativeLayoutMetrics: () => null }));
vi.mock("../../native/use-native-mail-search-toolbar", () => ({
  useNativeMailSearchToolbar: () => false,
}));
vi.mock("../layout/native-mail-search-toolbar", () => ({
  createNativeMailSearchToolbarItem: () => null,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET: 0,
}));
vi.mock("./ChatGptSharingStatus", () => ({ ChatGptSharingStatus: () => null }));
vi.mock("./new-task-flow-provider", () => ({ useNewTaskFlow: () => ({}) }));
vi.mock("../../state/use-model-option-memory", () => ({
  rememberModelOptions: () => {},
  withRememberedModelOptions: (selection: unknown) => selection,
}));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: { stateAtom: () => null } }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: undefined }) }));
vi.mock("../../state/entities", () => ({ useThreadReportedModelSelection: () => null }));
vi.mock("../../state/use-composer-drafts", () => ({}));
vi.mock("../../state/use-thread-detail", () => ({}));
vi.mock("../../state/queued-run-edit", () => ({}));
vi.mock("../../state/use-thread-composer-state", () => ({}));
vi.mock("../../state/use-thread-selection", () => ({}));
vi.mock("../../state/thread-provider-switching", () => ({}));
vi.mock("../../state/preferences", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return { mobilePreferencesAtom: Atom.make(AsyncResult.success({})) };
});
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentServerConfigsAtom: Atom.make(new Map()),
    serverEnvironment: { updateSettings: {}, refreshProviders: {} },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.updateSettings }));

import { environmentServerConfigsAtom } from "../../state/server";
import { ThreadSettingsPickerScreen } from "./ThreadSettingsSheet";

const environmentId = EnvironmentId.make("env-1");
const codex = ProviderInstanceId.make("codex");
const config = {
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    favorites: [],
    providerInstances: { [codex]: { driver: ProviderDriverKind.make("codex"), enabled: true } },
    providerModelPreferences: {},
  },
  providers: [
    {
      instanceId: codex,
      continuation: { groupKey: codex },
      driver: "codex",
      displayName: "Codex",
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models: [
        { slug: "gpt-6.1", name: "GPT-6.1", isCustom: false, capabilities: null },
        { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isCustom: false, capabilities: null },
      ],
    },
  ],
} as unknown as ServerConfig;

it("shows a tapped model as hidden while its hide request is still saving", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const save = Promise.withResolvers<unknown>();
  mocks.updateSettings.mockReturnValue(save.promise);
  const registry = AtomRegistry.make();
  registry.set(
    environmentServerConfigsAtom as Atom.Writable<Map<EnvironmentId, ServerConfig>>,
    new Map([[environmentId, config]]),
  );

  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = {
    [Symbol.dispose]: () => {
      save.resolve(AsyncResult.success(undefined));
      act(() => root.unmount());
    },
  };
  act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <ThreadSettingsPickerScreen
          environmentId={environmentId}
          projectId={null}
          providerInstanceId={codex}
          providerGroups={[]}
          selectedModel={{ instanceId: codex, model: "gpt-6.1" }}
          prompt=""
          onPromptChange={() => {}}
          onSelectModel={() => {}}
          optionDescriptors={[]}
          onUpdateOptionSelections={() => {}}
          runtimeMode="full-access"
          onUpdateRuntimeMode={() => {}}
          onClose={() => {}}
        />
      </RegistryContext.Provider>,
    ),
  );
  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  act(() => button("Manage hidden models")!.click());
  act(() => button("Hide model: Codex, GPT-6.1-Sol")!.click());

  expect(mocks.updateSettings).toHaveBeenCalledWith({
    environmentId,
    input: {
      patch: { setModelsHidden: [{ provider: codex, model: "gpt-6.1-sol", hidden: true }] },
    },
  });
  // The save has not settled and no settings push has arrived yet.
  expect(
    button("Show model: Codex, GPT-6.1-Sol"),
    "the tapped row still shows the model as visible until the server responds",
  ).not.toBeNull();
});
