import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId } from "./baseSchemas.ts";
import { OrchestrationProjectShell } from "./orchestrationProject.ts";

import {
  ProjectFaviconPath,
  ReceivedProjectIcon,
  StoredProjectIcon,
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

const decodeStoredIcon = Schema.decodeUnknownEffect(StoredProjectIcon);
const encodeStoredIcon = Schema.encodeEffect(StoredProjectIcon);
const decodeReceivedIcon = Schema.decodeUnknownEffect(ReceivedProjectIcon);
const encodeReceivedIcon = Schema.encodeEffect(ReceivedProjectIcon);
const decodeProjectShell = Schema.decodeUnknownEffect(OrchestrationProjectShell);

effectIt.effect("sends and stores icons in their plain shape", () =>
  Effect.gen(function* () {
    for (const icon of [
      { kind: "monogram", text: "क्ष्म", color: "violet" },
      { kind: "lucide", name: "alarm-clock", color: "blue" },
      { kind: "emoji", emoji: "🚀" },
    ] as const) {
      assert.deepEqual(yield* encodeReceivedIcon(icon), icon);
      assert.deepEqual(yield* encodeStoredIcon(icon), icon);
      assert.deepEqual(yield* decodeReceivedIcon(icon), icon);
    }
  }),
);

effectIt.effect("reads monograms stored in the pre-v2 fallback shape", () =>
  Effect.gen(function* () {
    const monogram = { kind: "monogram", text: "T3", color: "violet" } as const;
    const fallback = { kind: "lucide", name: "folder-code", color: "violet" } as const;
    for (const legacy of [
      { ...fallback, monogramText: "T3" },
      { ...fallback, monogram: "T3" },
    ]) {
      assert.deepEqual(yield* decodeStoredIcon(legacy), monogram);
      assert.deepEqual(yield* decodeReceivedIcon(legacy), monogram);
    }
  }),
);

effectIt.effect("an icon kind from a newer server shows the default icon", () =>
  Effect.gen(function* () {
    assert.isNull(yield* decodeReceivedIcon({ kind: "image", url: "https://example.com/a.png" }));
    const shell = yield* decodeProjectShell({
      id: "project-1",
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      projectIcon: { kind: "image", url: "https://example.com/a.png" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.isNull(shell.projectIcon);
    // A known kind with a broken payload still fails.
    const broken = yield* Effect.exit(decodeReceivedIcon({ kind: "emoji" }));
    assert.strictEqual(broken._tag, "Failure");
  }),
);
