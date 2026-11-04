import { RegistryContext } from "@effect/atom-react";
import type { ReviewDiffPreviewSource } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";

type PatchAtom = Atom.Writable<AsyncResult.AsyncResult<ReviewDiffPreviewSource, Error>>;
const state = vi.hoisted(() => ({ patches: new Map<string, PatchAtom>() }));
vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    diffFilePatch: (target: {
      input: { cacheKey: string; request: { file: { path: string } } };
    }) => {
      const key = JSON.stringify([target.input.cacheKey, target.input.request.file.path]);
      let atom = state.patches.get(key);
      if (!atom) {
        atom = Atom.make<AsyncResult.AsyncResult<ReviewDiffPreviewSource, Error>>(
          AsyncResult.initial(),
        );
        state.patches.set(key, atom);
      }
      return atom;
    },
  },
}));

import { useReviewFilePatches } from "./useReviewFilePatches";

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
  state.patches.clear();
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
  const atom = [...state.patches].find(([key]) => JSON.parse(key)[1] === "f.txt")![1];
  const loaded = AsyncResult.success({
    ...tracked,
    diff: "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-old\n+new\n",
    files: tracked.files!.filter((f) => f.path === "f.txt"),
  });
  act(() => registry.set(atom, loaded));
  await expect.element(screen.getByText("f.txt:loaded")).toBeVisible();
  const automatic = [...state.patches].find(([key]) => JSON.parse(key)[1] === "e.txt")![1];
  act(() =>
    registry.set(
      automatic,
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
  state.patches.clear();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const metadata = source(["entry"], "type-change");
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <Probe source={metadata} />
    </RegistryContext.Provider>,
  );
  const atom = [...state.patches.values()][0]!;
  act(() =>
    registry.set(
      atom,
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
