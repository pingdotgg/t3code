import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type ReviewDiffPreviewSource } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { resolveFileDiffPath } from "~/lib/diffRendering";

const mocks = vi.hoisted(() => ({ requests: [] as string[], parses: [] as string[] }));

const patchQuery = await vi.hoisted(async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return Atom.family((path: string) =>
    Atom.writable(
      (get) => {
        mocks.requests.push(path);
        return AsyncResult.waitingFrom(
          get.self<AsyncResult.AsyncResult<ReviewDiffPreviewSource, Error>>(),
        );
      },
      (get, value: AsyncResult.AsyncResult<ReviewDiffPreviewSource, Error>) => get.setSelf(value),
    ).pipe(Atom.setIdleTTL(5 * 60_000)),
  );
});

vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    diffFilePatch: (target: { input: { request: { file: { path: string } } } }) =>
      patchQuery(target.input.request.file.path),
  },
}));

vi.mock("./parsePatchOffMainThread", async () => {
  const { getRenderablePatch } = await import("~/lib/diffRendering");
  return {
    parsePatchOffMainThread: async (patch: string, scope: string) => {
      mocks.parses.push(patch);
      return getRenderablePatch(patch, scope, { compactPartialHunkOffsets: true });
    },
  };
});

import { useReviewFilePatches } from "./useReviewFilePatches";

function previewSource(paths: string[]): ReviewDiffPreviewSource {
  return {
    id: "working-tree",
    kind: "working-tree",
    title: "Uncommitted",
    baseRef: null,
    headRef: null,
    diff: "preview",
    diffHash: "hash",
    truncated: true,
    files: paths.map((path) => ({ path, previousPath: null, additions: 1, deletions: 0 })),
  };
}

type HookResult = ReturnType<typeof useReviewFilePatches>;

function Harness(props: {
  source: ReviewDiffPreviewSource;
  onResult: (result: HookResult) => void;
}) {
  const result = useReviewFilePatches({
    environmentId: EnvironmentId.make("test"),
    cwd: "/repo",
    source: props.source,
    baseRef: null,
    ignoreWhitespace: false,
    theme: "dark",
    previewInput: { cwd: "/repo" },
    preview: null,
  });
  props.onResult(result);
  return (
    <ul>
      {result.renderableFiles.map((file) => (
        <li key={resolveFileDiffPath(file)}>
          {resolveFileDiffPath(file)} {file.additionLines.join(",") || "pending"}
        </li>
      ))}
    </ul>
  );
}

function setup(paths = ["a.ts"]) {
  mocks.requests = [];
  mocks.parses = [];
  const registry = AtomRegistry.make();
  const source = previewSource(paths);
  const results: HookResult[] = [];
  return {
    ui: () => (
      <RegistryContext.Provider value={registry}>
        <Harness source={source} onResult={(result) => results.push(result)} />
      </RegistryContext.Provider>
    ),
    latest: () => results.at(-1)!,
    refresh: (path: string) => registry.refresh(patchQuery(path)),
    requestsFor: (path: string) => mocks.requests.filter((request) => request === path).length,
    complete(path: string, contents: string) {
      registry.set(
        patchQuery(path),
        AsyncResult.success({
          ...source,
          diff: `diff --git a/${path} b/${path}
new file mode 100644
--- /dev/null
+++ b/${path}
@@ -0,0 +1 @@
+${contents}
`,
          truncated: false,
        }),
      );
    },
  };
}

it("reopening keeps the parse while source queries revalidate", async () => {
  const h = setup();
  {
    await using screen = await render(h.ui());
    h.complete("a.ts", "first");
    await expect.element(screen.getByText("a.ts first")).toBeInTheDocument();
  }
  const parsed = h.latest().renderableFiles[0];
  await using screen = await render(h.ui());
  expect(h.latest().renderableFiles[0]).toBe(parsed);
  expect(mocks.requests).toEqual(["a.ts"]);

  h.refresh("a.ts");
  expect(mocks.requests).toEqual(["a.ts", "a.ts"]);
  await vi.waitFor(() => expect(h.latest().isPending).toBe(true));
  expect(h.latest().renderableFiles[0]).toBe(parsed);
  h.complete("a.ts", "first");
  await vi.waitFor(() => expect(h.latest().isPending).toBe(false));
  expect(h.latest().renderableFiles[0]).toBe(parsed);
  expect(mocks.parses).toHaveLength(1);

  h.refresh("a.ts");
  h.complete("a.ts", "changed");
  await expect.element(screen.getByText("a.ts changed")).toBeInTheDocument();
  expect(mocks.parses).toHaveLength(2);
});

