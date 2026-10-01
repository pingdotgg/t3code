// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EDITABLE_TEXT_MAX_BYTES } from "@t3tools/extension-sdk/catalogue";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Fiber from "effect/Fiber";
import * as WorkspacePathsModule from "./WorkspacePaths.ts";
import {
  decodeEditableUtf8,
  idleMutexKeys,
  nodeTextEditsFileSystem,
  readEditableFile,
  replaceEditableFile,
  type TextEditsFileSystem,
} from "./textEdits.ts";

const sha256Hex = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const fixture = Effect.fn("textEditsTest.fixture")(function* () {
  const root = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-text-edits-")),
  );
  roots.push(root);
  return root;
});

const services = Layer.provideMerge(WorkspacePathsModule.layer, NodeServices.layer);

const readFileUtf8 = (path: string) => Effect.promise(() => NodeFSP.readFile(path, "utf8"));
const writeFileUtf8 = (path: string, value: string) =>
  Effect.promise(() => NodeFSP.writeFile(path, value, "utf8"));
const leftOvers = (root: string) =>
  Effect.promise(async () =>
    (await NodeFSP.readdir(root)).filter((name) => name.includes("t3-edit-")),
  );

it.effect("readSnapshot returns exact bytes and the sha256 of the complete file", () =>
  Effect.gen(function* () {
    const root = yield* fixture();
    const contents = "hello é 世界 \u{1F600}\ntrailing";
    yield* writeFileUtf8(NodePath.join(root, "note.txt"), contents);
    const result = yield* readEditableFile({ cwd: root, relativePath: "note.txt" });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(new TextDecoder().decode(result.bytes)).toBe(contents);
    expect(result.revision).toBe(sha256Hex(contents));
  }).pipe(Effect.provide(services)),
);

it.effect("conflict is reported without touching the disk when the revision is stale", () =>
  Effect.gen(function* () {
    const root = yield* fixture();
    const file = NodePath.join(root, "doc.txt");
    yield* writeFileUtf8(file, "original");
    const result = yield* replaceEditableFile({
      cwd: root,
      relativePath: "doc.txt",
      expectedRevision: sha256Hex("other"),
      contents: "next",
    });
    expect(result.outcome).toBe("conflict");
    yield* Effect.flatMap(readFileUtf8(file), (value) =>
      Effect.sync(() => expect(value).toBe("original")),
    );
    yield* Effect.flatMap(leftOvers(root), (value) => Effect.sync(() => expect(value).toEqual([])));
  }).pipe(Effect.provide(services)),
);

it.effect("save writes exact bytes, preserves the mode, and reports the new revision", () =>
  Effect.gen(function* () {
    const root = yield* fixture();
    const file = NodePath.join(root, "doc.txt");
    yield* Effect.promise(async () => {
      await NodeFSP.writeFile(file, "v1", "utf8");
      await NodeFSP.chmod(file, 0o640);
    });
    const next = "v2 é \u{1F600}";
    const result = yield* replaceEditableFile({
      cwd: root,
      relativePath: "doc.txt",
      expectedRevision: sha256Hex("v1"),
      contents: next,
    });
    expect(result.outcome).toBe("saved");
    if (result.outcome !== "saved") return;
    expect(result.revision).toBe(sha256Hex(next));
    yield* Effect.flatMap(readFileUtf8(file), (value) =>
      Effect.sync(() => expect(value).toBe(next)),
    );
    yield* Effect.promise(() => NodeFSP.stat(file)).pipe(
      Effect.flatMap((stat) => Effect.sync(() => expect(stat.mode & 0o777).toBe(0o640))),
    );
    yield* Effect.flatMap(leftOvers(root), (value) => Effect.sync(() => expect(value).toEqual([])));
  }).pipe(Effect.provide(services)),
);

