import { act, render, type Screen } from "../../../test/render";
import "../../index.css";

import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import JSZip from "jszip";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { ComposerHandleContext, type ComposerHandleRef } from "~/composerHandleContext";
import { ZipPreviewError, type ZipPreviewEntry } from "~/lib/zipPreview";

import ZipArchivePreview from "./ZipArchivePreview";

const { load, readFile, readFileForSave, readTextPrefix, refresh } = vi.hoisted(() => ({
  load: vi.fn(),
  readFile: vi.fn(),
  readFileForSave: vi.fn(),
  readTextPrefix: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock(import("~/lib/zipPreview"), async (original) => ({
  ...(await original()),
  loadZipPreview: load,
}));
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => refresh,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector
      ? selector(DEFAULT_CLIENT_SETTINGS)
      : DEFAULT_CLIENT_SETTINGS) as typeof import("~/hooks/useSettings").useClientSettings,
}));
vi.mock("~/components/ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <article>{text}</article>,
}));
vi.mock("./ReadOnlySourcePreview", () => ({
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));

const entry = (path: string): ZipPreviewEntry => ({
  path,
  name: path.split("/").at(-1)!,
  isDirectory: path.endsWith("/"),
  sizeBytes: 3,
  mimeType: null,
});

function setup(entries = [entry("photos/a.png"), entry("src/app.ts")]) {
  const files = entries.filter((entry) => !entry.isDirectory);
  load.mockReset().mockResolvedValue({
    entries,
    readFile,
    readFileForSave,
    readTextPrefix,
    fileCount: files.length,
    hiddenCount: 0,
    imagesOnly:
      files.length > 0 && files.every((entry) => /\.(png|jpe?g|gif|webp)$/.test(entry.name)),
  });
  readFile.mockReset().mockImplementation(async (entry: ZipPreviewEntry) => new Blob([entry.name]));
  readFileForSave
    .mockReset()
    .mockImplementation(async (entry: ZipPreviewEntry) => new Blob([entry.name]));
  readTextPrefix.mockReset();
  refresh.mockReset();
}

async function realArchive(zip: JSZip) {
  const original = await vi.importActual<typeof import("~/lib/zipPreview")>("~/lib/zipPreview");
  load.mockImplementation(original.loadZipPreview);
  return new Blob([await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })]);
}

function png() {
  return new Blob(
    [
      Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        ),
        (character) => character.charCodeAt(0),
      ),
    ],
    { type: "image/png" },
  );
}

function composerTarget() {
  const addDroppedFiles = vi.fn<(files: File[]) => void>();
  const handle: Pick<NonNullable<ComposerHandleRef["current"]>, "addDroppedFiles"> = {
    addDroppedFiles,
  };
  return {
    addDroppedFiles,
    handle: handle as NonNullable<ComposerHandleRef["current"]>,
  };
}

async function open(
  props: Partial<ComponentProps<typeof ZipArchivePreview>> = {},
  { width = 900, composer = null }: { width?: number; composer?: ComposerHandleRef | null } = {},
) {
  const container = document.createElement("div");
  container.style.cssText = `display: flex; width: ${width}px; height: 480px;`;
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <ComposerHandleContext value={composer}>
        <ZipArchivePreview
          name="project.zip"
          file={new Blob()}
          url="blob:zip"
          sizeBytes={0}
          origin="Draft"
          countKey={null}
          onSaveZip={() => {}}
          onRetry={() => {}}
          {...props}
        />
      </ComposerHandleContext>,
      { container },
    ),
  );
  await vi.waitFor(() => expect(rows(screen).length).toBeGreaterThan(0));
  const environment = stack.move();
  return { ...screen, [Symbol.asyncDispose]: () => environment.disposeAsync() };
}

function rows(screen: Screen) {
  return [
    ...(screen.container
      .querySelector("file-tree-container")
      ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-item-path]") ?? []),
  ];
}

async function select(screen: Screen, path: string) {
  await vi.waitFor(() =>
    expect(
      rows(screen).some((row) => row.dataset.itemPath === path),
      path,
    ).toBe(true),
  );
  const row = rows(screen).find((row) => row.dataset.itemPath === path)!;
  await act(() => row.click());
}

