import { EnvironmentId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const queries = vi.hoisted(() => [] as { cwd: string | null; searchQuery: string }[]);

vi.mock("@t3tools/client-runtime/state/filesystem", () => ({
  resolveFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false }),
}));
vi.mock("../../state/session", () => ({ environmentSession: { sessionStateAtom: () => null } }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null, error: null }) }));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({ isReady: true, presentation: null }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));
vi.mock("./preload-workspace-file", () => ({ preloadWorkspaceFileContents: () => {} }));
vi.mock("./FileTreeBrowser", () => ({ FileTreeBrowser: () => null }));
vi.mock("./useFileTreeEntries", () => ({
  useFileTreeEntries: (input: { cwd: string | null; searchQuery: string }) => {
    queries.push({ cwd: input.cwd, searchQuery: input.searchQuery });
    return { refresh: () => {}, selectPath: () => {} };
  },
}));
vi.mock("../../components/ui/SheetPane", () => ({
  SheetPane: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: (props: { search: { value: string; onChangeText: (value: string) => void } }) => (
    <input
      value={props.search.value}
      onChange={(event) => props.search.onChangeText(event.target.value)}
    />
  ),
}));

import { ThreadFileNavigatorPane } from "./thread-file-navigator-pane";

it("starts unfiltered when the mounted pane switches to another workspace", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const render = (cwd: string) =>
    act(() =>
      root.render(
        <ThreadFileNavigatorPane
          cwd={cwd}
          environmentId={EnvironmentId.make("env")}
          projectName="Files"
          selectedPath={null}
          onSelectFile={() => {}}
        />,
      ),
    );
  try {
    render("/first");
    const input = container.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "alpha",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(queries.at(-1)).toEqual({ cwd: "/first", searchQuery: "alpha" });

    render("/second");
    expect(queries.at(-1)).toEqual({ cwd: "/second", searchQuery: "" });
    expect(container.querySelector("input")!.value).toBe("");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