it.effect("BOM and CRLF metadata survive read→save→read byte-for-byte", () =>
  Effect.gen(function* () {
    const root = yield* fixture();
    // Fatal UTF-8 decoding keeps the BOM as ordinary text content: it is
    // never stripped on read and never re-added on write.
    const withBom = "﻿header\r\nline one\r\nline two\r\n";
    const bomFile = NodePath.join(root, "bom-crlf.txt");
    yield* Effect.promise(() => NodeFSP.writeFile(bomFile, Buffer.from(withBom, "utf8")));
    const read1 = yield* readEditableFile({ cwd: root, relativePath: "bom-crlf.txt" });
    expect(read1.outcome).toBe("ok");
    if (read1.outcome !== "ok") return;
    expect(Buffer.from(read1.bytes).toString("utf8")).toBe(withBom);
    expect(read1.bytes[0]).toBe(0xef);
    expect(read1.bytes[1]).toBe(0xbb);
    expect(read1.bytes[2]).toBe(0xbf);
    const edited = "﻿header\r\nline one edited\r\nline two\r\n";
    const save = yield* replaceEditableFile({
      cwd: root,
      relativePath: "bom-crlf.txt",
      expectedRevision: read1.revision,
      contents: edited,
    });
    expect(save.outcome).toBe("saved");
    yield* Effect.flatMap(readFileUtf8(bomFile), (value) =>
      Effect.sync(() => expect(value).toBe(edited)),
    );
    const round = yield* readEditableFile({ cwd: root, relativePath: "bom-crlf.txt" });
    if (round.outcome === "ok") {
      expect(Buffer.from(round.bytes).toString("utf8")).toBe(edited);
      expect(round.revision).toBe(sha256Hex(Buffer.from(edited, "utf8")));
    }
    // A BOM-less file edited without adding one stays BOM-less.
    yield* writeFileUtf8(NodePath.join(root, "plain.txt"), "plain\n");
    const plain = yield* readEditableFile({ cwd: root, relativePath: "plain.txt" });
    if (plain.outcome === "ok") {
      yield* replaceEditableFile({
        cwd: root,
        relativePath: "plain.txt",
        expectedRevision: plain.revision,
        contents: "plain2\n",
      });
    }
    yield* Effect.flatMap(readFileUtf8(NodePath.join(root, "plain.txt")), (value) =>
      Effect.sync(() => expect(value).toBe("plain2\n")),
    );
  }).pipe(Effect.provide(services)),
);

it.effect(
  "public read→replace round trip is byte-identical for BOM+CRLF, edited BOM+CRLF, and BOM-less files",
  () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      const diskBytes = (path: string) =>
        Effect.promise(async () => (await NodeFSP.readFile(path)).toString("hex"));
      // (a) UNCHANGED BOM+CRLF file: read then save the snapshot contents
      // back; the on-disk bytes must be hex-identical, BOM (EF BB BF) included.
      const bomPath = NodePath.join(root, "round-bom.txt");
      const bomOriginal = Buffer.from("﻿header\r\nline\r\n", "utf8");
      yield* Effect.promise(() => NodeFSP.writeFile(bomPath, bomOriginal));
      const snapshot = yield* readEditableFile({ cwd: root, relativePath: "round-bom.txt" });
      expect(snapshot.outcome).toBe("ok");
      if (snapshot.outcome !== "ok") return;
      const decoded = decodeEditableUtf8(snapshot.bytes);
      expect(decoded?.startsWith("﻿")).toBe(true);
      const unchanged = yield* replaceEditableFile({
        cwd: root,
        relativePath: "round-bom.txt",
        expectedRevision: snapshot.revision,
        contents: decoded!,
      });
      expect(unchanged.outcome).toBe("saved");
      expect(yield* diskBytes(bomPath)).toBe(bomOriginal.toString("hex"));

      // (b) EDITED BOM+CRLF file: edit the decoded snapshot, save, and
      // confirm the BOM and CRLF line endings survive in the exact bytes.
      const editedText = "﻿header\r\nline one edited\r\nline two\r\n";
      const edited = yield* replaceEditableFile({
        cwd: root,
        relativePath: "round-bom.txt",
        expectedRevision: snapshot.revision,
        contents: editedText,
      });
      expect(edited.outcome).toBe("saved");
      expect(yield* diskBytes(bomPath)).toBe(Buffer.from(editedText, "utf8").toString("hex"));
      expect((yield* diskBytes(bomPath)).startsWith("efbbbf")).toBe(true);
      expect((yield* diskBytes(bomPath)).includes("0d0a")).toBe(true);

      // (c) BOM-less file stays BOM-less through the same round trip.
      const plainPath = NodePath.join(root, "round-plain.txt");
      const plainOriginal = Buffer.from("plain\n", "utf8");
      yield* Effect.promise(() => NodeFSP.writeFile(plainPath, plainOriginal));
      const plainRead = yield* readEditableFile({ cwd: root, relativePath: "round-plain.txt" });
      expect(plainRead.outcome).toBe("ok");
      if (plainRead.outcome !== "ok") return;
      const saved = yield* replaceEditableFile({
        cwd: root,
        relativePath: "round-plain.txt",
        expectedRevision: plainRead.revision,
        contents: decodeEditableUtf8(plainRead.bytes)!,
      });
      expect(saved.outcome).toBe("saved");
      const plainHex = yield* diskBytes(plainPath);
      expect(plainHex).toBe(plainOriginal.toString("hex"));
      expect(plainHex.startsWith("efbbbf")).toBe(false);
    }).pipe(Effect.provide(services)),
);

