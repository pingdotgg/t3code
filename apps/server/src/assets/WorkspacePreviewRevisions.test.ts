import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as WorkspacePreviewRevisions from "./WorkspacePreviewRevisions.ts";

const layerTest = WorkspacePreviewRevisions.layer.pipe(Layer.provide(NodeServices.layer));

it.effect("falls back to workspace refreshes when a preview has too many dependencies", () =>
  Effect.gen(function* () {
    const revisions = yield* WorkspacePreviewRevisions.WorkspacePreviewRevisions;
    const input = {
      workspaceRoot: "/missing-preview-workspace",
      baseRelativePath: ".",
      fileRevision: "entry",
    };
    const original = yield* revisions.revision(input);
    for (let index = 0; index < 256; index++) {
      yield* revisions.observe({ ...input, relativePath: `asset-${index}.css` });
    }
    expect(yield* revisions.revision(input)).toBe(original);
    yield* revisions.observe({ ...input, relativePath: "overflow.css" });
    expect(yield* revisions.revision(input)).toBeUndefined();
    expect(yield* revisions.revision({ ...input, baseRelativePath: "another-preview" })).toEqual(
      expect.any(String),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reloads a preview whose dependency metadata has been evicted", () =>
  Effect.gen(function* () {
    const revisions = yield* WorkspacePreviewRevisions.WorkspacePreviewRevisions;
    const input = {
      workspaceRoot: "/missing-preview-workspace",
      baseRelativePath: ".",
      fileRevision: "entry",
    };
    const original = yield* revisions.revision(input);
    for (let index = 0; index < 64; index++) {
      yield* revisions.revision({ ...input, baseRelativePath: `preview-${index}` });
    }
    expect(yield* revisions.revision(input)).not.toBe(original);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("bounds dependency metadata when asset requests overlap", () =>
  Effect.gen(function* () {
    const revisions = yield* WorkspacePreviewRevisions.WorkspacePreviewRevisions;
    const input = {
      workspaceRoot: "/missing-preview-workspace",
      baseRelativePath: ".",
      fileRevision: "entry",
    };
    yield* Effect.forEach(
      Array.from({ length: 257 }, (_, index) => `asset-${index}.css`),
      (relativePath) => revisions.observe({ ...input, relativePath }),
      { concurrency: "unbounded", discard: true },
    );
    expect(yield* revisions.revision(input)).toBeUndefined();
  }).pipe(Effect.provide(layerTest)),
);
