import { Fragment, act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { WorkingChangesTree } from "./WorkingChangesTree";

// Exercise selection and context actions without a virtual viewport or portal positioning.
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
  }: {
    data: ReadonlyArray<{ scope: string; kind: string; path: string }>;
    renderItem: (input: { item: (typeof data)[number] }) => ReactNode;
  }) => (
    <>
      {data.map((item) => (
        <Fragment key={`${item.scope}:${item.kind}:${item.path}`}>{renderItem({ item })}</Fragment>
      ))}
    </>
  ),
}));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../chat/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("../MorphIcon", () => ({ MorphIcon: () => null }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactNode; children: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: () => null,
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  MenuPopup: ({ children }: { children: ReactNode }) => children,
  MenuItem: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled: boolean;
    onClick: () => void;
  }) => (
    <button role="menuitem" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

type Props = ComponentProps<typeof WorkingChangesTree>;
type Scope = "staged" | "unstaged";
const unstaged: Props["unstaged"] = [
  { path: "src/lib/a.ts", status: "modified" },
  { path: "src/lib/deep/b.ts", status: "modified" },
  { path: "src/library/neighbor.ts", status: "modified" },
  { path: "tests/a.test.ts", status: "modified" },
];
const staged: Props["staged"] = [
  { path: "src/lib/a.ts", status: "modified" },
  { path: "staged/old.ts", status: "modified" },
];

describe("working changes context actions", () => {
  let root: Root | undefined;
  let container: HTMLDivElement;
  const onStage = vi.fn<Props["onStage"]>();
  const onRevert = vi.fn<Props["onRevert"]>();
  const onSelect = vi.fn<Props["onSelect"]>();

  async function mount(overrides: Partial<Props> = {}) {
    await act(async () => {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      root.render(
        <WorkingChangesTree
          staged={staged}
          unstaged={unstaged}
          selected={null}
          disabled={false}
          revertDisabled={false}
          onSelect={onSelect}
          onStage={onStage}
          onRevert={onRevert}
          onViewAll={() => {}}
          {...overrides}
        />,
      );
    });
  }

  async function select(scope: Scope, path: string, toggle = false) {
    const target = container.querySelector<HTMLElement>(`[aria-label="${scope}: ${path}"]`)!;
    await act(async () =>
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: toggle })),
    );
  }

  async function rightClick(scope: Scope, path: string) {
    const target = container.querySelector<HTMLElement>(
      `[data-git-scope="${scope}"][data-git-path="${path}"]`,
    )!;
    await act(async () =>
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 241,
          clientY: 173,
        }),
      ),
    );
  }

  const menuItems = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  const item = (label: string) => menuItems().find((node) => node.textContent === label)!;
  async function choose(label: string) {
    await act(async () => item(label).click());
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    onStage.mockClear();
    onRevert.mockClear();
    onSelect.mockClear();
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    vi.unstubAllGlobals();
  });

  it("stages or reverts all selected files and collapsed folders", async () => {
    await mount();
    await select("unstaged", "src/lib");
    await select("unstaged", "tests/a.test.ts", true);
    await rightClick("unstaged", "src/lib");
    expect(menuItems()).toHaveLength(2);
    await choose("Stage changes");
    const paths = ["src/lib/a.ts", "src/lib/deep/b.ts", "tests/a.test.ts"];
    expect(onStage).toHaveBeenCalledWith("unstaged", paths);

    await rightClick("unstaged", "tests/a.test.ts");
    await choose("Revert changes");
    expect(onRevert).toHaveBeenCalledWith(paths);
  });

  it("keeps the selection when right-clicking a descendant of a selected folder", async () => {
    await mount();
    await select("unstaged", "src/lib", true);
    await select("unstaged", "tests/a.test.ts", true);
    await rightClick("unstaged", "src/lib/a.ts");
    await choose("Stage changes");
    expect(onStage).toHaveBeenCalledWith("unstaged", [
      "src/lib/a.ts",
      "src/lib/deep/b.ts",
      "tests/a.test.ts",
    ]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("targets an unselected row instead of applying its menu to an unrelated selection", async () => {
    await mount();
    await select("unstaged", "src/lib");
    await select("unstaged", "tests/a.test.ts", true);
    await rightClick("unstaged", "src/library/neighbor.ts");
    await choose("Revert changes");
    expect(onRevert).toHaveBeenCalledWith(["src/library/neighbor.ts"]);
  });

  it("offers only Unstage for staged rows and excludes selected unstaged files", async () => {
    await mount();
    await select("staged", "src/lib");
    await select("staged", "staged/old.ts", true);
    await select("unstaged", "tests/a.test.ts", true);
    await rightClick("staged", "src/lib");
    expect(menuItems()).toHaveLength(1);
    await choose("Unstage changes");
    expect(onStage).toHaveBeenCalledWith("staged", ["src/lib/a.ts", "staged/old.ts"]);
    expect(onRevert).not.toHaveBeenCalled();
  });

  it("keeps staging and revert availability independent", async () => {
    await mount({ disabled: true });
    await rightClick("unstaged", "tests/a.test.ts");
    expect(item("Stage changes").disabled).toBe(true);
    expect(item("Revert changes").disabled).toBe(false);
  });
});