it.effect("non-editable bounds: missing, directory, binary, and invalid UTF-8", () =>
  Effect.gen(function* () {
    const root = yield* fixture();
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(NodePath.join(root, "folder"));
      await NodeFSP.writeFile(NodePath.join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0xff]));
      await NodeFSP.writeFile(
        NodePath.join(root, "torn.txt"),
        Buffer.from([0x61, 0xf0, 0x80, 0x62]),
      );
    });
    const missing = yield* readEditableFile({ cwd: root, relativePath: "nope.txt" });
    expect(missing).toEqual({ outcome: "error", reason: "not-found" });
    const directory = yield* readEditableFile({ cwd: root, relativePath: "folder" });
    expect(directory).toEqual({ outcome: "error", reason: "not-regular-file" });
    const binary = yield* readEditableFile({ cwd: root, relativePath: "bin.dat" });
    expect(binary).toEqual({ outcome: "error", reason: "binary" });
    const torn = yield* readEditableFile({ cwd: root, relativePath: "torn.txt" });
    expect(torn).toEqual({ outcome: "error", reason: "invalid-utf8" });
    expect(decodeEditableUtf8(Buffer.from([0x80]))).toBeUndefined();
  }).pipe(Effect.provide(services)),
);

it.effect("oversized files are explicitly unavailable, never truncated", () =>
  Effect.gen(function* () {
    const root = yield* fixture();
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(root, "big.txt"),
        "a".repeat(EDITABLE_TEXT_MAX_BYTES + 1),
        "utf8",
      ),
    );
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(root, "edge.txt"),
        "b".repeat(EDITABLE_TEXT_MAX_BYTES),
        "utf8",
      ),
    );
    const oversized = yield* readEditableFile({ cwd: root, relativePath: "big.txt" });
    expect(oversized).toEqual({ outcome: "error", reason: "oversized" });
    const atLimit = yield* readEditableFile({ cwd: root, relativePath: "edge.txt" });
    expect(atLimit.outcome).toBe("ok");
    const tooLong = yield* replaceEditableFile({
      cwd: root,
      relativePath: "edge.txt",
      expectedRevision: sha256Hex("b".repeat(EDITABLE_TEXT_MAX_BYTES)),
      contents: "c".repeat(EDITABLE_TEXT_MAX_BYTES + 1),
    });
    expect(tooLong).toEqual({ outcome: "error", reason: "oversized" });
  }).pipe(Effect.provide(services)),
);

