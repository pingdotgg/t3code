import { IssueListInput, type IssueListInput as IssueListInputType } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { harness, Null } = vi.hoisted(() => ({
  harness: { query: "", inputs: [] as IssueListInputType[] },
  Null: () => null,
}));

vi.mock("react-native", () => ({
  Keyboard: { dismiss: () => {} },
  Platform: { OS: "ios" },
  ScrollView: () => null,
  View: () => null,
}));
vi.mock("@legendapp/list/react-native", () => ({ LegendList: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ setOptions: () => {} }) }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => new Map([["env-1", { environment: { capabilities: { issues: true } } }]]),
  useAtom: () => [{ labels: [], assignee: null }, () => {}],
}));
vi.mock("gt-react-native", () => ({
  msg: (text: string) => text,
  useGT: () => (text: string) => text,
  useMessages: () => (text: string) => text,
}));
vi.mock("../../i18n/messages", () => ({ m: (text: string) => text }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: Null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Null }));
vi.mock("../../components/ui/Button", () => ({ Button: Null }));
vi.mock("../../components/ui/Chip", () => ({ Chip: Null }));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: Null }));
vi.mock("../../components/ui/Pane", () => ({ usePaneRole: () => null }));
vi.mock("../../components/ui/RefreshControl", () => ({ RefreshControl: Null }));
vi.mock("../../components/ui/useBarInset", () => ({ useContentTopInset: () => 0 }));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: Null }));
vi.mock("../../native/native-layout-metrics", () => ({
  useNativeColumnLayoutMetrics: () => null,
}));
vi.mock("../../native/v5-workspace-context", async () => {
  const { createContext } = await import("react");
  return { NativePrimaryColumnContext: createContext(null) };
});
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/issues", () => ({
  issueEnvironment: { listPage: {} },
  useIssueList: (targets: ReadonlyArray<{ input: IssueListInputType }>) => {
    harness.inputs.push(...targets.map((target) => target.input));
    return { answers: [], error: null, isPending: false, refresh: () => {} };
  },
}));
vi.mock("../../state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => async () => {} }));
vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => ({
    environments: [{ environmentId: "env-1", connectionState: "connected" }],
  }),
}));
vi.mock("../layout/workspace/ListFilterMenu", () => ({ ListFilterMenu: Null }));
vi.mock("../layout/workspace/useSearchScrollRestoration", () => ({
  useSearchScrollRestoration: () => {},
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => () => {},
}));
vi.mock("../layout/workspace/WorkspaceTabsContext", () => ({
  useWorkspaceTabs: () => ({
    state: { tabs: { issues: { query: harness.query, searchMode: "searching", scrollOffset: 0 } } },
    getScrollOffset: () => 0,
    recordScrollOffset: () => {},
    dispatch: () => {},
    bottomClearance: 0,
  }),
}));
vi.mock("./IssueListRow", () => ({ IssueListRow: Null }));
vi.mock("../layout/workspace/SavedViewsMenu", () => ({ SavedViewsMenu: Null }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));

import { IssuesScreen } from "./IssuesScreen";

const decodeIssueListInput = Schema.decodeUnknownExit(IssueListInput);

it("searches a pasted wall of text by its start rather than failing the request", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const pasted = `TypeError: Cannot read properties of undefined (reading 'map') ${"at render (app.js:1:1) ".repeat(12)}`;
  harness.query = pasted;
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<IssuesScreen />));
  act(() => root.unmount());

  const input = harness.inputs.at(-1)!;
  expect(input.query).toBe(pasted.slice(0, 200).trim());
  expect(Exit.isSuccess(decodeIssueListInput(input))).toBe(true);
});
