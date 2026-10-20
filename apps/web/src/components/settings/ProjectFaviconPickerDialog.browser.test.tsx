import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type AssetCreateUrlResult, type ProjectEntry } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render, stubGlobal } from "../../../test/render";

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

function setup() {
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  toast.mockClear();
  state.entries = [];
  state.assets.clear();
  state.canReadFiles = true;
  state.createUrl
    .mockReset()
    .mockImplementation(({ input }) => state.assets.get(input.resource.path)!);
  return { [Symbol.dispose]: () => platform.mockRestore() };
}

async function renderPicker(onPickExternal?: () => Promise<string | null>) {
  const onOpenChange = vi.fn();
  const onSelect = vi.fn();
  const screen = await render(
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
  );
  return Object.assign(screen, { onOpenChange, onSelect });
}
async function clickOpenInFinder() {
  const button = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.includes("Open in Finder"),
  );
  expect(button, "Open in Finder").toBeDefined();
  await act(async () => button!.click());
}

it("selects an image from the native file picker", async () => {
  using _env = setup();
  const onPickExternal = vi.fn().mockResolvedValue("/Users/me/Pictures/icon.png");
  await using screen = await renderPicker(onPickExternal);

  await clickOpenInFinder();

  expect(onPickExternal).toHaveBeenCalledTimes(1);
  expect(screen.onOpenChange).toHaveBeenCalledWith(false);
  expect(screen.onSelect).toHaveBeenCalledWith("/Users/me/Pictures/icon.png");
});

it("hides the native picker for WSL project paths", () => {
  expect(canPickExternalProjectFavicon("/home/me/project", "Win32")).toBe(false);
  expect(canPickExternalProjectFavicon("C:\\Users\\me\\project", "Win32")).toBe(true);
});

it("keeps the dialog open when the native picker fails", async () => {
  using _env = setup();
  await using screen = await renderPicker(vi.fn().mockRejectedValue(new Error("picker failed")));

  await clickOpenInFinder();

  expect(screen.onOpenChange).not.toHaveBeenCalled();
  expect(screen.onSelect).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith({
    type: "error",
    title: "Could not open image picker",
    description: "picker failed",
  });
});

const imageUrl = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
)}`;

// The registry drops an unsubscribed atom on its next task. A row calls createUrl while it
// renders but subscribes only after React commits, so on a busy runner a URL published
// in between would be dropped. A server keeps its answer; keepAlive models that.
function addFiles(paths: string[]) {
  state.entries = paths.map((path) => ({ path, kind: "file" }));
  for (const path of paths) {
    state.assets.set(path, Atom.make<AssetResult>(AsyncResult.initial()).pipe(Atom.keepAlive));
  }
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

// Decoding sets naturalWidth before the load event reaches React, so wait for both together.
async function expectPreview(row: HTMLElement) {
  await expect
    .poll(() => ({
      width: row.querySelector("img")?.naturalWidth,
      fallback: row.querySelector("svg") !== null,
    }))
    .toEqual({ width: 8, fallback: false });
}

it("loads previews asynchronously and only acquires offscreen images after scrolling", async () => {
  using _env = setup();
  const paths = Array.from({ length: 40 }, (_, index) => `icons/icon-${index}.svg`);
  addFiles(paths);
  await using screen = await renderPicker();
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
  expect(screen.onSelect).toHaveBeenCalledWith("icons/icon-39.svg");
});

it("loads without IntersectionObserver and recovers a failed image when its URL changes", async () => {
  using _env = setup();
  using _observer = stubGlobal("IntersectionObserver", undefined);
  addFiles(["icons/logo.svg"]);
  await using _screen = await renderPicker();
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
  using _env = setup();
  using _observer = stubGlobal("IntersectionObserver", undefined);
  state.canReadFiles = false;
  addFiles(["icons/private.svg"]);
  await using screen = await renderPicker();
  const row = fileRow("icons/private.svg");

  await act(async () => row.click());
  expect(row.querySelector("img")).toBeNull();
  expect(row.querySelector("svg")).not.toBeNull();
  expect(state.createUrl).not.toHaveBeenCalled();
  expect(screen.onSelect).toHaveBeenCalledWith("icons/private.svg");
});

it("keeps the file icon until the image load is acknowledged", async () => {
  using _env = setup();
  using _observer = stubGlobal("IntersectionObserver", undefined);
  addFiles(["icons/loading.svg"]);
  await using _screen = await renderPicker();
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
