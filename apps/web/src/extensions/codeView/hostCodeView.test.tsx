import {
  FileRenderer,
  Virtualizer,
  VirtualizedFile,
  disposeHighlighter,
  getSharedHighlighter,
  type CodeViewItem,
  type CodeViewScrollTarget,
} from "@pierre/diffs";
import type { CodeViewProps } from "@pierre/diffs/react";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import type { CodeViewDiffProps, CodeViewFileProps } from "@t3tools/extension-sdk/environment";
import { useImperativeHandle, type ReactElement, type ReactNode, type Ref } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const view = vi.hoisted(() => ({
  theme: "dark" as "light" | "dark",
  wordWrapSetting: false,
  codeViews: [] as CodeViewProps<undefined>[],
  files: [] as {
    file: { name: string; contents: string; cacheKey?: string };
    options: Record<string, unknown>;
  }[],
  scrolls: [] as CodeViewScrollTarget[],
}));

const hashing = vi.hoisted(() => ({ contentVersions: 0 }));
vi.mock("~/lib/diffRendering", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/diffRendering")>();
  return {
    ...actual,
    buildFileDiffContentVersion: (
      ...args: Parameters<typeof actual.buildFileDiffContentVersion>
    ) => {
      hashing.contentVersions += 1;
      return actual.buildFileDiffContentVersion(...args);
    },
  };
});
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: view.theme }) }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: <T,>(select: (settings: { wordWrap: boolean }) => T) =>
    select({ wordWrap: view.wordWrapSetting }),
}));
vi.mock("~/components/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@pierre/diffs/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pierre/diffs/react")>()),
  // Records what the host hands the viewer; the viewer itself is Pierre's and tested there.
  CodeView: (props: CodeViewProps<undefined> & { ref?: Ref<unknown> }) => {
    view.codeViews.push(props);
    useImperativeHandle(
      props.ref,
      () => ({
        getInstance: () => ({}),
        scrollTo: (target: CodeViewScrollTarget) => view.scrolls.push(target),
      }),
      [],
    );
    return props.items?.map((item) => (
      <header key={item.id} data-item={item.id}>
        {props.renderHeaderPrefix?.(item as CodeViewItem<undefined>)}
      </header>
    ));
  },
  Virtualizer: ({ children }: { children?: ReactNode }) => children,
  File: (props: { file: { name: string; contents: string }; options: Record<string, unknown> }) => {
    view.files.push(props);
    return null;
  },
}));

import { SOURCE_PREVIEW_VIRTUALIZER_CONFIG } from "~/components/files/fileSurfaceChrome";
import { HostCodeDiff, HostCodeFile } from "./HostCodeViewRenderers";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
  "diff --git a/src/b.ts b/src/b.ts",
  "index 3333333..4444444 100644",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -10,2 +10,2 @@",
  "-export const old = true;",
  "+export const next = true;",
  " export default next;",
].join("\n");

const baseDiff: CodeViewDiffProps = { patch: PATCH, layout: "unified", wordWrap: false };
const lastCodeView = () => view.codeViews.at(-1)!;
const diffItems = () =>
  (lastCodeView().items ?? []).flatMap((item) => (item.type === "diff" ? [item] : []));

