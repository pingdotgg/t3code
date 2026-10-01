// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { extensionWorkspaceRevision, ProjectId } from "@t3tools/contracts";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import {
  EDITABLE_TEXT_MAX_BYTES,
  validateReadSnapshotResult,
  validateSaveResult,
} from "@t3tools/extension-sdk/catalogue";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterEach, expect, it } from "@effect/vitest";
import * as WorkspacePathsModule from "../workspace/WorkspacePaths.ts";
import { idleMutexKeys, replaceEditableFile as realReplace } from "../workspace/textEdits.ts";
import { createTextEditsApiProvider } from "./textEditsApi.ts";

/** Typed carrier for provider rejections so tests keep an error channel. */
class InvokeFailure extends Data.TaggedError("InvokeFailure")<{ readonly cause: unknown }> {
  override get message(): string {
    return String(this.cause);
  }
}

const sha256Hex = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const services = Layer.provideMerge(WorkspacePathsModule.layer, NodeServices.layer);

type RefreshLog = { readonly cwd: string };
/**
 * Builds the provider against an isolated temp workspace with an injectable
 * replace so authority, cancellation, and rejection paths can be driven
 * deterministically without a server.
 */
const fixture = Effect.fn("textEditsApiTest.fixture")(function* (options?: {
  readonly replace?: typeof realReplace;
}) {
  const root = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-text-api-")),
  );
  roots.push(root);
  const projectId = ProjectId.make("project-a");
  let workspaceRoot = root;
  const refreshes: RefreshLog[] = [];
  let refreshShouldFail = false;
  const provider = yield* Effect.gen(function* () {
    const paths = yield* WorkspacePathsModule.WorkspacePaths;
    return createTextEditsApiProvider({
      environmentId: "env-a",
      projects: {
        getById: () =>
          Effect.sync(() => Option.some({ projectId, workspaceRoot, deletedAt: null })),
      },
      threads: { getById: () => Effect.succeedNone },
      entries: {
        refresh: (cwd) =>
          refreshShouldFail
            ? Effect.die("injected refresh failure")
            : Effect.sync(() => {
                refreshes.push({ cwd });
              }),
      },
      paths,
      ...(options?.replace ? { replaceEditableFile: options.replace } : {}),
    });
  }).pipe(Effect.provide(services));
  const principal = (scopes: readonly string[]) => ({
    kind: "environment-session" as const,
    id: "session-a",
    environmentId: "env-a",
    subject: "tester",
    scopes,
  });
  let assertions = 0;
  let assertShouldFail = false;
  /** Fail the Nth-and-later assertAuthority calls (1-based); 0 = never. */
  let failFromCall = 0;
  const metadata = (scope: "read" | "operate" | "none") => ({
    principal: principal(
      scope === "read"
        ? ["orchestration:read"]
        : scope === "operate"
          ? ["orchestration:read", "orchestration:operate"]
          : [],
    ),
    assertAuthority: async () => {
      assertions += 1;
      if (assertShouldFail || (failFromCall > 0 && assertions >= failFromCall))
        throw new Error("session revoked");
    },
  });
  const context: ViewContext = {
    resource: { namespace: "test.edit", id: "editor", environmentId: "env-a", projectId },
    workspaceRevision: extensionWorkspaceRevision(root, null),
    client: "web",
  };
  const call = (method: string, input: Json, meta = metadata("operate")) => {
    const controller = new AbortController();
    return Effect.tryPromise({
      try: async () =>
        (await provider.invoke(method, input, context, controller.signal, meta as never)) as Json,
      catch: (cause) => new InvokeFailure({ cause }),
    });
  };
  return {
    root,
    provider,
    context,
    call,
    metadata,
    refreshes,
    moveProject: (next: string) => {
      workspaceRoot = next;
    },
    failAuthority: () => {
      assertShouldFail = true;
    },
    getAssertions: () => assertions,
    failRefresh: () => {
      refreshShouldFail = true;
    },
    /** Fail assertAuthority from the Nth call on (barrier=1st, delivery=2nd). */
    failAuthorityFromCall: (n: number) => {
      failFromCall = n;
    },
  };
});