async function back(screen: Screen) {
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(screen.container.querySelector("pre, article, img")).toBeNull());
}

describe("ZIP file browsing", () => {
  it("clears an unmatched filter and restores the files", async () => {
    setup();
    await using screen = await open();
    await expect
      .element(screen.getByRole("button", { name: "Grid view", exact: true }))
      .not.toBeInTheDocument();
    const filter = screen.getByRole("searchbox", { name: "Search ZIP files" });
    await userEvent.fill(filter, "invoice");
    await vi.waitFor(() => expect(screen.container.textContent).toContain("No files match"));
    await userEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    await expect.element(filter).toHaveValue("");
    await select(screen, "src/app.ts");
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("app.ts"),
    );
  });

  it("returns to the filtered file list and scroll position on a phone", async () => {
    setup(Array.from({ length: 200 }, (_, index) => entry(`src/app-${index}.ts`)));
    await using screen = await open({}, { width: 390 });
    const filter = screen.getByRole("searchbox", { name: "Search ZIP files" });
    const input = filter.element();
    await userEvent.fill(filter, "app-");
    const scroller = screen.container
      .querySelector("file-tree-container")!
      .shadowRoot!.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll]")!;
    await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight));
    await act(() => {
      scroller.scrollTop = 500;
      scroller.dispatchEvent(new Event("scroll"));
    });
    const path = await vi.waitFor(() => {
      const viewport = scroller.getBoundingClientRect();
      const row = rows(screen).find((row) => {
        const rect = row.getBoundingClientRect();
        return (
          row.dataset.itemPath?.endsWith(".ts") &&
          rect.top >= viewport.top &&
          rect.bottom <= viewport.bottom
        );
      });
      expect(row).toBeDefined();
      return row!.dataset.itemPath!;
    });
    const scrollTop = scroller.scrollTop;
    const name = path.split("/").at(-1)!;
    await select(screen, path);
    await vi.waitFor(() => expect(screen.container.querySelector("pre")?.textContent).toBe(name));
    await vi.waitFor(() => expect(input.checkVisibility()).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: "Back to ZIP files" }));
    await expect.element(filter).toBeVisible();
    await expect.element(filter).toHaveValue("app-");
    await vi.waitFor(() => expect(scroller.scrollTop).toBe(scrollTop));
    await select(screen, path);
    await vi.waitFor(() => expect(screen.container.querySelector("pre")?.textContent).toBe(name));
  });

  it("returns from a nested ZIP to the outer files on a phone", async () => {
    setup();
    const nested = await new JSZip()
      .file("inside.txt", "Nested file")
      .generateAsync({ type: "uint8array" });
    const file = await realArchive(
      new JSZip().file("nested.zip", nested).file("outer.txt", "Outer file"),
    );
    await using screen = await open({ file }, { width: 390 });
    const outerFilter = screen.getByRole("searchbox", { name: "Search ZIP files" }).element();
    await select(screen, "nested.zip");
    await vi.waitFor(() =>
      expect(
        screen.container
          .querySelectorAll("file-tree-container")[1]
          ?.shadowRoot?.querySelector<HTMLElement>('[data-item-path="inside.txt"]')
          ?.checkVisibility(),
      ).toBe(true),
    );
    expect(outerFilter.checkVisibility()).toBe(false);
    const back = screen.getByRole("button", { name: "Back to ZIP files" });
    await expect.element(back).toBeVisible();
    await userEvent.click(back);
    await vi.waitFor(() => expect(outerFilter.checkVisibility()).toBe(true));
    await select(screen, "outer.txt");
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("Outer file"),
    );
  });

  it("adds only the selected file from a real ZIP to the chat", async () => {
    setup();
    const target = composerTarget();
    const file = await realArchive(
      new JSZip().file("src/app.ts", "export const answer = 42;").file("private.txt", "other file"),
    );
    await using screen = await open({ file }, { composer: { current: target.handle } });
    await select(screen, "src/app.ts");
    await userEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    await vi.waitFor(() => expect(target.addDroppedFiles).toHaveBeenCalledTimes(1));
    const [files] = target.addDroppedFiles.mock.calls[0]!;
    expect(files).toHaveLength(1);
    expect(files[0]).toBeInstanceOf(File);
    expect(files[0]!.name).toBe("app.ts");
    expect(await files[0]!.text()).toBe("export const answer = 42;");
  });

  it.each(["composer changes", "panel closes"])(
    "protects the selected attachment while extraction is pending and the %s",
    async (action) => {
      setup([entry("selected.txt"), entry("other.txt")]);
      const target = composerTarget();
      const nextTarget = composerTarget();
      const composer = { current: target.handle };
      let finish!: (blob: Blob) => void;
      let pendingSignal!: AbortSignal;
      readFileForSave.mockImplementationOnce((_entry: ZipPreviewEntry, signal: AbortSignal) => {
        pendingSignal = signal;
        return new Promise<Blob>((resolve) => {
          finish = resolve;
        });
      });
      await using screen = await open({}, { composer });
      await select(screen, "selected.txt");
      await userEvent.click(screen.getByRole("button", { name: "Add to chat" }));
      await vi.waitFor(() => expect(readFileForSave).toHaveBeenCalledTimes(1));
      if (action === "composer changes") composer.current = nextTarget.handle;
      else await screen.unmount();
      await act(() => finish(new Blob(["selected bytes"], { type: "text/plain" })));
      expect(nextTarget.addDroppedFiles).not.toHaveBeenCalled();
      if (action === "panel closes") {
        expect(pendingSignal.aborted).toBe(true);
        expect(target.addDroppedFiles).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(target.addDroppedFiles).toHaveBeenCalledTimes(1));
        const [files] = target.addDroppedFiles.mock.calls[0]!;
        expect(files).toHaveLength(1);
        expect(files[0]!.name).toBe("selected.txt");
        expect(await files[0]!.text()).toBe("selected bytes");
      }
    },
  );

  it("aborts a pending text-prefix read when the panel closes", async () => {
    setup([entry("server.log")]);
    readFile.mockRejectedValueOnce(new ZipPreviewError("Preview limit", "file-limit"));
    let finish!: (result: { text: string; truncated: boolean }) => void;
    let pendingSignal!: AbortSignal;
    readTextPrefix.mockImplementationOnce((_entry: ZipPreviewEntry, signal: AbortSignal) => {
      pendingSignal = signal;
      return new Promise<{ text: string; truncated: boolean }>((resolve) => {
        finish = resolve;
      });
    });
    await using screen = await open();
    await select(screen, "server.log");
    await userEvent.click(screen.getByRole("button", { name: "Show first 1 MB" }));
    await vi.waitFor(() => expect(readTextPrefix).toHaveBeenCalledTimes(1));
    await screen.unmount();
    await act(() => finish({ text: "late prefix", truncated: true }));
    expect(pendingSignal.aborted).toBe(true);
  });

  it("shows the first MiB of an oversized log through the shared text viewer", async () => {
    setup();
    const file = await realArchive(new JSZip().file("server.log", "x".repeat(11 * 1024 * 1024)));
    await using screen = await open({ file });
    await select(screen, "server.log");
    await vi.waitFor(() => expect(screen.container.textContent).toContain("Too big to preview"));
    await userEvent.click(screen.getByRole("button", { name: "Show first 1 MB" }));
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("x".repeat(1024 * 1024)),
    );
    await vi.waitFor(() => expect(screen.container.textContent).toMatch(/truncat|first 1/));
  });

  it.each([
    ["report.pdf", "application/pdf"],
    ["movie.mp4", "video/mp4"],
    ["audio.mp3", "audio/mpeg"],
    ["nested.zip", "application/zip"],
    ["program.bin", null],
  ] as const)("offers saving without a text prefix for oversized %s", async (name, mimeType) => {
    setup([{ ...entry(name), mimeType, sizeBytes: 11 * 1024 * 1024 }]);
    readFile.mockRejectedValueOnce(new ZipPreviewError("Preview limit", "file-limit"));
    await using screen = await open();
    await select(screen, name);
    await expect
      .element(screen.getByRole("button", { name: "Save file", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Show first 1 MB" }))
      .not.toBeInTheDocument();
  });

  it("saves an image above the pixel limit without decoding it", async () => {
    setup();
    const bytes = new Uint8Array(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const dimensions = new DataView(bytes.buffer);
    dimensions.setUint32(16, 12000);
    dimensions.setUint32(20, 9000);
    const file = await realArchive(new JSZip().file("hero.png", bytes));
    await using screen = await open({ file });
    using createUrl = vi.spyOn(URL, "createObjectURL");
    using click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await select(screen, "hero.png");
    await vi.waitFor(() => expect(screen.container.textContent).toContain("Too large to preview"));
    expect(screen.container.querySelector("img")).toBeNull();
    expect(createUrl).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Save file", exact: true }));
    await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("hero.png");
    const saved = createUrl.mock.calls[0]![0] as Blob;
    expect(new Uint8Array(await saved.arrayBuffer())).toEqual(bytes);
    expect(screen.container.querySelector("img")).toBeNull();
  });

  it.each([
    ["encrypted", "This ZIP is password-protected"],
    ["archive-limit", "Too large to browse here"],
    ["entry-limit", "Too large to browse here"],
    ["invalid", "Couldn't read this ZIP"],
  ] as const)("offers archive recovery for a typed %s failure", async (reason, title) => {
    setup();
    load.mockRejectedValueOnce(new ZipPreviewError("Archive diagnostic", reason));
    const retry = vi.fn();
    const save = vi.fn();
    await using screen = await render(
      <ZipArchivePreview
        name="project.zip"
        file={new Blob()}
        url="blob:zip"
        sizeBytes={0}
        origin="Draft"
        countKey={null}
        onSaveZip={save}
        onRetry={retry}
      />,
    );
    await vi.waitFor(() => expect(screen.container.textContent).toContain(title));
    await expect.element(screen.getByRole("button", { name: "Save ZIP" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Save ZIP" }));
    expect(save).toHaveBeenCalledTimes(1);
    if (reason === "invalid") {
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(retry).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["Cancel", "unmount"])(
    "releases an incomplete download on %s without parsing the partial ZIP",
    async (action) => {
      setup();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
        cancel,
      });
      using fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
      await using screen = await render(
        <ZipArchivePreview
          name="remote.zip"
          file={null}
          url="https://example.test/remote.zip"
          sizeBytes={2 * 1024 * 1024}
          origin="Remote"
          countKey={null}
          onSaveZip={() => {}}
          onRetry={() => {}}
        />,
      );
      await act(() => stream.enqueue(new Uint8Array(1024 * 1024)));
      await vi.waitFor(() => expect(screen.container.textContent).toContain("1.0 MB"));
      await expect
        .element(screen.getByRole("progressbar", { name: "ZIP download progress" }))
        .toHaveAttribute("aria-valuenow", String(1024 * 1024));
      await expect
        .element(screen.getByRole("progressbar", { name: "ZIP download progress" }))
        .toHaveAttribute("aria-valuemax", String(2 * 1024 * 1024));
      if (action === "Cancel") {
        await userEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
      } else {
        await screen.unmount();
      }
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
      expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
      expect(load).not.toHaveBeenCalled();
    },
  );

  it("virtualizes 2,000 images without extracting or decoding while browsing and searching", async () => {
    setup(Array.from({ length: 2000 }, (_, index) => entry(`photos/image-${index}.png`)));
    readFile.mockResolvedValue(png());
    using createUrl = vi.spyOn(URL, "createObjectURL");
    await using screen = await open();
    expect(screen.container.textContent).toContain("2,000 images");
    expect(rows(screen).length).toBeLessThan(2000);
    await userEvent.fill(screen.getByRole("searchbox", { name: "Search ZIP files" }), "image-1999");
    await vi.waitFor(() =>
      expect(rows(screen).map((row) => row.dataset.itemPath)).toContain("photos/image-1999.png"),
    );
    expect(readFile).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
    expect(screen.container.querySelector("img")).toBeNull();

    await select(screen, "photos/image-1999.png");
    await expect.element(screen.getByRole("img", { name: "image-1999.png" })).toBeVisible();
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("loads only visible image thumbnails and keeps the filter when switching grid and tree", async () => {
    setup(Array.from({ length: 2000 }, (_, index) => entry(`photos/image-${index}.png`)));
    readFile.mockResolvedValue(png());
    await using screen = await open();
    await userEvent.click(screen.getByRole("button", { name: "Grid view", exact: true }));
    await vi.waitFor(() =>
      expect(screen.container.querySelectorAll("img").length).toBeGreaterThan(0),
    );
    expect(screen.container.querySelectorAll("button").length).toBeLessThan(2000);
    expect(screen.container.querySelectorAll("img").length).toBeLessThan(2000);
    expect(readFile.mock.calls.length).toBeGreaterThan(0);
    expect(readFile.mock.calls.length).toBeLessThan(2000);
    const filter = screen.getByRole("searchbox", { name: "Search ZIP files" });
    await userEvent.fill(filter, "image-1999");
    const tile = screen.getByRole("button", { name: "image-1999.png", exact: true });
    await expect.element(tile).toBeVisible();
    await vi.waitFor(() => expect(tile.element().querySelector("img")?.naturalWidth).toBe(1));
    expect(readFile.mock.calls.length).toBeLessThan(2000);
    await userEvent.click(screen.getByRole("button", { name: "Tree view", exact: true }));
    await expect.element(filter).toHaveValue("image-1999");
    await vi.waitFor(() =>
      expect(rows(screen).map((row) => row.dataset.itemPath)).toContain("photos/image-1999.png"),
    );
  });

  it.each([
    ["src/app.ts", "export const answer = 42;", "pre"],
    ["logs/app.log", "server ready", "pre"],
    ["README.md", "# ZIP project", "article"],
  ] as const)(
    "opens %s with the shared text viewer and can reopen it",
    async (path, contents, tag) => {
      setup([entry(path)]);
      readFile.mockResolvedValue(new Blob([contents]));
      using createUrl = vi.spyOn(URL, "createObjectURL");
      using revokeUrl = vi.spyOn(URL, "revokeObjectURL");
      await using screen = await open();
      await select(screen, path);
      await vi.waitFor(() =>
        expect(screen.container.querySelector(tag)?.textContent).toBe(contents),
      );
      await expect.element(screen.getByRole("button", { name: "Copy contents" })).toBeVisible();
      if (tag === "article") {
        await userEvent.click(screen.getByRole("button", { name: "Show markdown source" }));
        await vi.waitFor(() =>
          expect(screen.container.querySelector("pre")?.textContent).toBe(contents),
        );
      }
      const url = createUrl.mock.results[0]!.value;
      await back(screen);
      expect(revokeUrl).toHaveBeenCalledWith(url);
      await select(screen, path);
      await vi.waitFor(() =>
        expect(screen.container.querySelector(tag)?.textContent).toBe(contents),
      );
      await screen.unmount();
      expect(revokeUrl).toHaveBeenCalledWith(createUrl.mock.results[1]!.value);
    },
  );

  it("shows CSV as a table and can switch to shared source view", async () => {
    setup([entry("data.csv")]);
    readFile.mockResolvedValue(new Blob(["name,value\nexample,42"]));
    await using screen = await open();
    await select(screen, "data.csv");
    await vi.waitFor(() =>
      expect([...screen.container.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual([
        "name",
        "value",
      ]),
    );
    expect([...screen.container.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual([
      "example",
      "42",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Show source" }));
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("name,value\nexample,42"),
    );
  });

  it("aborts stale extraction and releases the selected file on return", async () => {
    setup();
    let finish!: (file: Blob) => void;
    let pendingSignal!: AbortSignal;
    readFile.mockImplementationOnce((_entry: ZipPreviewEntry, signal: AbortSignal) => {
      pendingSignal = signal;
      return new Promise<Blob>((resolve) => {
        finish = resolve;
      });
    });
    using createUrl = vi.spyOn(URL, "createObjectURL");
    using revokeUrl = vi.spyOn(URL, "revokeObjectURL");
    await using screen = await open();
    await select(screen, "photos/a.png");
    await select(screen, "src/app.ts");
    expect(pendingSignal.aborted).toBe(true);
    await act(() => finish(new Blob(["stale image"])));
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("app.ts"),
    );
    expect(screen.container.querySelector("img")).toBeNull();
    expect(createUrl).toHaveBeenCalledTimes(1);
    await back(screen);
    expect(revokeUrl).toHaveBeenCalledWith(createUrl.mock.results[0]!.value);
  });

  it.each(["Escape", "Backspace"])(
    "returns to the tree with %s without consuming text input",
    async (key) => {
      setup();
      using createUrl = vi.spyOn(URL, "createObjectURL");
      using revokeUrl = vi.spyOn(URL, "revokeObjectURL");
      await using screen = await open();
      await select(screen, "src/app.ts");
      await vi.waitFor(() =>
        expect(screen.container.querySelector("pre")?.textContent).toBe("app.ts"),
      );
      const input = screen.container.querySelector<HTMLInputElement>('input[type="search"]')!;
      input.focus();
      const editable = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(() => input.dispatchEvent(editable));
      expect(editable.defaultPrevented).toBe(false);
      expect(screen.container.querySelector("pre")?.textContent).toBe("app.ts");

      const root = screen.container.querySelector<HTMLElement>('[tabindex="-1"]')!;
      root.focus();
      const navigation = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(() => root.dispatchEvent(navigation));
      expect(navigation.defaultPrevented).toBe(true);
      expect(screen.container.querySelector("pre")).toBeNull();
      expect(revokeUrl).toHaveBeenCalledWith(createUrl.mock.results[0]!.value);
      await select(screen, "src/app.ts");
      await vi.waitFor(() =>
        expect(screen.container.querySelector("pre")?.textContent).toBe("app.ts"),
      );
    },
  );

  it("keeps same-name files and folders accessible without tree path collisions", async () => {
    setup([
      entry("same"),
      entry("same/"),
      entry("same/app.ts"),
      entry("same (file)"),
      entry("same (file)/"),
      entry("same (file)/nested.txt"),
    ]);
    await using screen = await open();
    for (const [path, name] of [
      ["same (file) (file)", "same"],
      ["same (file) (file) (file)", "same (file)"],
    ] as const) {
      await select(screen, path);
      await expect
        .element(screen.getByText("No preview for this file", { exact: true }))
        .toBeVisible();
      expect(readFile).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: name }),
        expect.any(AbortSignal),
      );
      await back(screen);
    }
    await select(screen, "same/app.ts");
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("app.ts"),
    );
    await back(screen);
    await select(screen, "same (file)/nested.txt");
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("nested.txt"),
    );
  });

  it("offers saving a small unsupported SVG without decoding it or losing the tree", async () => {
    setup();
    const file = await realArchive(
      new JSZip()
        .file("icon.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>')
        .file("app.ts", "export const answer = 42;"),
    );
    await using screen = await open({ file });
    using createUrl = vi.spyOn(URL, "createObjectURL");
    await select(screen, "icon.svg");
    const failure = screen.getByRole("alert");
    await expect.element(failure).toBeVisible();
    expect(failure.element().textContent).toContain(
      "Cannot safely preview this image. Download the ZIP to open it.",
    );
    await expect
      .element(screen.getByRole("button", { name: "Save file", exact: true }))
      .toBeVisible();
    expect(screen.container.textContent).not.toContain("Too large");
    expect(screen.container.querySelector("img")).toBeNull();
    expect(createUrl).not.toHaveBeenCalled();
    await back(screen);
    await select(screen, "app.ts");
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("export const answer = 42;"),
    );
  });

  it.each([
    ["File preview supports files up to 10 MiB.", "file-limit", "Too big to preview in full"],
    [
      "Image preview supports up to 16 million pixels and 8,192 pixels per side. Download the ZIP to open it.",
      "image-limit",
      "Too large to preview safely",
    ],
    [
      "Cannot safely preview this image. Download the ZIP to open it.",
      "unsupported",
      "Cannot safely preview this image. Download the ZIP to open it.",
    ],
  ] as const)(
    "shows %s without decoding or losing the file tree",
    async (message, reason, copy) => {
      setup();
      readFile.mockRejectedValueOnce(new ZipPreviewError(message, reason));
      using createUrl = vi.spyOn(URL, "createObjectURL");
      await using screen = await open();
      await select(screen, "photos/a.png");
      await expect.element(screen.getByText(copy, { exact: true })).toBeVisible();
      expect(screen.container.querySelector("img")).toBeNull();
      expect(createUrl).not.toHaveBeenCalled();
      await back(screen);
      await select(screen, "src/app.ts");
      await vi.waitFor(() =>
        expect(screen.container.querySelector("pre")?.textContent).toBe("app.ts"),
      );
    },
  );
});
