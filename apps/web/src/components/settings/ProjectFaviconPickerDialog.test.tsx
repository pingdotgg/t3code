import { EnvironmentId } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({}),
}));

vi.mock("~/state/server", () => ({
  primaryServerKeybindingsAtom: Symbol("keybindings"),
}));

vi.mock("~/hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("../files/projectFilesQueryState", () => ({
  useProjectFilePickerQuery: () => ({
    entries: [],
    error: null,
    isPending: false,
    matchedQuery: "",
  }),
}));

vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
}));

import { toastManager } from "../ui/toast";
import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "./ProjectFaviconPickerDialog";

describe("ProjectFaviconPickerDialog", () => {
  beforeEach(() => {
    hooks.reset();
    vi.stubGlobal("navigator", { platform: "MacIntel" });
  });

  it("selects an image from the native file picker", async () => {
    const onOpenChange = vi.fn();
    const onPickExternal = vi.fn().mockResolvedValue("/Users/me/Pictures/icon.png");
    const onSelect = vi.fn();
    hooks.beginRender();
    const picker = ProjectFaviconPickerDialog({
      cwd: "/Users/me/project",
      environmentId: EnvironmentId.make("local"),
      onOpenChange,
      onPickExternal,
      onSelect,
      open: true,
      projectName: "Project",
    } as Parameters<typeof ProjectFaviconPickerDialog>[0] & {
      readonly onPickExternal: () => Promise<string | null>;
    }) as ReactElement<Record<string, unknown>>;

    const button = visitElements(picker, (element) => element.props.children === "Open in Finder");
    expect(button).not.toBeNull();

    (button?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(onPickExternal).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSelect).toHaveBeenCalledWith("/Users/me/Pictures/icon.png");
  });

  it("hides the native picker for WSL project paths", () => {
    expect(canPickExternalProjectFavicon("/home/me/project", "Win32")).toBe(false);
    expect(canPickExternalProjectFavicon("C:\\Users\\me\\project", "Win32")).toBe(true);
  });

  it("keeps the dialog open when the native picker fails", async () => {
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();
    const props = {
      cwd: "/Users/me/project",
      environmentId: EnvironmentId.make("local"),
      onOpenChange,
      onPickExternal: vi.fn().mockRejectedValue(new Error("picker failed")),
      onSelect,
      open: true,
      projectName: "Project",
    } as Parameters<typeof ProjectFaviconPickerDialog>[0] & {
      readonly onPickExternal: () => Promise<string | null>;
    };

    hooks.beginRender();
    const picker = ProjectFaviconPickerDialog(props) as ReactElement<Record<string, unknown>>;
    const button = visitElements(picker, (element) => element.props.children === "Open in Finder");

    (button?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(toastManager.add).toHaveBeenCalledWith({
      type: "error",
      title: "Could not open image picker",
      description: "picker failed",
    });
  });
});
