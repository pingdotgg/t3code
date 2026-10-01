import { FileDiff, type CodeViewItem, type CodeViewScrollTarget } from "@pierre/diffs";
import type { CodeViewProps } from "@pierre/diffs/react";
import type { AuthoredExtension } from "@t3tools/extension-sdk/authoring";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
// The pack's fixture is outside the web TypeScript project.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as React from "react";
import { useImperativeHandle, type ReactNode, type Ref } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const view = vi.hoisted(() => ({
  props: undefined as CodeViewProps<undefined> | undefined,
  scrolls: [] as CodeViewScrollTarget[],
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useSettings", () => ({ useClientSettings: () => false }));
vi.mock("~/components/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@pierre/diffs/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pierre/diffs/react")>()),
  CodeView: (props: CodeViewProps<undefined> & { ref?: Ref<unknown> }) => {
    view.props = props;
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
        {props.renderHeaderFilenameSuffix?.(item as CodeViewItem<undefined>)}
        {props.renderHeaderPrefix?.(item as CodeViewItem<undefined>)}
      </header>
    ));
  },
}));

import { HostCodeDiff } from "./HostCodeViewRenderers";

const PACK = new URL("../../../../../packages/first-party-extensions/diff/", import.meta.url)
  .pathname;
const PATCH = NodeFS.readFileSync(`${PACK}/fixtures/path-identity.patch`, "utf8");
const PATHS = ["top.txt", "a/top.txt", "b/top.txt", "a/日本語 space.txt"];
const contents = (path: string, side: "old" | "new") =>
  `first ${path}\ncontext ${path}\n${side} ${path}\nlast ${path}\n`;

let extension: AuthoredExtension;
beforeAll(async () => {
  ({ default: extension } = await import(/* @vite-ignore */ `${PACK}/extension.tsx`));
});

// Exercise Pierre's real gap expansion and hydration without mounting its DOM or highlighter.
class ContextDiff extends FileDiff {
  override rerender() {}
  override async primeHighlightCache() {}
  loaded() {
    return this.pendingFiles?.promise;
  }
}

let renderer: ReactTestRenderer | undefined;
let controller: AbortController | undefined;
afterEach(async () => {
  controller?.abort();
  await act(async () => renderer?.unmount());
  renderer = undefined;
  view.props = undefined;
  view.scrolls = [];
  vi.unstubAllGlobals();
});

async function mountPack() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const clipboard = vi.fn(async (_text: string) => {});
  vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
  const reads: { oldPath: string; newPath: string }[] = [];
  const opens: string[] = [];
  const host = {
    React,
    codeView: { version: 1, Diff: HostCodeDiff, File: () => null },
    discoverApis: async () => [{ id: "t3.ui/navigation", version: "1.1.0" }],
    invokeApi: async (request: { id: string; method: string; input: unknown }) => {
      switch (`${request.id}#${request.method}`) {
        case "t3.vcs/repository#getCapabilities":
          return {
            detected: true,
            kind: "git",
            detail: null,
            driver: null,
            operations: { "diff.getPreview": true },
          };
        case "t3.vcs/diff#getPreview":
          return {
            generatedAt: "2026-10-01T00:00:00Z",
            sources: [
              {
                id: "working-tree",
                kind: "working-tree",
                title: "Working tree",
                baseRef: null,
                headRef: null,
                diff: PATCH,
                diffHash: "path-identity",
                truncated: false,
              },
            ],
          };
        case "t3.vcs/diff#getFileContents": {
          const input = request.input as { oldPath: string; newPath: string };
          reads.push(input);
          return {
            oldContents: contents(input.oldPath, "old"),
            newContents: contents(input.newPath, "new"),
          };
        }
        case "t3.vcs/refs#list":
          return {
            refs: [],
            isRepo: true,
            hasPrimaryRemote: false,
            nextCursor: null,
            totalCount: 0,
          };
        case "t3.ui/theme#getTokens":
          return { tokens: null };
        case "t3.ui/panels#getCapabilities":
          return { operations: {} };
        case "t3.ui/navigation#openFile": {
          const { relativePath } = request.input as { relativePath: string };
          opens.push(relativePath);
          return { status: "opened" };
        }
        default:
          throw new Error(`Unexpected ${request.id}#${request.method}`);
      }
    },
    subscribeApi: (_request: unknown, signal: AbortSignal) =>
      (async function* () {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        yield* [];
      })(),
  } as unknown as ClientHost;
  controller = new AbortController();
  const session: ViewSession = {
    context: {
      client: "web",
      resource: {
        namespace: "t3.threads",
        id: "thread",
        environmentId: "env",
        projectId: "project",
        threadId: "thread",
      },
    },
    signal: controller.signal,
    restoring: false,
    visible: true,
    onVisibility: () => () => {},
    restoreState: null,
    publish: () => true,
    save: () => true,
    invoke: async () => null,
    bindCommands: () => "binding",
    setTabIndicators: () => true,
    onDispose: () => {},
  };
  const surface = extension.client!(host).surfaces![0]!;
  const { renderer: Panel } = await surface.createView(session);
  await act(async () => {
    renderer = create(
      <Panel
        snapshot={{
          id: "diff-view",
          record: {
            version: 1,
            surfaceId: surface.id,
            context: session.context,
            placement: "side-panel",
            stateVersion: 1,
            restoreState: null,
            fallback: "Diff",
          },
          status: "ready",
          reason: null,
          state: null,
          generation: 1,
        }}
      />,
    );
  });
  expect(items()).toHaveLength(PATHS.length);
  return { clipboard, reads, opens };
}

