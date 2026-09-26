// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProjectId,
  extensionWorkspaceRevision,
} from "@t3tools/contracts";
import {
  WORKSPACE_RESOURCE_CHUNK_UNITS,
  splitWorkspaceResourceChunks,
  type WorkspaceResourceReadEvent,
} from "@t3tools/extension-sdk/catalogue";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type { HostApiInvocationMetadata } from "@t3tools/extension-runtime";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { WorkspaceEntries } from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { createWorkspaceResourcesApiProvider } from "./workspaceResourcesApi.ts";

const sha256Hex = (text: string) =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const fixture = Effect.fn("workspaceResourcesApiTest.fixture")(function* () {
  const root = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-api-resources-")),
  );
  roots.push(root);
  let clock = 1_000_000;
  const provider = yield* Effect.gen(function* () {
    const paths = yield* WorkspacePaths.make;
    const workspace = yield* WorkspaceFileSystem.make.pipe(
      Effect.provideService(WorkspacePaths.WorkspacePaths, paths),
      Effect.provideService(
        WorkspaceEntries,
        WorkspaceEntries.of({
          refresh: () => Effect.void,
          browse: () => Effect.die("unused"),
          list: () => Effect.die("unused"),
          search: () => Effect.die("unused"),
          searchContents: () => Effect.die("unused"),
        }),
      ),
    );
    return createWorkspaceResourcesApiProvider({
      environmentId: "env",
      projects: {
        getById: () =>
          Effect.sync(() =>
            Option.some({
              projectId: ProjectId.make("project"),
              workspaceRoot: root,
              deletedAt: null,
            }),
          ),
      },
      threads: { getById: () => Effect.succeedNone },
      workspace,
      entries: { refresh: () => Effect.void },
      paths,
      now: () => clock,
    });
  }).pipe(Effect.provide(NodeServices.layer));
  const context: ViewContext = {
    resource: {
      namespace: "test.files",
      id: "files",
      environmentId: "env",
      projectId: "project",
    },
    workspaceRevision: extensionWorkspaceRevision(root, null),
    client: "test",
  };
  const meta = (overrides: Partial<HostApiInvocationMetadata> = {}): HostApiInvocationMetadata => ({
    callId: "call",
    rootCallerId: "root",
    callerId: "caller",
    providerId: provider.providerId,
    providerGeneration: 1,
    callerGenerations: [],
    principal: {
      kind: "environment-session",
      id: "session",
      environmentId: "env",
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    },
    assertAuthority: async () => {},
    ...overrides,
  });
  const read = async (
    input: Json,
    options: {
      readonly signal?: AbortSignal;
      readonly metadata?: HostApiInvocationMetadata;
      readonly context?: ViewContext;
    } = {},
  ): Promise<WorkspaceResourceReadEvent[]> => {
    const stream = provider.subscribe!(
      "read",
      input,
      options.context ?? context,
      options.signal ?? new AbortController().signal,
      options.metadata ?? meta(),
    );
    const events: WorkspaceResourceReadEvent[] = [];
    for await (const frame of stream) events.push(frame.value as WorkspaceResourceReadEvent);
    return events;
  };
  const call = (
    method: string,
    input: Json,
    options: {
      readonly metadata?: HostApiInvocationMetadata;
      readonly signal?: AbortSignal;
      readonly context?: ViewContext;
    } = {},
  ) =>
    provider.invoke(
      method,
      input,
      options.context ?? context,
      options.signal ?? new AbortController().signal,
      options.metadata ?? meta(),
    );
  const save = async (contents: string, expectedRevision: string) => {
    const chunks = splitWorkspaceResourceChunks(contents);
    const begin = (await call("save.begin", {
      relativePath: "doc",
      expectedRevision,
      byteLength: utf8Length(contents),
      chunkCount: chunks.length,
      sha256: sha256Hex(contents),
    })) as { kind: string; uploadId?: string; reason?: string };
    if (begin.kind !== "session") return begin;
    const uploadId = begin.uploadId!;
    for (const [chunkIndex, data] of chunks.entries()) {
      const accepted = (await call("save.chunk", { uploadId, chunkIndex, data })) as {
        kind: string;
        reason?: string;
      };
      if (accepted.kind !== "accepted") return accepted;
    }
    return (await call("save.commit", { uploadId })) as { kind: string; reason?: string };
  };
  return {
    root,
    provider,
    context,
    meta,
    read,
    call,
    save,
    advance: (ms: number) => {
      clock += ms;
    },
  };
});