it.effect(
  "an explicit maxBytes widens the bound for resource saves while the default stays 24000",
  () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      const file = NodePath.join(root, "large.txt");
      const base = "a".repeat(EDITABLE_TEXT_MAX_BYTES + 5000);
      yield* writeFileUtf8(file, base);
      const next = "b".repeat(EDITABLE_TEXT_MAX_BYTES + 4000);
      // Without the override the editable bound rejects both reading the
      // current file and the new contents.
      const denied = yield* replaceEditableFile({
        cwd: root,
        relativePath: "large.txt",
        expectedRevision: sha256Hex(base),
        contents: next,
      });
      expect(denied).toEqual({ outcome: "error", reason: "oversized" });
      // With the resource bound the same serialized compare-and-replace lands.
      const saved = yield* replaceEditableFile({
        cwd: root,
        relativePath: "large.txt",
        expectedRevision: sha256Hex(base),
        contents: next,
        maxBytes: EDITABLE_TEXT_MAX_BYTES + 10000,
      });
      expect(saved).toEqual({ outcome: "saved", revision: sha256Hex(next) });
      yield* Effect.flatMap(readFileUtf8(file), (value) =>
        Effect.sync(() => expect(value).toBe(next)),
      );
      // A save past the widened bound is still rejected.
      const pastBound = yield* replaceEditableFile({
        cwd: root,
        relativePath: "large.txt",
        expectedRevision: sha256Hex(next),
        contents: "c".repeat(EDITABLE_TEXT_MAX_BYTES + 10001),
        maxBytes: EDITABLE_TEXT_MAX_BYTES + 10000,
      });
      expect(pastBound).toEqual({ outcome: "error", reason: "oversized" });
    }).pipe(Effect.provide(services)),
);

it.effect("symlinks, escapes, and outside-workspace paths are rejected", () =>
  Effect.gen(function* () {
    const root = yield* fixture();
    const outside = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-text-outside-")),
    );
    roots.push(outside);
    const secret = NodePath.join(outside, "secret.txt");
    yield* Effect.promise(() => NodeFSP.writeFile(secret, "secret", "utf8"));
    yield* Effect.promise(async () => {
      await NodeFSP.symlink(secret, NodePath.join(root, "link.txt"));
      await NodeFSP.mkdir(NodePath.join(root, "dirlink-target"));
      await NodeFSP.symlink(NodePath.join(root, "dirlink-target"), NodePath.join(root, "dirlink"));
    });
    const link = yield* readEditableFile({ cwd: root, relativePath: "link.txt" });
    expect(link).toEqual({ outcome: "error", reason: "unsafe-path" });
    const throughDir = yield* readEditableFile({
      cwd: root,
      relativePath: "dirlink/missing.txt",
    });
    expect(throughDir).toEqual({ outcome: "error", reason: "unsafe-path" });
    const escape = yield* readEditableFile({ cwd: root, relativePath: "../secret.txt" });
    expect(escape.outcome).toBe("error");
    const escapeSave = yield* replaceEditableFile({
      cwd: root,
      relativePath: "../secret.txt",
      expectedRevision: sha256Hex("secret"),
      contents: "x",
    });
    expect(escapeSave.outcome).toBe("error");
    yield* Effect.flatMap(readFileUtf8(secret), (value) =>
      Effect.sync(() => expect(value).toBe("secret")),
    );
  }).pipe(Effect.provide(services)),
);

it.effect("two cooperating writers are serialized; the loser observes the new revision", () =>
  Effect.gen(function* () {
    const root = yield* fixture();
    const file = NodePath.join(root, "shared.txt");
    yield* writeFileUtf8(file, "base");
    const base = sha256Hex("base");
    const attempt = (suffix: string) =>
      replaceEditableFile({
        cwd: root,
        relativePath: "shared.txt",
        expectedRevision: base,
        contents: `winner-${suffix}`,
      });
    const [first, second] = yield* Effect.all([attempt("a"), attempt("b")], {
      concurrency: "unbounded",
    });
    expect([first.outcome, second.outcome].sort()).toEqual(["conflict", "saved"]);
    const disk = yield* readFileUtf8(file);
    expect(disk.startsWith("winner-")).toBe(true);
    const saved = [first, second].find((item) => item.outcome === "saved");
    if (saved?.outcome === "saved") expect(saved.revision).toBe(sha256Hex(disk));
    // Both holders released: the lock map must not retain the settled path.
    yield* Effect.sync(() => expect(idleMutexKeys()).toEqual([]));
  }).pipe(Effect.provide(services)),
);

