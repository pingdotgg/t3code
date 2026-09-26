// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type { WorkspaceListEntriesResult } from "@t3tools/extension-sdk/catalogue";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { afterEach, expect, it } from "@effect/vitest";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../workspace/WorkspaceEntries.ts";
import { createWorkspaceApiProvider } from "./workspaceApi.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
const fixture = Effect.fn("workspaceApiTest.fixture")(function* () {
  const root = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-api-workspace-")),
  );
  roots.push(root);
  const projectId = ProjectId.make("project-a");
  let workspaceRoot = root;
  let readStarted = () => {};
  let readGate: Promise<void> | undefined;
  const provider = yield* Effect.gen(function* () {
    const path = yield* Path.Path;
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
    return createWorkspaceApiProvider({
      environmentId: "env-a",
      projects: {
        getById: () =>
          Effect.sync(() => Option.some({ projectId, workspaceRoot, deletedAt: null })),
      },
      threads: { getById: () => Effect.succeedNone },
      workspace: {
        readFile: (input) =>
          Effect.gen(function* () {
            readStarted();
            if (readGate) yield* Effect.promise(() => readGate!);
            return yield* workspace.readFile(input);
          }),
      },
      paths,
      path,
    });
  }).pipe(Effect.provide(NodeServices.layer));
  const context: ViewContext = {
    resource: { namespace: "test.files", id: "files", environmentId: "env-a", projectId },
    workspaceRevision: encodeJson([root, null]),
    client: "web",
  };
  const call = (method: string, input: Json, signal = new AbortController().signal) =>
    provider.invoke(method, input, context, signal);
  return {
    root,
    provider,
    context,
    call,
    moveProject: (next: string) => {
      workspaceRoot = next;
    },
    pauseRead: () => {
      let release!: () => void;
      readGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        readStarted = resolve;
      });
      return { started, release };
    },
    list: async (input: Json) =>
      (await call("listEntries", input)) as unknown as WorkspaceListEntriesResult,
  };
});

it.effect(
  "lists deterministically with bounded pages and rejects changed or cross-directory cursors",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(f.root, "nested"));
        await Promise.all(
          ["z", "a", "m"].map((name) => NodeFSP.writeFile(NodePath.join(f.root, name), name)),
        );
        const first = await f.list({ relativePath: "", limit: 2 });
        expect(first.entries.map((entry) => entry.name)).toEqual(["a", "m"]);
        expect(first.nextCursor).toBeTypeOf("string");
        const second = await f.list({ relativePath: "", limit: 2, cursor: first.nextCursor! });
        expect(second.entries.map((entry) => entry.name)).toEqual(["nested", "z"]);
        expect(second.nextCursor).toBeNull();
        await expect(f.list({ relativePath: "nested", cursor: first.nextCursor! })).rejects.toThrow(
          "stale",
        );
        await NodeFSP.writeFile(NodePath.join(f.root, "b"), "new");
        await expect(f.list({ relativePath: "", cursor: first.nextCursor! })).rejects.toThrow(
          "stale",
        );
        await expect(f.list({ relativePath: "", limit: 201 })).rejects.toThrow("Invalid");
      });
    }),
);

it.effect(
  "rejects traversal, absolute paths, symlink escapes, caller cwd and foreign environments",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const outside = yield* fixture();
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(outside.root, "secret"), "outside");
        await NodeFSP.symlink(outside.root, NodePath.join(f.root, "escape"));
        for (const method of ["listEntries", "readText"]) {
          for (const relativePath of [
            "../secret",
            "/etc/passwd",
            "a/../../secret",
            "escape/secret",
          ]) {
            await expect(f.call(method, { relativePath })).rejects.toThrow();
          }
        }
        await expect(f.list({ relativePath: "escape" })).rejects.toThrow();
        expect((await f.list({ relativePath: "" })).entries).toEqual([]);
        await expect(
          f.call("listEntries", { relativePath: "", cwd: outside.root }),
        ).rejects.toThrow();
        await expect(
          f.provider.invoke(
            "listEntries",
            { relativePath: "" },
            {
              ...f.context,
              resource: { ...f.context.resource, environmentId: "other" },
            },
            new AbortController().signal,
          ),
        ).rejects.toThrow("environment");
      });
    }),
);

it.effect(
  "reads bounded text and suppresses a result when the project moves during an async read",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(f.root, "hello"), "hello");
        expect(await f.call("readText", { relativePath: "hello" })).toEqual({
          relativePath: "hello",
          contents: "hello",
          byteLength: 5,
          truncated: false,
        });
        await NodeFSP.writeFile(NodePath.join(f.root, "large"), "x".repeat(100000));
        const bounded = await f.call("readText", { relativePath: "large" });
        expect(bounded).toMatchObject({
          relativePath: "large",
          byteLength: 100000,
          truncated: true,
        });
        expect(encodeJson(bounded).length).toBeLessThan(64000);
        const pause = f.pauseRead();
        const pending = f.call("readText", { relativePath: "hello" });
        const rejected = expect(pending).rejects.toThrow("stale");
        await pause.started;
        f.moveProject(f.root + "-moved");
        pause.release();
        await rejected;
      });
    }),
);

it.effect("aborts pending reads without delivering a result", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.promise(async () => {
      await NodeFSP.writeFile(NodePath.join(f.root, "hello"), "hello");
      const pause = f.pauseRead();
      const abort = new AbortController();
      const pending = f.call("readText", { relativePath: "hello" }, abort.signal);
      const rejected = expect(pending).rejects.toThrow();
      await pause.started;
      abort.abort();
      await rejected;
      pause.release();
    });
  }),
);

it.effect("rejects an already cancelled directory invocation", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.promise(async () => {
      const abort = new AbortController();
      abort.abort();
      await expect(f.call("listEntries", { relativePath: "" }, abort.signal)).rejects.toThrow();
    });
  }),
);

it.effect("pages long names within the public JSON byte budget", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.promise(async () => {
      await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          NodeFSP.writeFile(
            NodePath.join(f.root, String(i).padStart(3, "0") + "x".repeat(200)),
            "",
          ),
        ),
      );
      const first = await f.list({ relativePath: "", limit: 200 });
      expect(first.entries.length).toBeGreaterThan(0);
      expect(first.entries.length).toBeLessThan(200);
      expect(Buffer.byteLength(encodeJson(first))).toBeLessThanOrEqual(65536);
      const second = await f.list({ relativePath: "", limit: 200, cursor: first.nextCursor! });
      expect(first.entries.length + second.entries.length).toBe(200);
      expect(second.nextCursor).toBeNull();
    });
  }),
);