const writeFileUtf8 = (path: string, value: string) =>
  Effect.promise(() => NodeFSP.writeFile(path, value, "utf8"));
const readFileUtf8 = (path: string) => Effect.promise(() => NodeFSP.readFile(path, "utf8"));
const leftOvers = (root: string) =>
  Effect.promise(async () =>
    (await NodeFSP.readdir(root)).filter((name) => name.includes("t3-edit-")),
  );

it.effect("save is denied without an operate-scoped principal, even with write transport", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* writeFileUtf8(NodePath.join(f.root, "doc.txt"), "v1");
    // Broker-level write authority is implied by invoking save at all; the
    // provider must independently reject a read-only session principal.
    const denied = yield* Effect.flip(
      f.call(
        "save",
        {
          relativePath: "doc.txt",
          expectedRevision: sha256Hex("v1"),
          contents: "v2",
        },
        f.metadata("read"),
      ),
    );
    expect(denied.message).toContain("session scope");
    yield* Effect.flatMap(readFileUtf8(NodePath.join(f.root, "doc.txt")), (value) =>
      Effect.sync(() => expect(value).toBe("v1")),
    );
    const noPrincipal = yield* Effect.flip(
      Effect.tryPromise({
        try: async () =>
          await f.provider.invoke(
            "save",
            { relativePath: "doc.txt", expectedRevision: sha256Hex("v1"), contents: "v2" },
            f.context,
            new AbortController().signal,
            {
              assertAuthority: async () => {},
            } as never,
          ),
        catch: (cause) => new InvokeFailure({ cause }),
      }),
    );
    expect(noPrincipal.message).toContain("authority");
  }).pipe(Effect.provide(services)),
);

it.effect("missing root authority metadata is rejected for both methods", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    for (const method of ["readSnapshot", "save"]) {
      const result = yield* Effect.flip(
        Effect.tryPromise({
          try: async () =>
            await f.provider.invoke(
              method,
              method === "save"
                ? { relativePath: "x", expectedRevision: sha256Hex("y"), contents: "z" }
                : { relativePath: "x" },
              f.context,
              new AbortController().signal,
              {} as never,
            ),
          catch: (cause) => new InvokeFailure({ cause }),
        }),
      );
      expect(result.message).toContain("authority");
    }
  }).pipe(Effect.provide(services)),
);

it.effect("readSnapshot returns editable contents with revision, or not-editable reasons", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* writeFileUtf8(NodePath.join(f.root, "ok.txt"), "plain text");
    const good = yield* f.call("readSnapshot", { relativePath: "ok.txt" }, f.metadata("read"));
    expect(good).toEqual({
      kind: "editable",
      relativePath: "ok.txt",
      contents: "plain text",
      revision: sha256Hex("plain text"),
    });
    const missing = yield* f.call("readSnapshot", { relativePath: "gone.txt" }, f.metadata("read"));
    expect(missing).toEqual({
      kind: "not-editable",
      relativePath: "gone.txt",
      reason: "not-found",
    });
  }).pipe(Effect.provide(services)),
);

it.effect(
  "a symlink target reads as not-editable/unsafe-path and validates against the schema",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const outside = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-text-link-out-")),
      );
      roots.push(outside);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(outside, "secret.txt"), "secret", "utf8"),
      );
      yield* Effect.promise(() =>
        NodeFSP.symlink(NodePath.join(outside, "secret.txt"), NodePath.join(f.root, "link.txt")),
      );
      const result = yield* f.call(
        "readSnapshot",
        { relativePath: "link.txt" },
        f.metadata("read"),
      );
      expect(result).toEqual({
        kind: "not-editable",
        relativePath: "link.txt",
        reason: "unsafe-path",
      });
      // The broker validates provider output against the definition; the exact
      // shape emitted here must pass validateReadSnapshotResult.
      yield* Effect.sync(() => expect(() => validateReadSnapshotResult(result)).not.toThrow());
      expect(validateReadSnapshotResult(result)).toEqual(result);
    }).pipe(Effect.provide(services)),
);

