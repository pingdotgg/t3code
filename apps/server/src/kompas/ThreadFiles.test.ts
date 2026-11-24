import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { createAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadFiles from "./ThreadFiles.ts";

const layer = ThreadFiles.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-files-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("reads a conversation's folder and attachments, and nothing else", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const files = yield* ThreadFiles.ThreadFiles;
    const root = yield* fileSystem.makeTempDirectoryScoped();
    const folder = path.join(root, "mine");
    yield* fileSystem.makeDirectory(folder);
    yield* fileSystem.writeFileString(path.join(folder, "notes.md"), "a".repeat(40_001));
    yield* fileSystem.writeFileString(path.join(root, "secret.txt"), "secret");
    yield* fileSystem.writeFile(path.join(folder, "image.bin"), new Uint8Array([0xff, 0xfe]));
    const attach = Effect.fnUntraced(function* (threadId: string) {
      const file = path.join(attachmentsDir, `${createAttachmentId(threadId, "txt")}.txt`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(file, threadId);
      return file;
    });
    const thread = { id: ThreadId.make("thread-a"), worktreePath: folder };
    const read = (target: string, offset = 0) => files.read({ thread, path: target, offset });

    const first = yield* read("notes.md");
    assert.lengthOf(first.text, 40_000);
    assert.deepEqual(yield* read("notes.md", first.nextOffset), { text: "a" });
    assert.deepEqual(yield* read("."), { text: "image.bin\nnotes.md" });
    assert.deepEqual(yield* read(yield* attach("thread-a")), { text: "thread-a" });

    for (const target of [
      "../secret.txt",
      path.join(root, "secret.txt"),
      yield* attach("thread-b"),
    ]) {
      assert.equal((yield* read(target).pipe(Effect.flip)).reason, "not-found");
    }
    assert.equal((yield* read("image.bin").pipe(Effect.flip)).reason, "invalid");
    // Without a folder of its own, only its attachments.
    const homeless = yield* files
      .read({ thread: { ...thread, worktreePath: null }, path: "../secret.txt", offset: 0 })
      .pipe(Effect.flip);
    assert.equal(homeless.reason, "not-found");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
