import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import type { ThemeColorRole } from "../../themePalette";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
    useEffect: () => {},
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import { ThemeEditorPanel } from "./ThemeEditorPanel";
import { ThemeColorField } from "./ThemeColorPicker";

type FieldProps = {
  role: ThemeColorRole;
  selected: boolean;
  onSelect: (role: ThemeColorRole, reveal?: boolean) => void;
};

function findFields(node: ReactNode): ReactElement<FieldProps>[] {
  if (Array.isArray(node)) return node.flatMap(findFields);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  if (node.type === ThemeColorField) return [node as ReactElement<FieldProps>];
  return findFields(node.props.children);
}

function renderPanel() {
  hooks.beginRender();
  return ThemeEditorPanel({
    open: true,
    onOpenChange: vi.fn(),
    onSaved: () => true,
    editingTheme: null,
    initialAppearance: "dark",
    restoreTheme: vi.fn(),
  }) as ReactElement<{ ref: { current: unknown }; children: ReactNode }>;
}

describe("theme role reveal", () => {
  beforeEach(() => {
    hooks.reset();
    vi.stubGlobal("window", { localStorage: { getItem: () => null } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps role selection and reveal targets when motion changes or matchMedia is missing", () => {
    let reducedMotion = false;
    window.matchMedia = vi.fn(() => ({ matches: reducedMotion }) as MediaQueryList);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    const scrollIntoView = vi.fn();
    const querySelector = vi.fn(() => ({ scrollIntoView }));
    const panel = renderPanel();
    panel.props.ref.current = { querySelector };
    const select = findFields(panel)[0]!.props.onSelect;

    select("toolbar", true);
    frames.shift()!(0);
    expect(querySelector).toHaveBeenLastCalledWith('[data-theme-color-role="canvas"]');
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: "smooth", block: "nearest" });
    expect(findFields(renderPanel()).find((field) => field.props.selected)?.props.role).toBe(
      "canvas",
    );

    select("surface", true);
    // Read at reveal time, including a preference change after the input event.
    reducedMotion = true;
    frames.shift()!(0);
    expect(querySelector).toHaveBeenLastCalledWith('[data-theme-color-role="surface"]');
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: "auto", block: "nearest" });
    expect(findFields(renderPanel()).find((field) => field.props.selected)?.props.role).toBe(
      "surface",
    );

    vi.stubGlobal("window", { localStorage: { getItem: () => null } });
    select("surface", true);
    frames.shift()!(0);
    expect(querySelector).toHaveBeenLastCalledWith('[data-theme-color-role="surface"]');
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: "smooth", block: "nearest" });
    expect(findFields(renderPanel()).find((field) => field.props.selected)?.props.role).toBe(
      "surface",
    );
  });
});