it.effect("readSnapshot is denied without orchestration:read", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* writeFileUtf8(NodePath.join(f.root, "ok.txt"), "plain text");
    // operate alone (no orchestration:read) — plus a principal with no scopes.
    const denied = yield* Effect.flip(
      f.call("readSnapshot", { relativePath: "ok.txt" }, f.metadata("none")),
    );
    expect(denied.message).toContain("session scope");
  }).pipe(Effect.provide(services)),
);

it.effect("a successful save refreshes the index and returns the new revision", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* writeFileUtf8(NodePath.join(f.root, "doc.txt"), "v1");
    const result = yield* f.call("save", {
      relativePath: "doc.txt",
      expectedRevision: sha256Hex("v1"),
      contents: "v2-é",
    });
    expect(result).toEqual({
      kind: "saved",
      relativePath: "doc.txt",
      revision: sha256Hex("v2-é"),
    });
    yield* Effect.flatMap(readFileUtf8(NodePath.join(f.root, "doc.txt")), (value) =>
      Effect.sync(() => expect(value).toBe("v2-é")),
    );
    expect(f.refreshes.map((item) => item.cwd)).toEqual([f.root]);
  }).pipe(Effect.provide(services)),
);

it.effect("stale revisions return conflict without refresh or disk change", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* writeFileUtf8(NodePath.join(f.root, "doc.txt"), "current");
    const result = yield* f.call("save", {
      relativePath: "doc.txt",
      expectedRevision: sha256Hex("stale"),
      contents: "next",
    });
    expect(result).toEqual({ kind: "conflict", relativePath: "doc.txt" });
    yield* Effect.flatMap(readFileUtf8(NodePath.join(f.root, "doc.txt")), (value) =>
      Effect.sync(() => expect(value).toBe("current")),
    );
    expect(f.refreshes).toEqual([]);
  }).pipe(Effect.provide(services)),
);

it.effect("session revocation before the commit barrier rejects with original bytes retained", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* writeFileUtf8(NodePath.join(f.root, "doc.txt"), "v1");
    // The revocation is already in force when the save dispatches, so the
    // pre-commit barrier must stop the rename: original bytes stay on disk
    // and the call rejects (the save union admits only saved|conflict).
    f.failAuthority();
    const denied = yield* Effect.flip(
      f.call("save", {
        relativePath: "doc.txt",
        expectedRevision: sha256Hex("v1"),
        contents: "v2",
      }),
    );
    expect(denied.message).toContain("not committed");
    yield* Effect.flatMap(readFileUtf8(NodePath.join(f.root, "doc.txt")), (value) =>
      Effect.sync(() => expect(value).toBe("v1")),
    );
    yield* Effect.flatMap(leftOvers(f.root), (value) =>
      Effect.sync(() => expect(value).toEqual([])),
    );
  }).pipe(Effect.provide(services)),
);

it.effect("post-commit revocation rejects with outcome-unknown while new bytes remain", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* writeFileUtf8(NodePath.join(f.root, "doc.txt"), "v1");
    // Authority passes the pre-commit barrier (call 1) and fails only at the
    // post-commit delivery check (call 2): the commit landed, so this is
    // genuine ambiguity — the caller is NOT handed "saved", but the new
    // bytes are on disk.
    f.failAuthorityFromCall(2);
    const denied = yield* Effect.flip(
      f.call("save", {
        relativePath: "doc.txt",
        expectedRevision: sha256Hex("v1"),
        contents: "v2",
      }),
    );
    expect(denied.message).toContain("no longer authorized");
    expect(f.getAssertions()).toBeGreaterThanOrEqual(2);
    yield* Effect.flatMap(readFileUtf8(NodePath.join(f.root, "doc.txt")), (value) =>
      Effect.sync(() => expect(value).toBe("v2")),
    );
  }).pipe(Effect.provide(services)),
);