const items = () =>
  (view.props?.items ?? []).flatMap((item) => (item.type === "diff" ? [item] : []));
const header = (index: number) =>
  renderer!.root.findAll((node) => node.type === "header" && node.props["data-item"] !== undefined)[
    index
  ]!;
const click = async (button: ReactTestInstance) => {
  await act(async () => button.props.onClick({ stopPropagation() {} }));
};

describe("Default Diff pack through the host renderer", () => {
  const cases = PATHS.map((path, index) => ({ path, index }));

  it.each(cases)(
    "expands the gap for $path with its own full contents",
    async ({ path, index }) => {
      const { reads } = await mountPack();
      const diff = new ContextDiff({
        loadDiffFiles: view.props!.options!.loadDiffFiles!,
        disableErrorHandling: true,
      });
      diff.fileDiff = items()[index]!.fileDiff;
      try {
        expect(diff.fileDiff.isPartial).toBe(true);
        diff.expandHunk(0, "up");
        await diff.loaded();
        expect(reads).toMatchObject([{ oldPath: path, newPath: path }]);
        expect(diff.fileDiff.isPartial).toBe(false);
        expect(diff.fileDiff.additionLines).toContain(`first ${path}\n`);
        expect(diff.fileDiff.additionLines).toContain(`last ${path}\n`);
      } finally {
        diff.cleanUp();
      }
    },
  );

  it.each(cases)("collapses and expands only $path", async ({ path, index }) => {
    await mountPack();
    expect(new Set(items().map((item) => item.id)).size).toBe(PATHS.length);
    await click(header(index).findByProps({ "aria-label": `Collapse ${path}` }));
    expect(items().map((item) => item.collapsed)).toEqual(PATHS.map((_, i) => i === index));
    await click(header(index).findByProps({ "aria-label": `Expand ${path}` }));
    expect(items().every((item) => !item.collapsed)).toBe(true);
  });

  it.each(cases)("copies the exact path $path", async ({ path, index }) => {
    const { clipboard } = await mountPack();
    await click(
      header(index)
        .findAllByType("button")
        .find((button) => button.props.children === "Copy path")!,
    );
    expect(clipboard).toHaveBeenCalledExactlyOnceWith(path);
  });

  it.each(cases)("opens the exact file $path", async ({ path, index }) => {
    const { opens } = await mountPack();
    await click(
      header(index)
        .findAllByType("button")
        .find((button) => button.props.children === "Open")!,
    );
    expect(opens).toEqual([path]);
  });

  it.each(cases)("reveals $path by its distinct viewer identity", async ({ path, index }) => {
    await mountPack();
    const target = items()[index]!.id;
    const treePaths = ["a/top.txt", "a/日本語 space.txt", "b/top.txt", "top.txt"];
    const tree = renderer!.root.findByProps({ "aria-label": "Changed files" });
    const buttons = tree.findAll((node) => node.type === "button" && "aria-current" in node.props);
    await click(buttons[treePaths.indexOf(path)]!);
    expect(view.scrolls).toEqual([{ type: "item", id: target, align: "start" }]);
  });
});
