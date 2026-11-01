// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  antigravityThreadUploadsRoot,
  markAntigravityMovedUploads,
  removeAntigravityThreadUploads,
  syncAntigravityThreadUploads,
  takeAntigravityMovedUploads,
} from "./AntigravityThreadUploads.ts";

const thread = ThreadId.make("thread:Uploads-Owner");
const sibling = ThreadId.make("thread:uploads-owner");
const fork = ThreadId.make("thread:Uploads-Owner-fork");

const makeFixture = Effect.fn("AntigravityThreadUploadsTest.makeFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const base = NodeFS.realpathSync(
    yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-uploads-" }),
  );
  const stateDir = NodePath.join(base, "state");
  const attachmentsDir = NodePath.join(stateDir, "attachments");
  const outside = NodePath.join(base, "outside");
  for (const directory of [attachmentsDir, outside]) {
    NodeFS.mkdirSync(directory, { recursive: true });
  }
  const store = (name: string, content: string) => {
    const path = NodePath.join(attachmentsDir, name);
    NodeFS.writeFileSync(path, content);
    return path;
  };
  const sync = (threadId: ThreadId, storedPaths: ReadonlyArray<string>, prune = true) =>
    syncAntigravityThreadUploads({ stateDir, threadId, attachmentsDir, storedPaths, prune });
  return { stateDir, attachmentsDir, outside, store, sync };
});

