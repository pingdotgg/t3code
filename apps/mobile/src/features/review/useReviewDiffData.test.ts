import { describe, expect, it, vi } from "vite-plus/test";
import type { ReviewDiffPreviewSource } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { createReviewParsedFilePatchAtom } from "./useReviewDiffData";

vi.mock("./nativeReviewDiffAdapter", () => ({ getCachedNativeReviewDiffData: vi.fn() }));
vi.mock("./reviewState", () => ({ getCachedReviewParsedDiff: vi.fn() }));
vi.mock("../../state/review", () => ({ reviewEnvironment: { diffFilePatch: vi.fn() } }));

const source: ReviewDiffPreviewSource = {
  id: "branch-range",
  kind: "branch-range",
  title: "Changes",
  diff: "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-before\n+after\n",
  diffHash: "original",
  truncated: false,
  files: [{ path: "example.ts", previousPath: null, additions: 1, deletions: 1 }],
  baseRef: "HEAD",
  headRef: null,
};

describe("createReviewParsedFilePatchAtom", () => {
  it("reuses parsed bodies through refreshing, offline failure and recovery while updating metadata", () => {
    const registry = AtomRegistry.make();
    const query = Atom.make<AsyncResult.AsyncResult<ReviewDiffPreviewSource, unknown>>(
      AsyncResult.initial(),
    );
    const parsed = createReviewParsedFilePatchAtom(query);
    const unmount = registry.mount(parsed);

    try {
      expect(registry.get(parsed)._tag).toBe("Initial");
      const answered = AsyncResult.success(source);
      registry.set(query, answered);
      const first = AsyncResult.getOrThrow(registry.get(parsed));
      expect(first.parsed.kind).toBe("files");

      registry.set(query, AsyncResult.waiting(answered));
      expect(registry.get(parsed).waiting).toBe(true);
      expect(AsyncResult.getOrThrow(registry.get(parsed)).parsed).toBe(first.parsed);

      const failed = AsyncResult.failWithPrevious("offline", { previous: Option.some(answered) });
      registry.set(query, failed);
      expect(registry.get(parsed)._tag).toBe("Failure");
      expect(AsyncResult.getOrThrow(registry.get(parsed)).parsed).toBe(first.parsed);

      registry.set(query, AsyncResult.waiting(failed));
      expect(registry.get(parsed).waiting).toBe(true);
      expect(AsyncResult.getOrThrow(registry.get(parsed)).parsed).toBe(first.parsed);

      const current = {
        ...source,
        truncated: true,
        files: [{ path: "renamed.ts", previousPath: "example.ts", additions: 2, deletions: 3 }],
      };
      registry.set(query, AsyncResult.success(current));
      const recovered = AsyncResult.getOrThrow(registry.get(parsed));
      expect(registry.get(parsed)).toMatchObject({ _tag: "Success", waiting: false });
      expect(recovered.source).toBe(current);
      expect(recovered.parsed).toBe(first.parsed);
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("reparses changed text or cache scope and keeps query lifetimes isolated", () => {
    const registry = AtomRegistry.make();
    const query = Atom.make<AsyncResult.AsyncResult<ReviewDiffPreviewSource, unknown>>(
      AsyncResult.success(source),
    );
    const parsed = createReviewParsedFilePatchAtom(query);
    const unmount = registry.mount(parsed);

    try {
      const first = AsyncResult.getOrThrow(registry.get(parsed)).parsed;
      registry.set(query, AsyncResult.success({ ...source, diffHash: "changed-scope" }));
      const scoped = AsyncResult.getOrThrow(registry.get(parsed)).parsed;
      expect(scoped).not.toBe(first);
      if (scoped.kind !== "files" || first.kind !== "files") throw new Error("Expected file diffs");
      expect(scoped.files[0]?.id).not.toBe(first.files[0]?.id);

      registry.set(
        query,
        AsyncResult.success({
          ...source,
          diffHash: "changed-scope",
          diff: source.diff.replace("+after", "+updated"),
        }),
      );
      const updated = AsyncResult.getOrThrow(registry.get(parsed)).parsed;
      expect(updated).not.toBe(scoped);
      expect(updated.kind === "files" && updated.files[0]?.additionLines).toEqual(["updated\n"]);

      let otherSource = source;
      const otherQuery = Atom.make(() => AsyncResult.success(otherSource));
      const otherParsed = createReviewParsedFilePatchAtom(otherQuery);
      expect(AsyncResult.getOrThrow(registry.get(otherParsed)).parsed).toEqual(first);
      expect(AsyncResult.getOrThrow(registry.get(otherParsed)).parsed).not.toBe(first);

      otherSource = { ...source, diffHash: "other-query" };
      registry.refresh(otherParsed);
      expect(AsyncResult.getOrThrow(registry.get(otherParsed)).source).toBe(otherSource);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});
