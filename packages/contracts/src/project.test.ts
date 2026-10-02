import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId } from "./baseSchemas.ts";
import { OrchestrationProjectShell } from "./orchestrationProject.ts";

import {
  ProjectFaviconPath,
  ProjectIconOverride,
  ProjectReadFileError,
  ProjectCreatePayload,
  ProjectUpdatePayload,
  ProjectMutation,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectWriteFileError,
} from "./project.ts";

const decodeProjectCreatePayload = Schema.decodeUnknownSync(ProjectCreatePayload);
const decodeProjectUpdatePayload = Schema.decodeUnknownSync(ProjectUpdatePayload);
const decodeProjectMutation = Schema.decodeUnknownSync(ProjectMutation);
const decodeSearchEntriesInput = Schema.decodeUnknownSync(ProjectSearchEntriesInput);
const decodeSearchContentsInput = Schema.decodeUnknownSync(ProjectSearchContentsInput);

describe("project search inputs", () => {
  it("allows an empty entries query for bounded frecency browsing", () => {
    const decoded = decodeSearchEntriesInput({
      cwd: "/workspace",
      query: "   ",
      limit: 10,
      kind: "file",
    });
    expect(decoded.query).toBe("");
  });

  it("preserves whitespace in content search queries", () => {
    const decoded = decodeSearchContentsInput({
      cwd: "/workspace",
      query: " foo ",
      limit: 10,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    expect(decoded.query).toBe(" foo ");
  });
});

describe("project RPC errors", () => {
  it("derives stable messages from structured request context while retaining causes", () => {
    const cause = new Error("sensitive platform detail");
    const searchError = new ProjectSearchEntriesError({
      cwd: "/workspace",
      queryLength: "authorization: Bearer secret-token".length,
      limit: 20,
      failure: "search_index_search_failed",
      normalizedCwd: "/workspace",
      detail: "index unavailable",
      cause,
    });
    const readError = new ProjectReadFileError({
      cwd: "/workspace",
      relativePath: "src/index.ts",
      failure: "operation_failed",
      operation: "read",
      operationPath: "/workspace/src/index.ts",
      resolvedPath: "/workspace/src/index.ts",
      cause,
    });

    expect(searchError.message).toBe("Failed to search workspace entries in '/workspace'.");
    expect(searchError.message).not.toContain(cause.message);
    expect(searchError.normalizedCwd).toBe("/workspace");
    expect(searchError.queryLength).toBe("authorization: Bearer secret-token".length);
    expect(searchError).not.toHaveProperty("query");
    expect(searchError.message).not.toMatch(/Bearer|secret-token/);
    expect(searchError.cause).toBe(cause);
    expect(readError.message).toBe("Failed to read workspace file 'src/index.ts' in '/workspace'.");
    expect(readError.message).not.toContain(cause.message);
    expect(readError.cause).toBe(cause);

    const contentSearchError = new ProjectSearchContentsError({
      cwd: "/workspace",
      queryLength: "authorization: Bearer secret-token".length,
      limit: 100,
      failure: "search_index_search_failed",
      cause,
    });
    expect(contentSearchError.message).toBe("Failed to search workspace contents in '/workspace'.");
    expect(contentSearchError.message).not.toContain(cause.message);
    expect(contentSearchError).not.toHaveProperty("query");
    expect(contentSearchError.cause).toBe(cause);
  });

  it("decodes legacy message-only errors during rolling upgrades", () => {
    const decodeSearchError = Schema.decodeUnknownSync(ProjectSearchEntriesError);
    const decodeWriteError = Schema.decodeUnknownSync(ProjectWriteFileError);

    const searchError = decodeSearchError({
      _tag: "ProjectSearchEntriesError",
      message: "Legacy project search failure.",
      query: "legacy sensitive query",
    });
    const writeError = decodeWriteError({
      _tag: "ProjectWriteFileError",
      message: "Legacy project write failure.",
    });

    expect(searchError.message).toBe("Legacy project search failure.");
    expect(searchError.cwd).toBeUndefined();
    expect(searchError.queryLength).toBeUndefined();
    expect(searchError).not.toHaveProperty("query");
    expect(searchError.failure).toBeUndefined();
    expect(writeError.message).toBe("Legacy project write failure.");
    expect(writeError.relativePath).toBeUndefined();
    expect(writeError.failure).toBeUndefined();
  });
});

describe("shared project payloads", () => {
  it("preserves omitted, false, and null values through RPC envelopes", () => {
    const create = decodeProjectCreatePayload({
      title: " Example ",
      workspaceRoot: "/workspace",
      createWorkspaceRootIfMissing: false,
    });
    const update = decodeProjectUpdatePayload({
      autoPull: false,
      defaultModelSelection: null,
      faviconPath: null,
    });
    const envelope = { commandId: "command", projectId: "project" };
    expect(decodeProjectMutation({ type: "project.create", ...envelope, ...create })).toEqual({
      type: "project.create",
      ...envelope,
      title: "Example",
      workspaceRoot: "/workspace",
      createWorkspaceRootIfMissing: false,
    });
    expect(decodeProjectMutation({ type: "project.update", ...envelope, ...update })).toEqual({
      type: "project.update",
      ...envelope,
      autoPull: false,
      defaultModelSelection: null,
      faviconPath: null,
    });
    expect(Object.hasOwn(create, "scripts")).toBe(false);
    expect(Object.hasOwn(update, "title")).toBe(false);
    // Internal RPC callers may explicitly supply undefined, as before the extraction.
    expect(
      decodeProjectMutation({ type: "project.update", ...envelope, title: undefined }),
    ).toHaveProperty("title", undefined);
  });
});

const decodeFaviconPath = Schema.decodeUnknownEffect(ProjectFaviconPath);

effectIt.effect("project favicon paths accept only supported image files", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* decodeFaviconPath("brand/icon.svg"), "brand/icon.svg");
    assert.strictEqual((yield* Effect.exit(decodeFaviconPath(".env")))._tag, "Failure");
  }),
);

