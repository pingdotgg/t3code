import { FileTree } from "@pierre/trees/react";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ZipPreviewEntry } from "~/lib/zipPreview";

import ZipArchivePreview from "./ZipArchivePreview";

const { load, readFile, refresh } = vi.hoisted(() => ({
  load: vi.fn(),
  readFile: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("~/lib/zipPreview", () => ({
  loadZipPreview: load,
  readZipPreviewResponse: vi.fn(),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/assets/assetUrls", () => ({ useAssetUrlRefresh: () => refresh }));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => false,
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/components/ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <article>{text}</article>,
}));
vi.mock("./ReadOnlySourcePreview", () => ({
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./fileSurfaceChrome", () => ({
  FILE_SURFACE_SUBHEADER_CLASS: "",
  FileSurfaceAction: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button aria-label={label} onClick={onPress} />
  ),
  FileSurfaceFailure: ({ message }: { message: string }) => <div role="alert">{message}</div>,
  FileSurfaceLoading: () => <div role="status">Loading</div>,
  FileSurfaceNotice: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function textFile(contents: string) {
  const file = new Blob([contents]);
  vi.spyOn(file, "stream").mockImplementation(
    () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(contents));
          controller.close();
        },
      }),
  );
  return file;
}

const entry = (path: string): ZipPreviewEntry => ({
  path,
  name: path.split("/").at(-1)!,
  isDirectory: path.endsWith("/"),
  sizeBytes: 3,
  mimeType: null,
});

let renderer: ReactTestRenderer;
const model = () =>
  renderer.root.findByType(FileTree).props.model as ReturnType<
    typeof import("@pierre/trees/react").useFileTree
  >["model"];
const select = async (path: string) => {
  await act(async () => model().getItem(path)!.select());
};
const open = async (entries: ZipPreviewEntry[] = [entry("photos/a.png"), entry("src/app.ts")]) => {
  load.mockResolvedValue({ entries, readFile });
  await act(async () => {
    renderer = create(
      <ZipArchivePreview name="project.zip" file={new Blob()} url="blob:zip" onRetry={() => {}} />,
    );
  });
};
const back = async () => {
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Back to ZIP files" }).props.onClick(),
  );
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let next = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:${next++}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  readFile.mockReset().mockImplementation(async (entry: ZipPreviewEntry) => textFile(entry.name));
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ZIP file browsing", () => {
  it("does not extract or decode 2,000 images while browsing or searching the tree", async () => {
    await open(Array.from({ length: 2000 }, (_, index) => entry(`photos/image-${index}.png`)));
    await act(async () => model().setSearch("image-1999"));
    expect(model().getSearchMatchingPaths()).toContain("photos/image-1999.png");
    expect(readFile).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType("img")).toHaveLength(0);

    await select("photos/image-1999.png");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType("img").props.alt).toBe("image-1999.png");
  });

  it.each([
    ["src/app.ts", "export const answer = 42;", "pre"],
    ["logs/app.log", "server ready", "pre"],
    ["README.md", "# ZIP project", "article"],
  ] as const)("opens %s with the shared text viewer", async (path, contents, tag) => {
    readFile.mockResolvedValue(textFile(contents));
    await open([entry(path)]);
    await select(path);
    expect(renderer.root.findByType(tag).children).toEqual([contents]);
    await back();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:0");
    await select(path);
    expect(renderer.root.findByType(tag).children).toEqual([contents]);
  });

  it("shows CSV contents as a table", async () => {
    readFile.mockResolvedValue(textFile("name,value\nexample,42"));
    await open([entry("data.csv")]);
    await select("data.csv");
    expect(renderer.root.findAllByType("th").map((cell) => cell.children.join(""))).toEqual([
      "name",
      "value",
    ]);
    expect(renderer.root.findAllByType("td").map((cell) => cell.children.join(""))).toEqual([
      "example",
      "42",
    ]);
  });

  it("aborts stale extraction and releases the selected file on return", async () => {
    let finish!: (file: Blob) => void;
    let pendingSignal!: AbortSignal;
    readFile.mockImplementationOnce((_entry: ZipPreviewEntry, signal: AbortSignal) => {
      pendingSignal = signal;
      return new Promise<Blob>((resolve) => {
        finish = resolve;
      });
    });
    await open();
    await select("photos/a.png");
    await select("src/app.ts");
    expect(pendingSignal.aborted).toBe(true);
    await act(async () => finish(new Blob(["stale image"])));
    expect(renderer.root.findAllByType("img")).toHaveLength(0);
    expect(renderer.root.findByType("pre").children).toEqual(["app.ts"]);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    await back();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:0");
  });

  it.each(["Escape", "Backspace"])(
    "returns to the tree with %s without consuming text input",
    async (key) => {
      await open();
      await select("src/app.ts");
      const keyDown = (editable: boolean) => ({
        key,
        target: { closest: () => (editable ? {} : null) },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
      const editable = keyDown(true);
      await act(async () => renderer.root.findByProps({ tabIndex: -1 }).props.onKeyDown(editable));
      expect(editable.preventDefault).not.toHaveBeenCalled();
      expect(renderer.root.findByType("pre").children).toEqual(["app.ts"]);
      const navigation = keyDown(false);
      await act(async () =>
        renderer.root.findByProps({ tabIndex: -1 }).props.onKeyDown(navigation),
      );
      expect(navigation.preventDefault).toHaveBeenCalled();
      expect(renderer.root.findAllByType("pre")).toHaveLength(0);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:0");
      await select("src/app.ts");
      expect(renderer.root.findByType("pre").children).toEqual(["app.ts"]);
    },
  );

  it("keeps a file and folder with the same name accessible without tree path collisions", async () => {
    await open([
      entry("same"),
      entry("same/"),
      entry("same/app.ts"),
      entry("same (file)"),
      entry("same (file)/"),
      entry("same (file)/nested.txt"),
    ]);
    expect(model().getItem("same/")?.isDirectory()).toBe(true);
    await select("same (file) (file)");
    expect(readFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "same" }),
      expect.any(AbortSignal),
    );
    await back();
    await select("same (file) (file) (file)");
    expect(readFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "same (file)" }),
      expect.any(AbortSignal),
    );
    await back();
    await select("same/app.ts");
    expect(renderer.root.findByType("pre").children).toEqual(["app.ts"]);
  });

  it.each([
    "File preview supports files up to 10 MiB.",
    "Image preview supports up to 16 million pixels and 8,192 pixels per side. Download the ZIP to open it.",
    "Cannot safely preview this image. Download the ZIP to open it.",
  ])("shows %s without decoding or losing the file tree", async (message) => {
    readFile.mockRejectedValueOnce(new Error(message));
    await open();
    await select("photos/a.png");
    expect(renderer.root.findByProps({ role: "alert" }).children).toEqual([message]);
    expect(renderer.root.findAllByType("img")).toHaveLength(0);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await back();
    await select("src/app.ts");
    expect(renderer.root.findByType("pre").children).toEqual(["app.ts"]);
  });
});
