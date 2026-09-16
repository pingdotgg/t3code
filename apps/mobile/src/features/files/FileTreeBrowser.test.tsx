import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { Preferences } from "../../persistence/mobile-preferences";
import { FileTreeBrowser } from "./FileTreeBrowser";

const fixture = vi.hoisted(() => ({
  preferences: null as unknown,
  save: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => fixture.preferences,
  useAtomSet: () => fixture.save,
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));
vi.mock("react-native", () => ({
  ActivityIndicator: "loading",
  FlatList: "list",
  Pressable: "button",
  RefreshControl: "refresh",
  View: "view",
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/AppText", () => ({ AppText: "text" }));
vi.mock("../../components/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: false }));

const workspaceKey = JSON.stringify(["test", "/repo"]);
const entries: readonly ProjectEntry[] = [
  { path: "apps", kind: "directory" },
  { path: "apps/web", kind: "directory" },
  { path: "apps/web/index.ts", kind: "file" },
  { path: "docs", kind: "directory" },
  { path: "docs/readme.md", kind: "file" },
];
const props: ComponentProps<typeof FileTreeBrowser> = {
  environmentId: EnvironmentId.make("test"),
  cwd: "/repo",
  entries,
  error: null,
  isPending: false,
  searchQuery: "",
  searchTruncated: false,
  selectedPath: null,
  loadedDirectories: new Set(),
  onLoadDirectory: () => {},
  onRefresh: () => {},
  onSelectFile: () => {},
};
let renderer: ReactTestRenderer | undefined;
let currentProps = props;
const loaded = (paths: readonly string[]) => {
  const preferences: Preferences = {
    fileTreeExpandedPaths: { [workspaceKey]: paths, other: ["keep"] },
  };
  fixture.preferences = AsyncResult.success(preferences);
};
async function render(next = currentProps) {
  currentProps = next;
  await act(async () => {
    if (renderer) renderer.update(<FileTreeBrowser {...next} />);
    else renderer = create(<FileTreeBrowser {...next} />);
  });
}
function list() {
  return renderer!.root.find((node) => String(node.type) === "list");
}
const visible = () => list().props.data.map((item: { node: { path: string } }) => item.node.path);
async function toggle(path: string) {
  await act(async () => {
    const item = list().props.data.find(
      (item: { node: { path: string } }) => item.node.path === path,
    );
    list().props.renderItem({ item }).props.onPressDirectory(path);
  });
}
beforeEach(() => {
  fixture.preferences = AsyncResult.initial();
  fixture.save.mockReset();
  currentProps = props;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("keeps taps before preferences load, merges saved siblings, and persists early collapses", async () => {
  await render();
  await toggle("apps");
  expect(visible()).toContain("apps/web");
  expect(fixture.save).not.toHaveBeenCalled();
  await toggle("apps");
  loaded(["apps", "docs"]);
  await render();
  expect(visible()).not.toContain("apps/web");
  expect(visible()).toContain("docs/readme.md");
  expect(fixture.save).toHaveBeenLastCalledWith({
    fileTreeExpandedPaths: { [workspaceKey]: ["docs"], other: ["keep"] },
  });
});

it("keeps selected-file reveal after failed persistence without retries or forced reopening", async () => {
  await render({ ...props, selectedPath: "apps/web/index.ts" });
  expect(visible()).toContain("apps/web/index.ts");
  expect(fixture.save).not.toHaveBeenCalled();
  loaded([]);
  await render();
  const optimistic = fixture.save.mock.calls.at(-1)![0];
  fixture.preferences = AsyncResult.success(optimistic);
  await render();
  expect(visible()).toContain("apps/web/index.ts");
  loaded([]);
  await render();
  expect(visible()).toContain("apps/web/index.ts");
  expect(fixture.save).toHaveBeenCalledTimes(1);
  await toggle("apps");
  expect(visible()).not.toContain("apps/web/index.ts");
  await render();
  expect(visible()).not.toContain("apps/web/index.ts");
});
