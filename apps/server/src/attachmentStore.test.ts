// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import {
  createAttachmentId,
  createCommandAttachmentId,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
} from "./attachmentStore.ts";
import { CommandId } from "@t3tools/contracts";

describe("attachmentStore", () => {
  it("sanitizes thread ids when creating attachment ids", () => {
    const attachmentId = createAttachmentId("thread.folder/unsafe space");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }

    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    expect(threadSegment).toBeTruthy();
    expect(threadSegment).toMatch(/^[a-z0-9_-]+$/i);
    expect(threadSegment).not.toContain(".");
    expect(threadSegment).not.toContain("%");
    expect(threadSegment).not.toContain("/");
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("normalizes created thread segments to lowercase", () => {
    const attachmentId = createAttachmentId("Thread.Foo");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }
    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("thread-foo");
  });

  it.effect("creates stable command-scoped attachment ids", () =>
    Effect.gen(function* () {
      const commandId = CommandId.make("command-stable-attachment");
      const contents = Buffer.from("same image");
      const first = yield* createCommandAttachmentId(
        "Thread.Foo",
        commandId,
        0,
        "image/png",
        contents,
      );
      const replay = yield* createCommandAttachmentId(
        "Thread.Foo",
        commandId,
        0,
        "image/png",
        contents,
      );
      const second = yield* createCommandAttachmentId(
        "Thread.Foo",
        commandId,
        1,
        "image/png",
        contents,
      );
      const altered = yield* createCommandAttachmentId(
        "Thread.Foo",
        commandId,
        0,
        "image/png",
        Buffer.from("different image"),
      );
      const differentMime = yield* createCommandAttachmentId(
        "Thread.Foo",
        commandId,
        0,
        "image/jpeg",
        contents,
      );

      expect(first).toBe(replay);
      expect(first).toBe("thread-foo-2f5c17f2-3173-13b0-6afa-e1142c7b03e7");
      expect(first).not.toBe(second);
      expect(first).not.toBe(altered);
      expect(first).not.toBe(differentMime);
      expect(first && parseThreadSegmentFromAttachmentId(first)).toBe("thread-foo");
    }),
  );

  it.effect("uses unambiguous field boundaries for command-scoped attachment ids", () =>
    Effect.gen(function* () {
      const commandId = CommandId.make("command-unambiguous-attachment");
      const first = yield* createCommandAttachmentId(
        "thread-1",
        commandId,
        0,
        "image/foo",
        Buffer.from("X\0rest"),
      );
      const second = yield* createCommandAttachmentId(
        "thread-1",
        commandId,
        0,
        "image/foo\0X",
        Buffer.from("rest"),
      );

      expect(first).not.toBe(second);

      const firstSurrogate = yield* createCommandAttachmentId(
        "thread-1",
        commandId,
        0,
        `image/${String.fromCharCode(0xd800)}`,
        Buffer.from("rest"),
      );
      const secondSurrogate = yield* createCommandAttachmentId(
        "thread-1",
        commandId,
        0,
        `image/${String.fromCharCode(0xd801)}`,
        Buffer.from("rest"),
      );
      expect(firstSurrogate).not.toBe(secondSurrogate);
    }),
  );

  it.effect("yields while hashing large command attachments", () =>
    Effect.gen(function* () {
      const heartbeats = yield* Ref.make(0);
      const heartbeatStarted = yield* Deferred.make<void>();
      const heartbeat = yield* Ref.updateAndGet(heartbeats, (count) => count + 1).pipe(
        Effect.tap((count) =>
          count === 1 ? Deferred.succeed(heartbeatStarted, undefined) : Effect.void,
        ),
        Effect.andThen(Effect.yieldNow),
        Effect.forever,
        Effect.forkChild,
      );
      yield* Deferred.await(heartbeatStarted);
      const before = yield* Ref.get(heartbeats);

      yield* createCommandAttachmentId(
        "thread-large-attachment",
        CommandId.make("command-large-attachment"),
        0,
        "image/png",
        Buffer.alloc(32 * 1024 * 1024),
      );

      expect(yield* Ref.get(heartbeats)).toBeGreaterThan(before);
      yield* Fiber.interrupt(heartbeat);
    }),
  );

  it("resolves attachment path by id using the extension that exists on disk", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachmentId = "thread-1-attachment";
      const pngPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      });
      expect(resolved).toBe(pngPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("returns null when no attachment file exists for the id", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: "thread-1-missing",
      });
      expect(resolved).toBeNull();
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