it.effect("an aborted commit is reported before result delivery, with the target untouched", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* writeFileUtf8(NodePath.join(f.root, "doc.txt"), "v1");
    // Drive shouldAbort directly (the provider derives it from the signal):
    // an abort observed before the rename reports an error outcome and no
    // "saved" is ever fabricated after the fact.
    const result = yield* realReplace({
      cwd: f.root,
      relativePath: "doc.txt",
      expectedRevision: sha256Hex("v1"),
      contents: "v2",
      shouldAbort: () => true,
    });
    expect(result).toEqual({ outcome: "error", reason: "aborted" });
    yield* Effect.flatMap(readFileUtf8(NodePath.join(f.root, "doc.txt")), (value) =>
      Effect.sync(() => expect(value).toBe("v1")),
    );
  }).pipe(Effect.provide(services)),
);

it.effect("save cancellation before dispatch rejects; no saved is fabricated", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* writeFileUtf8(NodePath.join(f.root, "doc.txt"), "v1");
    const controller = new AbortController();
    controller.abort();
    const failure = yield* Effect.flip(
      Effect.tryPromise({
        try: async () =>
          await f.provider.invoke(
            "save",
            { relativePath: "doc.txt", expectedRevision: sha256Hex("v1"), contents: "v2" },
            f.context,
            controller.signal,
            f.metadata("operate") as never,
          ),
        catch: (cause) => new InvokeFailure({ cause }),
      }),
    );
    expect(failure).toBeInstanceOf(InvokeFailure);
    // The abort landed before the commit: the target is untouched.
    yield* Effect.flatMap(readFileUtf8(NodePath.join(f.root, "doc.txt")), (value) =>
      Effect.sync(() => expect(value).toBe("v1")),
    );
  }).pipe(Effect.provide(services)),
);

it.effect("an IO error after dispatch rejects as outcome-unknown instead of a fake result", () =>
  Effect.gen(function* () {
    const f = yield* fixture({
      replace: () => Effect.succeed({ outcome: "error" as const, reason: "io-error" }),
    });
    yield* writeFileUtf8(NodePath.join(f.root, "doc.txt"), "v1");
    const denied = yield* Effect.flip(
      f.call("save", {
        relativePath: "doc.txt",
        expectedRevision: sha256Hex("v1"),
        contents: "v2",
      }),
    );
    expect(denied.message).toContain("cannot be accessed");
  }).pipe(Effect.provide(services)),
);

it.effect("a moved workspace (stale context revision) is rejected before any write", () =>
  Effect.gen(function* () {
    const other = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-text-moved-")),
    );
    roots.push(other);
    const f = yield* fixture();
    yield* writeFileUtf8(NodePath.join(f.root, "doc.txt"), "v1");
    // The project's workspaceRoot moves after the extension captured its
    // context: the resolver must reject the stale workspaceRevision before
    // any read or write is attempted against the old path.
    f.moveProject(other);
    yield* writeFileUtf8(NodePath.join(other, "doc.txt"), "v1");
    const denied = yield* Effect.flip(
      f.call("save", {
        relativePath: "doc.txt",
        expectedRevision: sha256Hex("v1"),
        contents: "v2",
      }),
    );
    // The provider collapses resolver failures (incl. stale revisions) into a
    // generic unavailability message; the assertion pins that contract.
    expect(denied.message).toContain("unavailable for this request");
    // Neither workspace was touched.
    yield* Effect.flatMap(readFileUtf8(NodePath.join(f.root, "doc.txt")), (value) =>
      Effect.sync(() => expect(value).toBe("v1")),
    );
    yield* Effect.flatMap(readFileUtf8(NodePath.join(other, "doc.txt")), (value) =>
      Effect.sync(() => expect(value).toBe("v1")),
    );
  }).pipe(Effect.provide(services)),
);

it.effect("refresh failure after a confirmed commit still reports saved (logged, not failed)", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* writeFileUtf8(NodePath.join(f.root, "doc.txt"), "v1");
    f.failRefresh();
    const result = yield* f.call("save", {
      relativePath: "doc.txt",
      expectedRevision: sha256Hex("v1"),
      contents: "v2",
    });
    expect(result).toEqual({
      kind: "saved",
      relativePath: "doc.txt",
      revision: sha256Hex("v2"),
    });
    expect(f.refreshes).toEqual([]);
  }).pipe(Effect.provide(services)),
);

