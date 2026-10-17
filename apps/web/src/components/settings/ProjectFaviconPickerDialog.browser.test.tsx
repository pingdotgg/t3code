import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const toast = vi.hoisted(() => vi.fn());
vi.mock(import("../files/projectFilesQueryState"), async (original) => ({
  ...(await original()),
  useProjectFilePickerQuery: () => ({
    entries: [],
    error: null,
    isPending: false,
    matchedQuery: "",
  }),
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: toast } };
});

import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "./ProjectFaviconPickerDialog";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "platform", { configurable: true, get: () => "MacIntel" });
  toast.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(navigator, "platform");
  vi.unstubAllGlobals();
});

async function renderPicker(onPickExternal: () => Promise<string | null>) {
  const onOpenChange = vi.fn();
  const onSelect = vi.fn();
  await act(async () =>
    root.render(
      <ProjectFaviconPickerDialog
        cwd="/Users/me/project"
        environmentId={EnvironmentId.make("local")}
        onOpenChange={onOpenChange}
        onPickExternal={onPickExternal}
        onSelect={onSelect}
        open
        projectName="Project"
      />,
    ),
  );
  return { onOpenChange, onSelect };
}
async function clickOpenInFinder() {
  const button = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.includes("Open in Finder"),
  );
  expect(button, "Open in Finder").toBeDefined();
  await act(async () => button!.click());
}

it("selects an image from the native file picker", async () => {
  const onPickExternal = vi.fn().mockResolvedValue("/Users/me/Pictures/icon.png");
  const { onOpenChange, onSelect } = await renderPicker(onPickExternal);

  await clickOpenInFinder();

  expect(onPickExternal).toHaveBeenCalledTimes(1);
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(onSelect).toHaveBeenCalledWith("/Users/me/Pictures/icon.png");
});

it("hides the native picker for WSL project paths", () => {
  expect(canPickExternalProjectFavicon("/home/me/project", "Win32")).toBe(false);
  expect(canPickExternalProjectFavicon("C:\\Users\\me\\project", "Win32")).toBe(true);
});

it("keeps the dialog open when the native picker fails", async () => {
  const { onOpenChange, onSelect } = await renderPicker(
    vi.fn().mockRejectedValue(new Error("picker failed")),
  );

  await clickOpenInFinder();

  expect(onOpenChange).not.toHaveBeenCalled();
  expect(onSelect).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith({
    type: "error",
    title: "Could not open image picker",
    description: "picker failed",
  });
});
