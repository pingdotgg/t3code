// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { assert } from "vite-plus/test";

import {
  initialWorkflowAgentTranscriptCursor,
  readWorkflowAgentTranscript,
} from "./workflowAgentTranscript.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const assistant = (uuid: string, text: string) =>
  line({
    type: "assistant",
    uuid,
    message: { role: "assistant", id: uuid, content: [{ type: "text", text }] },
  });
const uuids = (lines: ReadonlyArray<unknown>) =>
  lines.map((entry) => (entry as { readonly uuid: string }).uuid);

it.layer(NodeServices.layer)("readWorkflowAgentTranscript", (it) => {
  it.effect("reads complete lines from its cursor and starts over on a new file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "wf-transcript-" });
      const transcriptDir = NodePath.join(configDir, "projects", "test");
      yield* fileSystem.makeDirectory(transcriptDir, { recursive: true });
      const file = NodePath.join(transcriptDir, "agent-a1.jsonl");
      const read = (cursor = initialWorkflowAgentTranscriptCursor) =>
        readWorkflowAgentTranscript({ transcriptDir, agentId: "a1", cursor, configDir });

      const bookkeeping =
        line({ type: "attachment", uuid: "att", attachment: { type: "skill_listing" } }) +
        line({ type: "user", uuid: "meta", isMeta: true, message: { content: "context" } });
      const second = assistant("b", "second");
      NodeFS.writeFileSync(file, bookkeeping + assistant("a", "first") + second.slice(0, 20));
      const first = yield* read();
      assert.deepEqual(uuids(first.lines), ["a"]);
      assert.equal(
        first.cursor.offset,
        Buffer.byteLength(bookkeeping + assistant("a", "first")),
        "a half-written line is left for the next read",
      );

      NodeFS.appendFileSync(file, second.slice(20));
      const next = yield* read(first.cursor);
      assert.deepEqual(uuids(next.lines), ["b"]);
      assert.equal(next.cursor.offset, NodeFS.statSync(file).size);

      NodeFS.rmSync(file);
      NodeFS.writeFileSync(file, assistant("c", "replaced"));
      const replaced = yield* read(next.cursor);
      assert.deepEqual(uuids(replaced.lines), ["c"], "a new inode reads from 0");

      NodeFS.writeFileSync(file, assistant("d", "x"));
      assert.equal(NodeFS.statSync(file).ino, replaced.cursor.identity?.ino);
      const shrunk = yield* read(replaced.cursor);
      assert.deepEqual(uuids(shrunk.lines), ["d"], "a shrunk file reads from 0");
    }).pipe(Effect.scoped),
  );
});
