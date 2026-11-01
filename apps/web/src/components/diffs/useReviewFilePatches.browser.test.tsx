import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type ReviewDiffPreviewSource } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { resolveFileDiffPath } from "~/lib/diffRendering";

const mocks = vi.hoisted(() => ({ requests: [] as string[], parses: [] as string[] }));

const patchQuery = await vi.hoisted(async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return Atom.family((path: string) =>
    Atom.writable(
      (get) => {
        mocks.requests.push(path);
        return AsyncResult.waitingFrom(
          get.self<AsyncResult.AsyncResult<ReviewDiffPreviewSource>>(),
        );
      },
      (get, value: AsyncResult.AsyncResult<ReviewDiffPreviewSource>) => get.setSelf(value),
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
  h.latest().requestFile(4);
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