it.effect("cancellation before commit reports an error outcome and cleans the temp file", () =>
  Effect.gen(function* () {
    const root = yield* fixture();
    const file = NodePath.join(root, "cancel.txt");
    yield* writeFileUtf8(file, "keep");
    const result = yield* replaceEditableFile({
      cwd: root,
      relativePath: "cancel.txt",
      expectedRevision: sha256Hex("keep"),
      contents: "changed",
      shouldAbort: () => true,
    });
    expect(result.outcome).toBe("error");
    yield* Effect.flatMap(readFileUtf8(file), (value) =>
      Effect.sync(() => expect(value).toBe("keep")),
    );
    yield* Effect.flatMap(leftOvers(root), (value) => Effect.sync(() => expect(value).toEqual([])));
  }).pipe(Effect.provide(services)),
);

it.effect("a beforeCommit rejection at the barrier keeps original bytes and cleans the temp", () =>
  Effect.gen(function* () {
    const root = yield* fixture();
    const file = NodePath.join(root, "gated.txt");
    yield* writeFileUtf8(file, "original");
    let barrierCalls = 0;
    const result = yield* replaceEditableFile({
      cwd: root,
      relativePath: "gated.txt",
      expectedRevision: sha256Hex("original"),
      contents: "updated",
      beforeCommit: async () => {
        barrierCalls += 1;
        throw new Error("authority revoked at the barrier");
      },
    });
    expect(result).toEqual({ outcome: "error", reason: "aborted" });
    expect(barrierCalls).toBe(1);
    yield* Effect.flatMap(readFileUtf8(file), (value) =>
      Effect.sync(() => expect(value).toBe("original")),
    );
    yield* Effect.flatMap(leftOvers(root), (value) => Effect.sync(() => expect(value).toEqual([])));
    yield* Effect.sync(() => expect(idleMutexKeys()).toEqual([]));
  }).pipe(Effect.provide(services)),
);

it.effect(
  "a deferred barrier holds the rename until released; abort during it keeps original bytes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* fixture();
        const file = NodePath.join(root, "deferred.txt");
        yield* writeFileUtf8(file, "first");
        let releaseBarrier!: () => void;
        const gate = new Promise<void>((resolve) => {
          releaseBarrier = resolve;
        });
        let signalReachedBarrier!: () => void;
        const reached = new Promise<void>((resolve) => {
          signalReachedBarrier = resolve;
        });
        // The abort flag flips only while the writer is parked at the barrier:
        // every earlier shouldAbort checkpoint sees false, so the post-await
        // barrier check is exactly what catches the abort.
        let abortAtBarrier = false;
        const fiber = yield* replaceEditableFile({
          cwd: root,
          relativePath: "deferred.txt",
          expectedRevision: sha256Hex("first"),
          contents: "second",
          beforeCommit: async () => {
            signalReachedBarrier();
            await gate;
          },
          shouldAbort: () => abortAtBarrier,
        }).pipe(Effect.forkScoped);
        yield* Effect.promise(() => reached);
        yield* Effect.flatMap(readFileUtf8(file), (value) =>
          Effect.sync(() => expect(value).toBe("first")),
        );
        // The abort lands while parked at the barrier, before it is released.
        abortAtBarrier = true;
        releaseBarrier();
        const result = yield* Fiber.join(fiber);
        expect(result).toEqual({ outcome: "error", reason: "aborted" });
        yield* Effect.flatMap(readFileUtf8(file), (value) =>
          Effect.sync(() => expect(value).toBe("first")),
        );
        yield* Effect.flatMap(leftOvers(root), (value) =>
          Effect.sync(() => expect(value).toEqual([])),
        );
        yield* Effect.sync(() => expect(idleMutexKeys()).toEqual([]));
      }).pipe(Effect.provide(services)),
    ),
);