const decodeProjectUpdateEffect = Schema.decodeUnknownEffect(ProjectUpdatePayload);
const decodeUpdateIcon = (projectIcon: unknown) =>
  Effect.map(decodeProjectUpdateEffect({ projectIcon }), (update) => update.projectIcon);

effectIt.effect("project icon overrides accept Lucide icons, colors, and emoji", () =>
  Effect.gen(function* () {
    const lucide = { kind: "lucide", name: "alarm-clock", color: "violet" } as const;
    assert.deepEqual(yield* decodeUpdateIcon(lucide), lucide);
    const emoji = { kind: "emoji", emoji: "👩🏽‍💻" } as const;
    assert.deepEqual(yield* decodeUpdateIcon(emoji), emoji);
    const invalid = yield* Effect.exit(
      decodeUpdateIcon({ kind: "lucide", name: "Alarm Clock", color: "ultraviolet" }),
    );
    assert.strictEqual(invalid._tag, "Failure");
  }),
);

effectIt.effect("project monograms validate text and palette colors", () =>
  Effect.gen(function* () {
    for (const text of ["A", "T3", "É", "文書", "कि", "किखि", "e\u0301"]) {
      assert.deepEqual(yield* decodeUpdateIcon({ kind: "monogram", color: "violet", text }), {
        kind: "monogram",
        text,
        color: "violet",
      });
    }
    for (const projectIcon of [
      { kind: "monogram", text: "", color: "blue" },
      { kind: "monogram", text: "\u0301", color: "blue" },
      { kind: "monogram", text: "A B", color: "blue" },
      { kind: "monogram", text: "🚀", color: "blue" },
      { kind: "monogram", text: "T3", color: "ultraviolet" },
    ]) {
      assert.strictEqual((yield* Effect.exit(decodeUpdateIcon(projectIcon)))._tag, "Failure");
    }
  }),
);

const decodeProjectIcon = Schema.decodeUnknownEffect(ProjectIconOverride);
const encodeProjectIcon = Schema.encodeEffect(ProjectIconOverride);

// Pre-monogram clients reject unknown variants; nightly clients additionally validate monogram.
const decodeOldIcon = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("lucide"), name: Schema.String, color: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("emoji"), emoji: Schema.String }),
  ]),
);
const decodeNightlyIcon = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("lucide"),
      name: Schema.String,
      color: Schema.String,
      // Fail if this field is ever sent; old validators must never see the new text.
      monogram: Schema.optional(Schema.Never),
    }),
    Schema.Struct({ kind: Schema.Literal("emoji"), emoji: Schema.String }),
  ]),
);

effectIt.effect("sends monograms as fallback icons that old and nightly clients can decode", () =>
  Effect.gen(function* () {
    const fallback = { kind: "lucide", name: "folder-code", color: "violet" } as const;
    for (const text of ["T3", "क्ष्म", "e\u0301"]) {
      const monogram = { kind: "monogram", text, color: "violet" } as const;
      const wire = yield* encodeProjectIcon(monogram);
      assert.deepEqual(wire, { ...fallback, monogramText: text });
      assert.deepEqual(yield* decodeOldIcon(wire), fallback);
      assert.deepEqual(yield* decodeNightlyIcon(wire), fallback);
      assert.deepEqual(yield* decodeProjectIcon(wire), monogram);
      assert.deepEqual(yield* decodeProjectIcon(monogram), monogram);
      assert.deepEqual(yield* decodeProjectIcon({ ...fallback, monogram: text }), monogram);
    }
    for (const icon of [
      { kind: "lucide", name: "alarm-clock", color: "blue" },
      { kind: "emoji", emoji: "🚀" },
    ] as const) {
      assert.deepEqual(yield* decodeProjectIcon(icon), icon);
      assert.deepEqual(yield* encodeProjectIcon(icon), icon);
    }
  }),
);

const encodeProjectShell = Schema.encodeEffect(OrchestrationProjectShell);
const encodeProjectUpdate = Schema.encodeEffect(ProjectUpdatePayload);
const decodeLegacyShell = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...OrchestrationProjectShell.fields,
    projectIcon: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          kind: Schema.Literal("lucide"),
          name: Schema.String,
          color: Schema.String,
        }),
      ),
    ),
  }),
);

effectIt.effect("encodes compatible icons inside snapshots and project updates", () =>
  Effect.gen(function* () {
    const projectIcon = { kind: "monogram", text: "क्ष्म", color: "violet" } as const;
    const shell = yield* encodeProjectShell({
      id: ProjectId.make("monogram"),
      title: "Monogram",
      workspaceRoot: "/tmp/monogram",
      defaultModelSelection: null,
      scripts: [],
      projectIcon,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const fallback = { kind: "lucide", name: "folder-code", color: "violet" } as const;
    assert.deepEqual((yield* decodeLegacyShell(shell)).projectIcon, fallback);
    const update = yield* encodeProjectUpdate({ projectIcon });
    assert.deepEqual(yield* decodeNightlyIcon(update.projectIcon), fallback);
  }),
);