it.effect(
  "public readSnapshot -> save round trip is byte-identical on disk (BOM+CRLF unchanged, edited, BOM-less)",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const diskBytes = (name: string) =>
        Effect.promise(async () =>
          (await NodeFSP.readFile(NodePath.join(f.root, name))).toString("hex"),
        );
      const meta = f.metadata("operate");
      // (a) UNCHANGED BOM+CRLF file: snapshot, save the snapshot back, and
      // require the on-disk bytes to be hex-identical, BOM included.
      const original = Buffer.from("﻿header\r\nline\r\n", "utf8");
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(f.root, "bom.txt"), original));
      const snapshot = validateReadSnapshotResult(
        yield* f.call("readSnapshot", { relativePath: "bom.txt" }, meta),
      );
      expect(snapshot.kind).toBe("editable");
      if (snapshot.kind !== "editable") return;
      expect(snapshot.contents.startsWith("﻿")).toBe(true);
      const unchanged = validateSaveResult(
        yield* f.call(
          "save",
          {
            relativePath: "bom.txt",
            expectedRevision: snapshot.revision,
            contents: snapshot.contents,
          },
          meta,
        ),
      );
      expect(unchanged.kind).toBe("saved");
      expect(yield* diskBytes("bom.txt")).toBe(original.toString("hex"));

      // (b) EDITED BOM+CRLF file: the edited text keeps the BOM and CRLF in
      // the exact bytes written to disk.
      const editedText = "﻿header\r\nedited line\r\n";
      const edited = validateSaveResult(
        yield* f.call(
          "save",
          {
            relativePath: "bom.txt",
            expectedRevision: snapshot.revision,
            contents: editedText,
          },
          meta,
        ),
      );
      expect(edited.kind).toBe("saved");
      expect(yield* diskBytes("bom.txt")).toBe(Buffer.from(editedText, "utf8").toString("hex"));

      // (c) A BOM-less file must stay BOM-less through the same public path.
      yield* writeFileUtf8(NodePath.join(f.root, "plain.txt"), "plain\n");
      const plain = validateReadSnapshotResult(
        yield* f.call("readSnapshot", { relativePath: "plain.txt" }, meta),
      );
      if (plain.kind !== "editable") return;
      yield* f.call(
        "save",
        {
          relativePath: "plain.txt",
          expectedRevision: plain.revision,
          contents: plain.contents,
        },
        meta,
      );
      const plainHex = yield* diskBytes("plain.txt");
      expect(plainHex).toBe(Buffer.from("plain\n", "utf8").toString("hex"));
      expect(plainHex.startsWith("efbbbf")).toBe(false);
    }).pipe(Effect.provide(services)),
);

it.effect(
  "a real AbortSignal interrupting the parked save rejects with the original bytes and no temp",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* writeFileUtf8(NodePath.join(f.root, "doc.txt"), "v1");
      const controller = new AbortController();
      let releaseBarrier!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      let signalReachedBarrier!: () => void;
      const reached = new Promise<void>((resolve) => {
        signalReachedBarrier = resolve;
      });
      const invoke = f.provider.invoke;
      const operation = Promise.resolve(
        invoke(
          "save",
          { relativePath: "doc.txt", expectedRevision: sha256Hex("v1"), contents: "v2" },
          f.context,
          controller.signal,
          {
            principal: {
              kind: "environment-session",
              id: "session-a",
              environmentId: "env-a",
              scopes: ["orchestration:read", "orchestration:operate"],
            },
            assertAuthority: async () => {
              signalReachedBarrier();
              await gate;
            },
          } as never,
        ) as Promise<unknown>,
      );
      const outcome = operation.then(
        (value): { rejected: false; value: unknown } | { rejected: true; cause: unknown } => ({
          rejected: false,
          value,
        }),
        (
          cause: unknown,
        ): { rejected: false; value: unknown } | { rejected: true; cause: unknown } => ({
          rejected: true,
          cause,
        }),
      );
      // Deterministic handshake: the save is parked inside the pre-commit
      // barrier with the temp file written and the rename pending.
      yield* Effect.promise(() => reached);
      controller.abort();
      const result = yield* Effect.promise(() => outcome);
      // Rejection is observed only after the temp-file finalizer ran, so no
      // polling is needed: zero .t3-edit-* files must remain right here.
      expect(result.rejected).toBe(true);
      releaseBarrier();
      yield* Effect.flatMap(readFileUtf8(NodePath.join(f.root, "doc.txt")), (value) =>
        Effect.sync(() => expect(value).toBe("v1")),
      );
      yield* Effect.flatMap(leftOvers(f.root), (value) =>
        Effect.sync(() => expect(value).toEqual([])),
      );
      yield* Effect.sync(() => expect(idleMutexKeys()).toEqual([]));
    }).pipe(Effect.provide(services)),
);