let renderer: ReactTestRenderer | undefined;
async function render(element: ReactElement) {
  await act(async () => {
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
  return renderer!;
}

beforeEach(() => {
  view.theme = "dark";
  view.wordWrapSetting = false;
  view.codeViews = [];
  view.files = [];
  view.scrolls = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("host code view: Diff", () => {
  it("re-renders under the new theme with a theme-scoped render cache", async () => {
    await render(<HostCodeDiff {...baseDiff} />);
    expect(lastCodeView().options).toMatchObject({ theme: "pierre-dark", themeType: "dark" });
    const darkKeys = diffItems().map((item) => item.fileDiff.cacheKey);

    view.theme = "light";
    await render(<HostCodeDiff {...baseDiff} />);
    expect(lastCodeView().options).toMatchObject({ theme: "pierre-light", themeType: "light" });
    const lightKeys = diffItems().map((item) => item.fileDiff.cacheKey);
    expect(lightKeys).toHaveLength(2);
    for (const [index, key] of lightKeys.entries()) expect(key).not.toBe(darkKeys[index]);
  });

  it("maps layout and wrap onto the native viewer", async () => {
    await render(<HostCodeDiff {...baseDiff} layout="split" wordWrap />);
    expect(lastCodeView().options).toMatchObject({ diffStyle: "split", overflow: "wrap" });
  });

  it("folds the named paths and hands header toggles back by path", async () => {
    const toggles: string[] = [];
    await render(
      <HostCodeDiff
        {...baseDiff}
        collapsedPaths={["src/b.ts"]}
        onToggleCollapsed={(path) => toggles.push(path)}
      />,
    );
    expect(diffItems().map((item) => [item.fileDiff.name, item.collapsed])).toEqual([
      ["src/a.ts", false],
      ["src/b.ts", true],
    ]);
    const buttons = renderer!.root.findAll(
      (node) => node.type === "button" && typeof node.props["aria-label"] === "string",
    );
    expect(buttons.map((button) => button.props["aria-label"])).toEqual([
      "Collapse src/a.ts",
      "Expand src/b.ts",
    ]);
    await act(async () => buttons[1]!.props.onClick({ stopPropagation() {} }));
    expect(toggles).toEqual(["src/b.ts"]);
  });

  it("keeps viewer items across plugin re-renders and hashes each file once", async () => {
    // Plugins rebuild `collapsedPaths` every render; a 10k-line file must not be
    // re-hashed or handed to the viewer as new items for that (D10, native parity).
    const patch = PATCH.replace("const c = 4;", "const c = 5;");
    hashing.contentVersions = 0;
    await render(<HostCodeDiff {...baseDiff} patch={patch} collapsedPaths={["src/b.ts"]} />);
    const items = lastCodeView().items;
    await render(<HostCodeDiff {...baseDiff} patch={patch} collapsedPaths={["src/b.ts"]} />);
    expect(lastCodeView().items).toBe(items);

    await render(<HostCodeDiff {...baseDiff} patch={patch} collapsedPaths={[]} />);
    expect(diffItems().map((item) => item.collapsed)).toEqual([false, false]);
    expect(hashing.contentVersions).toBe(2);
  });

  it("has no header controls when the plugin does not own any", async () => {
    await render(<HostCodeDiff {...baseDiff} fileActions={[{ id: "open", label: "Open" }]} />);
    expect(lastCodeView().renderHeaderPrefix).toBeUndefined();
    expect(lastCodeView().renderHeaderFilenameSuffix).toBeUndefined();
  });

  it("reports header file actions by action id and path", async () => {
    const actions: [string, string][] = [];
    await render(
      <HostCodeDiff
        {...baseDiff}
        fileActions={[
          { id: "open", label: "Open" },
          { id: "copy", label: "Copy path" },
        ]}
        onFileAction={(id, path) => actions.push([id, path])}
      />,
    );
    const suffix = lastCodeView().renderHeaderFilenameSuffix!(diffItems()[1]!);
    await render(<>{suffix}</>);
    const buttons = renderer!.root.findAll((node) => node.type === "button");
    expect(buttons.map((button) => button.props.children)).toEqual(["Open", "Copy path"]);
    buttons[1]!.props.onClick({ stopPropagation() {} });
    expect(actions).toEqual([["copy", "src/b.ts"]]);
  });

  it("scrolls once per reveal request", async () => {
    await render(<HostCodeDiff {...baseDiff} reveal={{ path: "src/b.ts", requestId: 1 }} />);
    const target = diffItems()[1]!.id;
    expect(view.scrolls).toEqual([{ type: "item", id: target, align: "start" }]);

    await render(
      <HostCodeDiff
        {...baseDiff}
        collapsedPaths={["src/a.ts"]}
        reveal={{ path: "src/b.ts", requestId: 1 }}
      />,
    );
    expect(view.scrolls).toHaveLength(1);

    await render(<HostCodeDiff {...baseDiff} reveal={{ path: "src/b.ts", requestId: 2 }} />);
    expect(view.scrolls).toHaveLength(2);

    await render(<HostCodeDiff {...baseDiff} reveal={{ path: "missing.ts", requestId: 3 }} />);
    expect(view.scrolls).toHaveLength(2);
  });

  it("expands context through the latest plugin loader, keyed by patch path", async () => {
    const first = vi.fn(async () => ({ oldContents: "stale", newContents: "stale" }));
    await render(<HostCodeDiff {...baseDiff} loadContents={first} />);
    const loader = lastCodeView().options?.loadDiffFiles;
    expect(loader).toBeTypeOf("function");

    const latest = vi.fn(async (path: string) => ({
      oldContents: `old ${path}`,
      newContents: `new ${path}`,
    }));
    await render(<HostCodeDiff {...baseDiff} loadContents={latest} />);
    // A fresh plugin callback does not hand the viewer new options.
    expect(lastCodeView().options?.loadDiffFiles).toBe(loader);

    const loaded = await loader!(diffItems()[1]!.fileDiff);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith("src/b.ts");
    expect(loaded.oldFile?.contents).toBe("old src/b.ts");
    expect(loaded.newFile.contents).toBe("new src/b.ts");
    expect(loaded.newFile.name).toBe("src/b.ts");

    await render(<HostCodeDiff {...baseDiff} />);
    expect(lastCodeView().options?.loadDiffFiles).toBeUndefined();
  });

  it("keeps both rename sides and decodes their quoted names for context expansion", async () => {
    const patch = [
      'diff --git "a/b/old\\303\\251 space.txt" "b/a/new\\303\\251 space.txt"',
      "similarity index 90%",
      'rename from "b/old\\303\\251 space.txt"',
      'rename to "a/new\\303\\251 space.txt"',
      '--- "a/b/old\\303\\251 space.txt"',
      '+++ "b/a/new\\303\\251 space.txt"',
      "@@ -3 +3 @@",
      "-old",
      "+new",
    ].join("\n");
    const loadContents = vi.fn(async () => ({ oldContents: "old", newContents: "new" }));
    await render(<HostCodeDiff {...baseDiff} patch={patch} loadContents={loadContents} />);
    const loaded = await lastCodeView().options!.loadDiffFiles!(diffItems()[0]!.fileDiff);
    expect(loadContents).toHaveBeenCalledExactlyOnceWith("a/newé space.txt");
    expect(loaded.oldFile?.name).toBe("b/oldé space.txt");
    expect(loaded.newFile.name).toBe("a/newé space.txt");
    expect(loaded.oldFile?.cacheKey).toContain(":old:b/oldé space.txt");
    expect(loaded.newFile.cacheKey).toContain(":new:a/newé space.txt");
  });

  it("shows an unparseable patch as raw text instead of mounting the viewer", async () => {
    await render(<HostCodeDiff {...baseDiff} patch={"not a patch\u0000\n@@ nonsense"} />);
    expect(view.codeViews).toHaveLength(0);
    const text = renderer!.root.findByType("pre").props.children;
    expect(text).toBe("not a patch\u0000\n@@ nonsense");
    expect(renderer!.root.findByType("p").props.children).toMatch(/Showing raw patch/);
  });

  it("renders nothing for an empty patch and survives a truncated hunk", async () => {
    await render(<HostCodeDiff {...baseDiff} patch={"  \n"} />);
    expect(renderer!.toJSON()).toBeNull();

    const truncated = PATCH.split("\n").slice(0, 7).join("\n");
    await render(<HostCodeDiff {...baseDiff} patch={truncated} />);
    expect(renderer!.toJSON()).not.toBeNull();
  });
});

describe("host code view: File", () => {
  const baseFile: CodeViewFileProps = { path: "src/a.ts", contents: "const a = 1;\n" };

  it("follows the host wrap setting unless the plugin sets its own", async () => {
    view.wordWrapSetting = true;
    await render(<HostCodeFile {...baseFile} />);
    expect(view.files.at(-1)?.options.overflow).toBe("wrap");

    await render(<HostCodeFile {...baseFile} wordWrap={false} />);
    expect(view.files.at(-1)?.options.overflow).toBe("scroll");
  });

  it("re-renders under the new theme", async () => {
    await render(<HostCodeFile {...baseFile} />);
    expect(view.files.at(-1)?.options.theme).toBe("pierre-dark");
    view.theme = "light";
    await render(<HostCodeFile {...baseFile} />);
    expect(view.files.at(-1)?.options.theme).toBe("pierre-light");
  });

  it("re-renders an edge-whitespace edit to the same file without stale lines", async () => {
    // Equal length, different line count: only whitespace distinguishes them.
    const before = "\nhello";
    const after = " hello";
    await render(<HostCodeFile path="a.txt" contents={before} />);
    const first = view.files.at(-1)!.file;
    await render(<HostCodeFile path="a.txt" contents={after} />);
    const second = view.files.at(-1)!.file;
    expect(second.cacheKey).not.toBe(first.cacheKey);

    // Pierre's renderer trusts cacheKey for its line cache; drive it the way the worker pool does.
    const theme = "pierre-dark";
    const renderOptions = { theme, useTokenTransformer: false, tokenizeMaxLineLength: 1000 };
    const highlighter = await getSharedHighlighter({ themes: [theme], langs: [] });
    const worker = {
      isWorkingPool: () => true,
      getFileRenderOptions: () => renderOptions,
      getFileResultCache: () => undefined,
      highlighter,
      renderOptions,
      getPlainFileAST: WorkerPoolManager.prototype.getPlainFileAST,
    } as unknown as WorkerPoolManager;
    const fileRenderer = new FileRenderer({ theme }, undefined, worker);
    try {
      fileRenderer.renderFile(first);
      expect(() => fileRenderer.renderFile(second)).not.toThrow();
      expect(fileRenderer.getOrCreateLineCache(second)).toEqual([" hello"]);
    } finally {
      await disposeHighlighter();
    }
  });

  it("passes malformed text through untouched", async () => {
    const contents = `\u0000\r\nlone \ud800 surrogate\r${"x".repeat(200_000)}`;
    await render(<HostCodeFile path={"weird name\t.bin"} contents={contents} />);
    expect(view.files.at(-1)?.file).toMatchObject({ name: "weird name\t.bin", contents });
  });
});

describe("host code view: windowing", () => {
  it("bounds a 10k-line file to the viewport window under the shared config", () => {
    const viewport = { scrollTop: 100_000, height: 600 };
    const virtualizer = new Virtualizer(SOURCE_PREVIEW_VIRTUALIZER_CONFIG);
    Object.assign(virtualizer, {
      getScrollTop: () => viewport.scrollTop,
      getHeight: () => viewport.height,
      getScrollHeight: () => 200_016,
    });
    const file = new VirtualizedFile(
      { overflow: "scroll", disableFileHeader: true, theme: "pierre-dark" },
      virtualizer,
    );
    const lineCount = 10_000;
    const contents = Array.from({ length: lineCount }, (_, i) => `const line${i} = ${i};`).join(
      "\n",
    );
    file.prepareCodeViewItem({ name: "big.ts", contents }, 0);

    const window = virtualizer.getWindowSpecs();
    expect(window.bottom - window.top).toBe(
      viewport.height + 2 * SOURCE_PREVIEW_VIRTUALIZER_CONFIG.overscrollSize,
    );
    let inWindow = 0;
    for (let line = 1; line <= lineCount; line += 1) {
      const position = file.getLinePosition(line)!;
      if (position.top + position.height > window.top && position.top < window.bottom)
        inWindow += 1;
    }
    const lineHeight = file.getLinePosition(1)!.height;
    expect(inWindow).toBeLessThanOrEqual(Math.ceil((window.bottom - window.top) / lineHeight) + 1);
    expect(inWindow).toBeLessThan(lineCount / 100);
    file.cleanUp();
  });
});