describe("t3.workspace/resources adapter", () => {
  it.effect("delivers a complete multi-chunk read with a verifiable terminal digest", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        // >2 chunks: 8192-unit frames carry ~24KiB each for ASCII.
        const body = "αβγ".repeat(12000); // multibyte text, 36_000 UTF-8 bytes
        await NodeFSP.writeFile(NodePath.join(f.root, "doc"), body);
        const events = await f.read({ relativePath: "doc" });
        expect(events[0]?.kind).toBe("manifest");
        const manifest = events[0] as Extract<WorkspaceResourceReadEvent, { kind: "manifest" }>;
        expect(manifest.byteLength).toBe(utf8Length(body));
        expect(manifest.deliveredByteLength).toBe(utf8Length(body));
        expect(manifest.truncated).toBe(false);
        const chunks = events.slice(1, -1);
        expect(chunks.length).toBe(manifest.chunkCount);
        expect(chunks.length).toBeGreaterThan(1);
        chunks.forEach((chunk, index) => {
          expect(chunk).toMatchObject({ kind: "chunk", chunkIndex: index });
          expect((chunk as { data: string }).data.length).toBeLessThanOrEqual(
            WORKSPACE_RESOURCE_CHUNK_UNITS,
          );
        });
        expect(events.at(-1)).toEqual({
          kind: "complete",
          sha256: sha256Hex(body),
        });
        expect(chunks.map((chunk) => (chunk as { data: string }).data).join("")).toBe(body);
      });
    }),
  );

  it.effect("delivers an honest UTF-8-boundary prefix past the caller maxBytes", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        // 4-byte codepoints so a byte-bounded cut can land mid-sequence.
        const body = "😀".repeat(4000) + "tail";
        await NodeFSP.writeFile(NodePath.join(f.root, "doc"), body);
        const maxBytes = 10_001;
        const events = await f.read({ relativePath: "doc", maxBytes });
        const manifest = events[0] as Extract<WorkspaceResourceReadEvent, { kind: "manifest" }>;
        expect(manifest.truncated).toBe(true);
        expect(manifest.byteLength).toBe(utf8Length(body));
        // The delivered prefix ends on a sequence boundary — never mid-emoji.
        expect(manifest.deliveredByteLength).toBe(10_000);
        expect(events.at(-1)).toEqual({
          kind: "complete",
          sha256: sha256Hex("😀".repeat(2500)),
        });
        const delivered = events
          .slice(1, -1)
          .map((event) => (event as { data: string }).data)
          .join("");
        expect(delivered).toBe("😀".repeat(2500));
      });
    }),
  );

  it.effect("names file-level failures as a sole unavailable frame", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(f.root, "bin"), Buffer.from([0x41, 0x00, 0x42]));
        await NodeFSP.writeFile(NodePath.join(f.root, "bad"), Buffer.from([0xff, 0xfe, 0xfd]));
        await NodeFSP.mkdir(NodePath.join(f.root, "dir"));
        // A lexically-valid path that realpaths outside the root names
        // outside-workspace in the frame; a traversal segment fails input
        // validation before any read and throws instead.
        const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-api-outside-"));
        roots.push(outside);
        await NodeFSP.writeFile(NodePath.join(outside, "secret"), "outside");
        await NodeFSP.symlink(outside, NodePath.join(f.root, "escape"));
        const cases: [string, string][] = [
          ["missing", "not-found"],
          ["dir", "not-regular-file"],
          ["bin", "binary"],
          ["bad", "invalid-utf8"],
          ["escape/secret", "outside-workspace"],
        ];
        for (const [relativePath, reason] of cases) {
          const events = await f.read({ relativePath });
          expect(events).toEqual([{ kind: "unavailable", relativePath, reason }]);
        }
        await expect(f.read({ relativePath: "../secret" })).rejects.toThrow("Invalid");
      });
    }),
  );

  it.effect("rejects a stale workspace context and a foreign environment", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(f.root, "doc"), "x");
        const stale = {
          ...f.context,
          workspaceRevision: extensionWorkspaceRevision("/elsewhere", null),
        };
        await expect(f.read({ relativePath: "doc" }, { context: stale })).rejects.toThrow();
        const foreign = {
          ...f.context,
          resource: { ...f.context.resource, environmentId: "other" },
        };
        await expect(f.read({ relativePath: "doc" }, { context: foreign })).rejects.toThrow();
      });
    }),
  );

  it.effect("denies reads without the orchestration read principal", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(f.root, "doc"), "x");
        const { principal: _dropped, ...anonymous } = f.meta();
        await expect(f.read({ relativePath: "doc" }, { metadata: anonymous })).rejects.toThrow();
        const readOnly = f.meta({
          principal: {
            kind: "environment-session",
            id: "session",
            environmentId: "env",
            scopes: ["unrelated:scope"],
          },
        });
        await expect(f.read({ relativePath: "doc" }, { metadata: readOnly })).rejects.toThrow();
      });
    }),
  );

  it.effect("saves a large file through begin/chunk/commit with a revisioned commit", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        const original = "line\n".repeat(6000); // 30_000 bytes — past the editable bound
        await NodeFSP.writeFile(NodePath.join(f.root, "doc"), original);
        const updated = "updated\n".repeat(5000); // 40_000 bytes
        const result = await f.save(updated, sha256Hex(original));
        expect(result).toEqual({
          kind: "saved",
          relativePath: "doc",
          revision: sha256Hex(updated),
        });
        expect(await NodeFSP.readFile(NodePath.join(f.root, "doc"), "utf8")).toBe(updated);
      });
    }),
  );

  it.effect("conflicts when the on-disk revision moved since the read", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(f.root, "doc"), "stale-base");
        await NodeFSP.writeFile(NodePath.join(f.root, "doc"), "moved-on-disk");
        const result = await f.save("x".repeat(30000), sha256Hex("stale-base"));
        expect(result).toEqual({ kind: "conflict", relativePath: "doc" });
        expect(await NodeFSP.readFile(NodePath.join(f.root, "doc"), "utf8")).toBe("moved-on-disk");
      });
    }),
  );

  it.effect("rejects out-of-order chunks and unknown uploads", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(f.root, "doc"), "base");
        const contents = "x".repeat(30000);
        const chunks = splitWorkspaceResourceChunks(contents);
        const begin = (await f.call("save.begin", {
          relativePath: "doc",
          expectedRevision: sha256Hex("base"),
          byteLength: utf8Length(contents),
          chunkCount: chunks.length,
          sha256: sha256Hex(contents),
        })) as { kind: string; uploadId: string };
        expect(begin.kind).toBe("session");
        await expect(
          f.call("save.chunk", { uploadId: begin.uploadId, chunkIndex: 1, data: chunks[1]! }),
        ).rejects.toThrow("order");
        expect(
          await f.call("save.chunk", {
            uploadId: "nobody",
            chunkIndex: 0,
            data: "x",
          }),
        ).toEqual({ kind: "unavailable", reason: "unknown-upload" });
        expect(await f.call("save.commit", { uploadId: "nobody" })).toEqual({
          kind: "unavailable",
          reason: "unknown-upload",
        });
      });
    }),
  );

  it.effect("fails a commit whose reassembled bytes do not match the declared digest", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(f.root, "doc"), "base");
        const contents = "x".repeat(30000);
        const chunks = splitWorkspaceResourceChunks(contents);
        const begin = (await f.call("save.begin", {
          relativePath: "doc",
          expectedRevision: sha256Hex("base"),
          byteLength: utf8Length(contents),
          chunkCount: chunks.length,
          sha256: "0".repeat(64),
        })) as { kind: string; uploadId: string };
        for (const [chunkIndex, data] of chunks.entries())
          await f.call("save.chunk", { uploadId: begin.uploadId, chunkIndex, data });
        expect(await f.call("save.commit", { uploadId: begin.uploadId })).toEqual({
          kind: "unavailable",
          relativePath: "doc",
          reason: "digest-mismatch",
        });
        expect(await NodeFSP.readFile(NodePath.join(f.root, "doc"), "utf8")).toBe("base");
        // Consumed: a retry re-opens at begin rather than replaying the session.
        expect(await f.call("save.commit", { uploadId: begin.uploadId })).toEqual({
          kind: "unavailable",
          reason: "unknown-upload",
        });
      });
    }),
  );

  it.effect("aborts an in-flight upload and expires abandoned sessions", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(f.root, "doc"), "base");
        const contents = "x".repeat(30000);
        const chunks = splitWorkspaceResourceChunks(contents);
        const begin = (await f.call("save.begin", {
          relativePath: "doc",
          expectedRevision: sha256Hex("base"),
          byteLength: utf8Length(contents),
          chunkCount: chunks.length,
          sha256: sha256Hex(contents),
        })) as { kind: string; uploadId: string };
        expect(await f.call("save.abort", { uploadId: begin.uploadId })).toEqual({});
        expect(
          await f.call("save.chunk", { uploadId: begin.uploadId, chunkIndex: 0, data: chunks[0]! }),
        ).toEqual({ kind: "unavailable", reason: "unknown-upload" });
        // Abandoned (never aborted) sessions expire on the rolling TTL.
        const stale = (await f.call("save.begin", {
          relativePath: "doc",
          expectedRevision: sha256Hex("base"),
          byteLength: utf8Length(contents),
          chunkCount: chunks.length,
          sha256: sha256Hex(contents),
        })) as { kind: string; uploadId: string };
        f.advance(6 * 60_000);
        expect(
          await f.call("save.chunk", { uploadId: stale.uploadId, chunkIndex: 0, data: chunks[0]! }),
        ).toEqual({ kind: "unavailable", reason: "unknown-upload" });
      });
    }),
  );

  it.effect("holds the original bytes when pre-commit authority is revoked", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        const original = "keep me";
        await NodeFSP.writeFile(NodePath.join(f.root, "doc"), original);
        const contents = "x".repeat(30000);
        const chunks = splitWorkspaceResourceChunks(contents);
        const begin = (await f.call("save.begin", {
          relativePath: "doc",
          expectedRevision: sha256Hex(original),
          byteLength: utf8Length(contents),
          chunkCount: chunks.length,
          sha256: sha256Hex(contents),
        })) as { kind: string; uploadId: string };
        for (const [chunkIndex, data] of chunks.entries())
          await f.call("save.chunk", { uploadId: begin.uploadId, chunkIndex, data });
        const result = (await f.call(
          "save.commit",
          { uploadId: begin.uploadId },
          {
            metadata: f.meta({
              assertAuthority: async () => {
                throw new Error("revoked");
              },
            }),
          },
        )) as { kind: string; reason?: string };
        expect(result.kind).toBe("unavailable");
        expect(result.reason).toBe("aborted");
        expect(await NodeFSP.readFile(NodePath.join(f.root, "doc"), "utf8")).toBe(original);
      });
    }),
  );

  it.effect("denies save.begin to a caller missing the operate scope", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(f.root, "doc"), "base");
        const readOnly = f.meta({
          principal: {
            kind: "environment-session",
            id: "session",
            environmentId: "env",
            scopes: [AuthOrchestrationReadScope],
          },
        });
        await expect(
          f.call(
            "save.begin",
            {
              relativePath: "doc",
              expectedRevision: sha256Hex("base"),
              byteLength: 1,
              chunkCount: 1,
              sha256: sha256Hex("x"),
            },
            { metadata: readOnly },
          ),
        ).rejects.toThrow("scope");
      });
    }),
  );

  it.effect("bounds concurrent upload sessions and refuses resume cursors", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(f.root, "doc"), "base");
        const beginInput = {
          relativePath: "doc",
          expectedRevision: sha256Hex("base"),
          byteLength: 1,
          chunkCount: 1,
          sha256: sha256Hex("x"),
        };
        for (let i = 0; i < 8; i += 1) {
          const begin = (await f.call("save.begin", beginInput)) as { kind: string };
          expect(begin.kind).toBe("session");
        }
        expect(await f.call("save.begin", beginInput)).toEqual({
          kind: "unavailable",
          reason: "upload-limit",
        });
        await expect(
          Promise.resolve().then(() =>
            f.provider.subscribe!(
              "read",
              { relativePath: "doc" },
              f.context,
              new AbortController().signal,
              f.meta(),
              "cursor-9",
            ),
          ),
        ).rejects.toThrow("resume");
      });
    }),
  );

  it.effect("binds an upload to the project scope it was begun under", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        const original = "keep me";
        await NodeFSP.writeFile(NodePath.join(f.root, "doc"), original);
        const contents = "x".repeat(30000);
        const chunks = splitWorkspaceResourceChunks(contents);
        const begin = (await f.call("save.begin", {
          relativePath: "doc",
          expectedRevision: sha256Hex(original),
          byteLength: utf8Length(contents),
          chunkCount: chunks.length,
          sha256: sha256Hex(contents),
        })) as { kind: string; uploadId: string };
        // A different project context resolves through the same fixture but
        // is not the scope the upload was begun under — the broker's per-call
        // authorize would pass for it, so the adapter must refuse it itself.
        const other: ViewContext = {
          ...f.context,
          resource: { ...f.context.resource, projectId: "other" },
        };
        expect(
          await f.call(
            "save.chunk",
            { uploadId: begin.uploadId, chunkIndex: 0, data: chunks[0]! },
            { context: other },
          ),
        ).toEqual({ kind: "unavailable", reason: "unknown-upload" });
        expect(
          await f.call("save.commit", { uploadId: begin.uploadId }, { context: other }),
        ).toEqual({ kind: "unavailable", reason: "unknown-upload" });
        // The mismatch does not consume the session — the owning scope can
        // still complete the upload it opened.
        for (const [chunkIndex, data] of chunks.entries())
          await f.call("save.chunk", { uploadId: begin.uploadId, chunkIndex, data });
        expect(await f.call("save.commit", { uploadId: begin.uploadId })).toEqual({
          kind: "saved",
          relativePath: "doc",
          revision: sha256Hex(contents),
        });
        expect(await NodeFSP.readFile(NodePath.join(f.root, "doc"), "utf8")).toBe(contents);
      });
    }),
  );
});
