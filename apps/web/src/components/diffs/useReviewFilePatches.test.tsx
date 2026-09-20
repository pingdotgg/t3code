import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type ReviewDiffPreviewSource } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { reviewEnvironment } from "~/state/review";
import { useReviewFilePatches } from "./useReviewFilePatches";

vi.mock("~/state/review", () => ({
  reviewEnvironment: { diffFilePatch: vi.fn() },
}));

it.each(["staged", "unstaged"] as const)(
  "loads %s files by their visible tree position",
  async (kind) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const pending = Atom.make(AsyncResult.initial());
    vi.mocked(reviewEnvironment.diffFilePatch).mockReturnValue(pending);
    const registry = AtomRegistry.make();
    const source: ReviewDiffPreviewSource = {
      id: kind,
      kind,
      title: kind,
      baseRef: null,
      headRef: null,
      diff: "",
      diffHash: "hash",
      truncated: true,
      files: ["a/z.ts", "A/b.ts", "a/a.ts", "b/a.ts", "b/b.ts", "b/c.ts"].map((path) => ({
        path,
        previousPath: null,
        additions: 1,
        deletions: 0,
      })),
    };
    let result: ReturnType<typeof useReviewFilePatches>;
    function Probe({ fileTreeOpen }: { fileTreeOpen: boolean }) {
      const value = useReviewFilePatches({
        environmentId: EnvironmentId.make("test"),
        cwd: "/repo",
        source,
        baseRef: null,
        ignoreWhitespace: false,
        theme: "dark",
        revision: "1",
        preview: null,
        fileTreeOpen,
      });
      useEffect(() => {
        result = value;
      }, [value]);
      return null;
    }
    let renderer: ReactTestRenderer | undefined;
    const render = (fileTreeOpen: boolean) => (
      <RegistryContext.Provider value={registry}>
        <Probe fileTreeOpen={fileTreeOpen} />
      </RegistryContext.Provider>
    );
    try {
      await act(async () => {
        renderer = create(render(true));
      });
      const paths = result!.renderableFiles.map((file) => file.name);
      expect(paths.indexOf("a/z.ts") - paths.indexOf("a/a.ts")).toBe(1);
      await act(async () => result!.requestFile(5));
      expect(
        vi.mocked(reviewEnvironment.diffFilePatch).mock.lastCall?.[0].input.request,
      ).toMatchObject({
        workingTreeScope: kind,
        file: { path: paths[5], sourceKind: kind },
      });
      const treeScope = result!.scope;
      await act(async () => renderer!.update(render(false)));
      expect(result!.scope).not.toBe(treeScope);
      expect(result!.renderableFiles.map((file) => file.name)).toEqual(
        source
          .files!.map((file) => file.path)
          .toSorted((a, b) =>
            a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
          ),
      );
    } finally {
      await act(async () => renderer?.unmount());
      registry.dispose();
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    }
  },
);