it.effect("a granted deferred barrier commits exactly once after release", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* fixture();
      const file = NodePath.join(root, "released.txt");
      yield* writeFileUtf8(file, "first");
      let releaseBarrier!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      let signalReachedBarrier!: () => void;
      const reached = new Promise<void>((resolve) => {
        signalReachedBarrier = resolve;
      });
      const fiber = yield* replaceEditableFile({
        cwd: root,
        relativePath: "released.txt",
        expectedRevision: sha256Hex("first"),
        contents: "second",
        beforeCommit: async () => {
          signalReachedBarrier();
          await gate;
        },
      }).pipe(Effect.forkScoped);
      // The writer is parked at the barrier: the target is still untouched.
      yield* Effect.promise(() => reached);
      yield* Effect.flatMap(readFileUtf8(file), (value) =>
        Effect.sync(() => expect(value).toBe("first")),
      );
      releaseBarrier();
      const result = yield* Fiber.join(fiber);
      expect(result.outcome).toBe("saved");
      yield* Effect.flatMap(readFileUtf8(file), (value) =>
        Effect.sync(() => expect(value).toBe("second")),
      );
      yield* Effect.sync(() => expect(idleMutexKeys()).toEqual([]));
    }).pipe(Effect.provide(services)),
  ),
);

it.effect(
  "real fiber interruption parked at the precommit barrier cleans the temp and drains the mutex",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* fixture();
        const file = NodePath.join(root, "int-barrier.txt");
        yield* writeFileUtf8(file, "original");
        let releaseBarrier!: () => void;
        const gate = new Promise<void>((resolve) => {
          releaseBarrier = resolve;
        });
        let signalReachedBarrier!: () => void;
        const reached = new Promise<void>((resolve) => {
          signalReachedBarrier = resolve;
        });
        // shouldAbort is driven by a flag the test flips before interrupting:
        // the interruption-honest wrapper then maps the torn-down fiber to the
        // "aborted" reason instead of re-raising the interruption.
        let abortFlag = false;
        const fiber = yield* Effect.forkScoped(
          replaceEditableFile({
            cwd: root,
            relativePath: "int-barrier.txt",
            expectedRevision: sha256Hex("original"),
            contents: "updated",
            beforeCommit: async () => {
              signalReachedBarrier();
              await gate;
            },
            shouldAbort: () => abortFlag,
          }),
        );
        // Deterministic handshake: the writer is parked inside the barrier, the
        // temp file is fully written and the fiber is awaiting its release.
        yield* Effect.promise(() => reached);
        // A real interruption tears down the fiber while it awaits beforeCommit:
        // the manual discard lines can never run, only the finalizer can clean up.
        abortFlag = true;
        yield* Fiber.interrupt(fiber);
        releaseBarrier();
        yield* Effect.flatMap(readFileUtf8(file), (value) =>
          Effect.sync(() => expect(value).toBe("original")),
        );
        yield* Effect.flatMap(leftOvers(root), (value) =>
          Effect.sync(() => expect(value).toEqual([])),
        );
        yield* Effect.sync(() => expect(idleMutexKeys()).toEqual([]));
        // The freed lock admits a queued writer, which commits normally.
        const queued = yield* replaceEditableFile({
          cwd: root,
          relativePath: "int-barrier.txt",
          expectedRevision: sha256Hex("original"),
          contents: "queued-write",
        });
        expect(queued.outcome).toBe("saved");
        yield* Effect.flatMap(readFileUtf8(file), (value) =>
          Effect.sync(() => expect(value).toBe("queued-write")),
        );
        yield* Effect.sync(() => expect(idleMutexKeys()).toEqual([]));
      }).pipe(Effect.provide(services)),
    ),
);

