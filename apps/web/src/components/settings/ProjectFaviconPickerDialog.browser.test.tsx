import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type AssetCreateUrlResult, type ProjectEntry } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import "~/index.css";

type AssetResult = AsyncResult.AsyncResult<AssetCreateUrlResult, Error>;
const state = vi.hoisted(() => ({
  entries: [] as ProjectEntry[],
  assets: new Map<string, Atom.Writable<AssetResult>>(),
  canReadFiles: true,
  createUrl: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock(import("~/state/assets"), async (original) => ({
  ...(await original()),
  assetEnvironment: { createUrl: state.createUrl, createUrls: vi.fn() },
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  usePreparedConnection: () =>
    ({
      _tag: "Some" as const,
      value: { httpBaseUrl: location.origin },
    }) as ReturnType<typeof import("~/state/session").usePreparedConnection>,
}));
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({
    canReadFiles: state.canReadFiles,
    isPending: false,
    error: null,
  }),
}));
vi.mock(import("../files/projectFilesQueryState"), async (original) => ({
  ...(await original()),
  useProjectFilePickerQuery: () => ({
    entries: state.entries,
    error: null,
    isPending: false,
    matchedQuery: "",
  }),
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: toast } };
});

import { appAtomRegistry } from "~/rpc/atomRegistry";

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
  state.entries = [];
  state.assets.clear();
  state.canReadFiles = true;
  state.createUrl
    .mockReset()
    .mockImplementation(({ input }) => state.assets.get(input.resource.path)!);
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

async function renderPicker(onPickExternal?: () => Promise<string | null>) {
  const onOpenChange = vi.fn();
  const onSelect = vi.fn();
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ProjectFaviconPickerDialog
          cwd="/Users/me/project"
          environmentId={EnvironmentId.make("local")}
          onOpenChange={onOpenChange}
          {...(onPickExternal ? { onPickExternal } : {})}
          onSelect={onSelect}
          open
          projectName="Project"
        />
      </RegistryContext.Provider>,
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

const imageUrl = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
)}`;

function addFiles(paths: string[]) {
  state.entries = paths.map((path) => ({ path, kind: "file" }));
  for (const path of paths) state.assets.set(path, Atom.make<AssetResult>(AsyncResult.initial()));
}

function fileRow(path: string) {
  const row = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) =>
    element.textContent?.includes(path),
  );
  expect(row, path).toBeDefined();
  return row!;
}

async function publishUrl(path: string, url: string) {
  await act(async () => {
    appAtomRegistry.set(
      state.assets.get(path)!,
      AsyncResult.success({ relativeUrl: url, expiresAt: Date.now() + 60_000 }),
    );
  });
}

async function expectPreview(row: HTMLElement) {
  await expect.poll(() => row.querySelector("img")?.naturalWidth).toBe(8);
  expect(row.querySelector("svg")).toBeNull();
}

it("loads previews asynchronously and only acquires offscreen images after scrolling", async () => {
  const paths = Array.from({ length: 40 }, (_, index) => `icons/icon-${index}.svg`);
  addFiles(paths);
  const { onSelect } = await renderPicker();
  const first = fileRow("icons/icon-0.svg");
  const last = fileRow("icons/icon-39.svg");

  await expect.poll(() => state.createUrl.mock.calls.length).toBeGreaterThan(0);
  expect(first.querySelector("img")).toBeNull();
  expect(first.querySelector("svg")).not.toBeNull();
  expect(last.getBoundingClientRect().top).toBeGreaterThan(window.innerHeight);
  expect(
    state.createUrl.mock.calls.some(
      ([target]) => target.input.resource.path === "icons/icon-39.svg",
    ),
  ).toBe(false);

  await publishUrl("icons/icon-0.svg", imageUrl);
  await expectPreview(first);

  await act(async () => last.scrollIntoView({ block: "center" }));
  await expect
    .poll(() =>
      state.createUrl.mock.calls.some(
        ([target]) => target.input.resource.path === "icons/icon-39.svg",
      ),
    )
    .toBe(true);
  await publishUrl("icons/icon-39.svg", imageUrl);
  await expectPreview(last);
  await act(async () => last.click());
  expect(onSelect).toHaveBeenCalledWith("icons/icon-39.svg");
});

it("loads without IntersectionObserver and recovers a failed image when its URL changes", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  addFiles(["icons/logo.svg"]);
  await renderPicker();
  const row = fileRow("icons/logo.svg");

  expect(state.createUrl).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("local"),
    input: {
      resource: { _tag: "draft-workspace-file", cwd: "/Users/me/project", path: "icons/logo.svg" },
    },
  });
  expect(row.querySelector("svg")).not.toBeNull();
  await publishUrl("icons/logo.svg", imageUrl);
  await expectPreview(row);

  // Let Chromium reject the image bytes rather than dispatching a synthetic error.
  await publishUrl("icons/logo.svg", "data:image/png;base64,broken");
  await expect.poll(() => row.querySelector("img")).toBeNull();
  expect(row.querySelector("svg")).not.toBeNull();

  await publishUrl("icons/logo.svg", `${imageUrl}#renewed`);
  await expectPreview(row);
});

it("keeps denied previews selectable with their file icon", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  state.canReadFiles = false;
  addFiles(["icons/private.svg"]);
  const { onSelect } = await renderPicker();
  const row = fileRow("icons/private.svg");

  await act(async () => row.click());
  expect(row.querySelector("img")).toBeNull();
  expect(row.querySelector("svg")).not.toBeNull();
  expect(state.createUrl).not.toHaveBeenCalled();
  expect(onSelect).toHaveBeenCalledWith("icons/private.svg");
});

it("keeps the file icon until the image load is acknowledged", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  addFiles(["icons/loading.svg"]);
  await renderPicker();
  const row = fileRow("icons/loading.svg");
  // Hold the load notification so a fast data URL has the same UI state as a slow request.
  const holdLoad = (event: Event) => {
    if (event.target instanceof HTMLImageElement && row.contains(event.target)) {
      event.stopImmediatePropagation();
    }
  };
  document.addEventListener("load", holdLoad, true);
  try {
    await publishUrl("icons/loading.svg", imageUrl);
    await expect.poll(() => row.querySelector("img")?.naturalWidth).toBe(8);
    expect(row.querySelector("svg")).not.toBeNull();
    document.removeEventListener("load", holdLoad, true);
    await publishUrl("icons/loading.svg", `${imageUrl}#loaded`);
    await expectPreview(row);
  } finally {
    document.removeEventListener("load", holdLoad, true);
  }
});