it("keeps a later file's parse while its source query refreshes", async () => {
  const h = setup(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  await using screen = await render(h.ui());
  h.latest().requestFile("e.ts");
  await vi.waitFor(() => expect(h.requestsFor("e.ts")).toBe(1));
  h.complete("e.ts", "first");
  await expect.element(screen.getByText("e.ts first")).toBeInTheDocument();
  const parsed = h.latest().renderableFiles[4];

  h.refresh("e.ts");
  await vi.waitFor(() => expect(h.requestsFor("e.ts")).toBe(2));
  expect(h.latest().renderableFiles[4]).toBe(parsed);
  h.complete("e.ts", "changed");
  await expect.element(screen.getByText("e.ts changed")).toBeInTheDocument();
  expect(h.latest().renderableFiles[4]).not.toBe(parsed);
});

function source(paths: string[], hash: string): ReviewDiffPreviewSource {
  return {
    id: "working-tree",
    kind: "working-tree",
    title: "Uncommitted",
    baseRef: "HEAD",
    headRef: null,
    diff: "",
    diffHash: hash,
    truncated: false,
    patchesDeferred: true,
    files: paths.map((path) => ({ path, previousPath: null, additions: 1, deletions: 1 })),
  };
}

function Probe({ source }: { source: ReviewDiffPreviewSource }) {
  const files = useReviewFilePatches({
    environmentId: EnvironmentId.make("environment"),
    cwd: "/project",
    source,
    baseRef: "HEAD",
    ignoreWhitespace: false,
    theme: "dark",
    previewInput: { cwd: "/project", metadataOnly: true },
    preview: null,
  });
  return (
    <>
      <button onClick={() => files.requestFile("f.txt")}>Open f</button>
      <output>Pending files: {files.remainingFileCount}</output>
      {files.renderableFiles.map((file) => (
        <div key={`${file.name}:${file.type}`}>
          <span>
            {file.name}:{file.hunks.length ? "loaded" : "pending"}
          </span>
          <span>{file.type}</span>
        </div>
      ))}
    </>
  );
}

it("retains automatic and explicitly opened files through metadata insertion, refresh failure and retry", async () => {
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const tracked = source(["b.txt", "c.txt", "d.txt", "e.txt", "f.txt"], "tracked");
  const view = (source: ReviewDiffPreviewSource) => (
    <RegistryContext.Provider value={registry}>
      <Probe source={source} />
    </RegistryContext.Provider>
  );
  await using screen = await render(view(tracked));
  await userEvent.click(screen.getByRole("button", { name: "Open f" }));
  const atom = patchQuery("f.txt");
  const loaded = AsyncResult.success({
    ...tracked,
    diff: "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-old\n+new\n",
    files: tracked.files!.filter((f) => f.path === "f.txt"),
  });
  act(() => registry.set(atom, loaded));
  await expect.element(screen.getByText("f.txt:loaded")).toBeVisible();
  act(() =>
    registry.set(
      patchQuery("e.txt"),
      AsyncResult.success({
        ...loaded.value,
        diff: loaded.value.diff.replaceAll("f.txt", "e.txt"),
        files: tracked.files!.filter((file) => file.path === "e.txt"),
      }),
    ),
  );
  await expect.element(screen.getByText("e.txt:loaded")).toBeVisible();
  await screen.rerender(
    view(source(["a-new.txt", ...tracked.files!.map((f) => f.path)], "complete")),
  );
  await expect.element(screen.getByText("e.txt:loaded")).toBeVisible();
  await expect.element(screen.getByText("f.txt:loaded")).toBeVisible();
  act(() =>
    registry.set(
      atom,
      AsyncResult.fail(new Error("refresh failed"), { previousSuccess: Option.some(loaded) }),
    ),
  );
  await expect.element(screen.getByText("f.txt:loaded")).toBeVisible();
  act(() => registry.set(atom, loaded));
  await expect.element(screen.getByText("f.txt:loaded")).toBeVisible();
});

it("preserves deletion and addition patches for a file replaced by a symlink", async () => {
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const metadata = source(["entry"], "type-change");
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <Probe source={metadata} />
    </RegistryContext.Provider>,
  );
  act(() =>
    registry.set(
      patchQuery("entry"),
      AsyncResult.success({
        ...metadata,
        diff: "diff --git a/entry b/entry\ndeleted file mode 100644\n--- a/entry\n+++ /dev/null\n@@ -1 +0,0 @@\n-before\ndiff --git a/entry b/entry\nnew file mode 120000\n--- /dev/null\n+++ b/entry\n@@ -0,0 +1 @@\n+target\n\\ No newline at end of file\n",
      }),
    ),
  );
  await expect.element(screen.getByText("deleted", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("new", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Pending files: 0")).toBeVisible();
});