it.effect("invalid inputs and unknown methods are rejected before any IO", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const bad = [
      f.call("save", { relativePath: "x", expectedRevision: "not-hex", contents: "y" }),
      f.call("save", { relativePath: "../up", expectedRevision: sha256Hex("y"), contents: "y" }),
      f.call("save", { relativePath: "x", expectedRevision: sha256Hex("y") }),
      f.call("readSnapshot", { relativePath: "" }),
      f.call("unknownMethod", {}),
    ];
    for (const attempt of bad) {
      const failure = yield* Effect.flip(Effect.as(attempt, undefined));
      expect(failure).toBeInstanceOf(InvokeFailure);
    }
    expect(f.refreshes).toEqual([]);
  }).pipe(Effect.provide(services)),
);

it.effect("a 30000-character save rejects with the named byte bound, not an opaque IO error", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* writeFileUtf8(NodePath.join(f.root, "doc.txt"), "v1");
    const denied = yield* Effect.flip(
      f.call("save", {
        relativePath: "doc.txt",
        expectedRevision: sha256Hex("v1"),
        contents: "x".repeat(30000),
      }),
    );
    expect(denied.message).toContain("24000-byte editable bound");
    expect(denied.message).not.toContain("cannot be accessed");
    yield* Effect.flatMap(readFileUtf8(NodePath.join(f.root, "doc.txt")), (value) =>
      Effect.sync(() => expect(value).toBe("v1")),
    );
    expect(f.refreshes).toEqual([]);
  }).pipe(Effect.provide(services)),
);

it.effect(
  "schema-admissible but byte-oversized saves reject with the named bound for every content class",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* writeFileUtf8(NodePath.join(f.root, "doc.txt"), "v1");
      const meta = f.metadata("operate");
      const save = (relativePath: string, contents: string) =>
        f.call("save", { relativePath, expectedRevision: sha256Hex("v1"), contents }, meta);
      // UTF-16 units at or under the advertised maxLength but over 24000
      // UTF-8 bytes: 2/3-byte and astral (surrogate-pair) classes.
      for (const contents of [
        "é".repeat(12001), // 12001 units, 24002 bytes
        "界".repeat(8001), // 8001 units, 24003 bytes
        "\u{1F600}".repeat(6001), // 12002 units, 24004 bytes
      ]) {
        const denied = yield* Effect.flip(save("doc.txt", contents));
        expect(denied.message).toContain("24000-byte editable bound");
      }
      // At the byte bound each class saves cleanly (fresh file per class so
      // the expected revision stays valid).
      const classes = [
        ["a", 1],
        ["é", 2],
        ["界", 3],
        ["\u{1F600}", 4],
      ] as const;
      for (const [index, [unit, unitBytes]] of classes.entries()) {
        const name = `bound-${index}.txt`;
        yield* writeFileUtf8(NodePath.join(f.root, name), "v1");
        const count = Math.floor(EDITABLE_TEXT_MAX_BYTES / unitBytes);
        const contents =
          unit.repeat(count) + "a".repeat(EDITABLE_TEXT_MAX_BYTES - count * unitBytes);
        const result = yield* save(name, contents);
        expect(result).toMatchObject({ kind: "saved", relativePath: name });
      }
      yield* Effect.flatMap(
        readFileUtf8(NodePath.join(f.root, `bound-${classes.length - 1}.txt`)),
        (value) =>
          Effect.sync(() =>
            expect(new TextEncoder().encode(value).length).toBe(EDITABLE_TEXT_MAX_BYTES),
          ),
      );
    }).pipe(Effect.provide(services)),
);