it.effect("real fiber interruption during write/fsync cleans the temp via the finalizer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* fixture();
      const file = NodePath.join(root, "int-write.txt");
      yield* writeFileUtf8(file, "keep");
      let releaseWrite!: () => void;
      const writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      let signalEnteredWrite!: () => void;
      const writeEntered = new Promise<void>((resolve) => {
        signalEnteredWrite = resolve;
      });
      let releaseSignal!: () => void;
      const signalGate = new Promise<void>((resolve) => {
        releaseSignal = resolve;
      });
      const slowOpen: TextEditsFileSystem = {
        ...nodeTextEditsFileSystem,
        open: (path, flags, mode) => {
          if (typeof path === "string" && path.includes(".t3-edit-")) {
            signalEnteredWrite();
            // Hold the open in flight; the O_EXCL create has happened inside
            // libuv by the time this resolver runs, so the finalizer must own
            // the path even though the acquire effect never completed.
            return Promise.all([writeGate, signalGate]).then(
              () => NodeFSP.open(path, flags, mode),
              () => NodeFSP.open(path, flags, mode),
            );
          }
          return NodeFSP.open(path, flags, mode);
        },
      };
      const fiber = yield* Effect.forkScoped(
        replaceEditableFile(
          {
            cwd: root,
            relativePath: "int-write.txt",
            expectedRevision: sha256Hex("keep"),
            contents: "changed",
          },
          slowOpen,
        ),
      );
      // Deterministic: wait until the writer is parked acquiring the temp
      // handle (the finalizer is registered, so it owns the possibly-created
      // temp path), THEN raise a real interruption while it sits there, then
      // release both gates so the fiber unwinds through the finalizer.
      // Joining the killer fiber proves cleanup ran to completion — no sleep.
      yield* Effect.promise(() => writeEntered);
      const killer = yield* Effect.forkScoped(Fiber.interrupt(fiber));
      yield* Effect.yieldNow;
      releaseWrite();
      releaseSignal();
      yield* Fiber.join(killer);
      yield* Effect.flatMap(readFileUtf8(file), (value) =>
        Effect.sync(() => expect(value).toBe("keep")),
      );
      yield* Effect.flatMap(leftOvers(root), (value) =>
        Effect.sync(() => expect(value).toEqual([])),
      );
      yield* Effect.sync(() => expect(idleMutexKeys()).toEqual([]));
    }).pipe(Effect.provide(services)),
  ),
);

it.effect("cleanup failures after a failed rename are contained and the target survives", () => {
  let unlinkCalls = 0;
  const failing: TextEditsFileSystem = {
    ...nodeTextEditsFileSystem,
    rename: async (from) => {
      throw new Error(`injected rename failure: ${from}`);
    },
    unlink: async () => {
      unlinkCalls += 1;
      throw new Error("injected unlink failure");
    },
  };
  return Effect.gen(function* () {
    const root = yield* fixture();
    const file = NodePath.join(root, "rename-fail.txt");
    yield* writeFileUtf8(file, "intact");
    const result = yield* replaceEditableFile(
      {
        cwd: root,
        relativePath: "rename-fail.txt",
        expectedRevision: sha256Hex("intact"),
        contents: "updated",
      },
      failing,
    );
    expect(result.outcome).toBe("error");
    expect(unlinkCalls).toBe(1);
    yield* Effect.flatMap(readFileUtf8(file), (value) =>
      Effect.sync(() => expect(value).toBe("intact")),
    );
  }).pipe(Effect.provide(services));
});

it.effect("save through an injected open failure leaves the target untouched", () =>
  Effect.gen(function* () {
    const root = yield* fixture();
    const file = NodePath.join(root, "raced.txt");
    yield* writeFileUtf8(file, "v1");
    let injected = false;
    const failing: TextEditsFileSystem = {
      ...nodeTextEditsFileSystem,
      open: (path, flags, mode) => {
        if (typeof path === "string" && path.endsWith("raced.txt") && !injected) {
          injected = true;
          return Promise.reject(new Error("injected open failure"));
        }
        return NodeFSP.open(path, flags, mode);
      },
    };
    const result = yield* replaceEditableFile(
      {
        cwd: root,
        relativePath: "raced.txt",
        expectedRevision: sha256Hex("v1"),
        contents: "v2",
      },
      failing,
    );
    expect(result.outcome).toBe("error");
    yield* Effect.flatMap(readFileUtf8(file), (value) =>
      Effect.sync(() => expect(value).toBe("v1")),
    );
    yield* Effect.flatMap(leftOvers(root), (value) => Effect.sync(() => expect(value).toEqual([])));
  }).pipe(Effect.provide(services)),
);

it.effect("rejects the unsafe platform mapping instead of degrading checks", () =>
  Effect.gen(function* () {
    const root = yield* fixture();
    yield* writeFileUtf8(NodePath.join(root, "w.txt"), "x");
    // The win32 mapping is injected through the HostProcessPlatform service.
    const read = yield* readEditableFile({ cwd: root, relativePath: "w.txt" }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
    );
    expect(read).toEqual({ outcome: "error", reason: "unsafe-path" });
  }).pipe(Effect.provide(services)),
);