it.layer(NodeServices.layer)("syncAntigravityThreadUploads", (it) => {
  it.effect("keeps private copies of only the thread's live uploads", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const own = fixture.store("own.png", "own bytes");
      const document = fixture.store("own.pdf", "%PDF");
      NodeFS.writeFileSync(`${document}.txt`, "extracted");
      const theirs = fixture.store("theirs.png", "sibling bytes");
      const linked = NodePath.join(fixture.attachmentsDir, "linked.png");
      NodeFS.writeFileSync(NodePath.join(fixture.outside, "secret.png"), "outside bytes");
      NodeFS.symlinkSync(NodePath.join(fixture.outside, "secret.png"), linked);

      const { root } = yield* fixture.sync(thread, [own, document, linked]);
      yield* fixture.sync(sibling, [theirs]);
      expect(root).toBe(antigravityThreadUploadsRoot(fixture.stateDir, thread));
      expect(root).not.toBe(antigravityThreadUploadsRoot(fixture.stateDir, sibling));
      expect(NodeFS.readdirSync(root).toSorted()).toEqual(["own.pdf", "own.pdf.txt", "own.png"]);

      // An edit reaches only this thread's copy, and the next sync restores it.
      NodeFS.writeFileSync(NodePath.join(root, "own.png"), "edited by agent");
      expect(NodeFS.readFileSync(own, "utf8")).toBe("own bytes");
      yield* fixture.sync(thread, [own, document]);
      expect(NodeFS.readFileSync(NodePath.join(root, "own.png"), "utf8")).toBe("own bytes");

      NodeFS.rmSync(own);
      yield* fixture.sync(thread, [own, document]);
      expect(NodeFS.readdirSync(root).toSorted()).toEqual(["own.pdf", "own.pdf.txt"]);
    }),
  );

  it.effect("leaves an unchanged large upload in place across syncs", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const video = fixture.store("clip.mp4", "");
      NodeFS.truncateSync(video, 64 * 1024 * 1024);
      NodeFS.utimesSync(video, 1_761_937_000.2495, 1_761_937_000.2495);
      expect(NodeFS.statSync(video).mtimeMs % 1).not.toBe(0);

      const { root } = yield* fixture.sync(thread, [video]);
      const first = NodeFS.statSync(NodePath.join(root, "clip.mp4"), { bigint: true });
      yield* fixture.sync(thread, [video]);
      const second = NodeFS.statSync(NodePath.join(root, "clip.mp4"), { bigint: true });
      expect(second.ino).toBe(first.ino);
      expect(second.mtimeNs).toBe(first.mtimeNs);
      expect(second.ctimeNs).toBe(first.ctimeNs);
    }),
  );

  it.effect.each(["thread-uploads", "root"] as const)(
    "fails closed when the managed %s directory is redirected",
    (redirected) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const root = antigravityThreadUploadsRoot(fixture.stateDir, thread);
        const sentinel =
          redirected === "root"
            ? NodePath.join(fixture.outside, "sentinel")
            : NodePath.join(fixture.outside, NodePath.basename(root), "sentinel");
        NodeFS.mkdirSync(NodePath.dirname(sentinel), { recursive: true });
        NodeFS.writeFileSync(sentinel, "keep");
        const link = redirected === "root" ? root : NodePath.dirname(root);
        NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
        NodeFS.symlinkSync(fixture.outside, link);

        const result = yield* fixture
          .sync(thread, [fixture.store("own.png", "own")])
          .pipe(Effect.flip);
        expect(result._tag).toBe("AntigravityThreadUploadsError");
        expect(NodeFS.readFileSync(sentinel, "utf8")).toBe("keep");
        expect(NodeFS.readdirSync(NodePath.dirname(sentinel))).toEqual(["sentinel"]);
      }),
  );

  it.effect("never recurses into a directory inside the root", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const { root } = yield* fixture.sync(thread, []);
      NodeFS.mkdirSync(NodePath.join(root, "nested"));
      NodeFS.writeFileSync(NodePath.join(root, "nested", "keep"), "keep");
      NodeFS.symlinkSync(fixture.outside, NodePath.join(root, "outside-link"));
      NodeFS.writeFileSync(NodePath.join(fixture.outside, "keep"), "keep");

      yield* fixture.sync(thread, []);
      expect(NodeFS.readdirSync(root)).toEqual(["nested"]);
      expect(NodeFS.readFileSync(NodePath.join(root, "nested", "keep"), "utf8")).toBe("keep");
      expect(NodeFS.readFileSync(NodePath.join(fixture.outside, "keep"), "utf8")).toBe("keep");
    }),
  );

  it.effect("removes only a deleted thread's own copies, once", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const document = fixture.store("own.pdf", "%PDF");
      NodeFS.writeFileSync(`${document}.txt`, "extracted");
      const { root } = yield* fixture.sync(thread, [document]);
      yield* markAntigravityMovedUploads(root, [document]);
      const { root: siblingRoot } = yield* fixture.sync(sibling, [document]);
      const { root: forkRoot } = yield* fixture.sync(fork, [document]);

      const remove = () =>
        removeAntigravityThreadUploads({ stateDir: fixture.stateDir, threadId: thread });
      yield* remove();
      expect(NodeFS.existsSync(root)).toBe(false);
      expect(NodeFS.readdirSync(siblingRoot).toSorted()).toEqual(["own.pdf", "own.pdf.txt"]);
      expect(NodeFS.readdirSync(forkRoot).toSorted()).toEqual(["own.pdf", "own.pdf.txt"]);
      expect(NodeFS.readFileSync(document, "utf8")).toBe("%PDF");
      yield* remove();
    }),
  );

  it.effect("leaves a redirected root and everything it points at", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const root = antigravityThreadUploadsRoot(fixture.stateDir, thread);
      NodeFS.writeFileSync(NodePath.join(fixture.outside, "sentinel"), "keep");
      NodeFS.mkdirSync(NodePath.dirname(root), { recursive: true });
      NodeFS.symlinkSync(fixture.outside, root);
      const result = yield* removeAntigravityThreadUploads({
        stateDir: fixture.stateDir,
        threadId: thread,
      }).pipe(Effect.flip);
      expect(result._tag).toBe("AntigravityThreadUploadsError");
      expect(NodeFS.readFileSync(NodePath.join(fixture.outside, "sentinel"), "utf8")).toBe("keep");
    }),
  );

  it.effect("names the newest moved files once, without sidecars or missing files", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const stored = Array.from({ length: 10 }, (_, index) =>
        fixture.store(`thread-upload-${index}.csv`, `row ${index}`),
      );
      NodeFS.writeFileSync(`${stored[9]}.txt`, "extracted");
      const { root } = yield* fixture.sync(thread, stored);
      NodeFS.rmSync(NodePath.join(root, "thread-upload-8.csv"));
      yield* markAntigravityMovedUploads(root, [
        ...stored,
        NodePath.join(fixture.outside, "x.csv"),
      ]);

      const moved = yield* takeAntigravityMovedUploads(root);
      expect(moved?.files).toEqual(
        [9, 7, 6, 5, 4, 3, 2, 1].map((index) => NodePath.join(root, `thread-upload-${index}.csv`)),
      );
      expect(moved?.more).toBe(1);
      expect(yield* takeAntigravityMovedUploads(root)).toBeUndefined();
      // The agent can write in the root; a FIFO in place of the marker must not hang a prompt.
      if ((yield* HostProcess.Platform) !== "win32") {
        NodeChildProcess.execFileSync("mkfifo", [NodePath.join(root, ".moved-uploads-notice")]);
        expect((yield* takeAntigravityMovedUploads(root))?.files).toEqual([]);
      }
    }),
  );
});
