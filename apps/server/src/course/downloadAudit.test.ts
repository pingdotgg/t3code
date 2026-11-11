// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { auditDownload } from "./downloadAudit.ts";

describe("course download audit", () => {
  it.live("redacts URLs and records successful and blocked attempts", () =>
    Effect.promise(async () => {
      const dir = await NodeFSP.mkdtemp(NodePath.join("/tmp", "course-audit-"));
      await auditDownload(
        { stateDir: dir, threadId: "thread-1", courseId: null },
        {
          url: "https://example.com/a?token=abc&id=1",
          status: 200,
          body: Buffer.from("ok"),
          contentType: "text/plain",
        },
      );
      await auditDownload(
        { stateDir: dir, threadId: "thread-1", courseId: null },
        { url: "http://127.0.0.1/", blocked: "private host" },
      );
      const files = await NodeFSP.readdir(NodePath.join(dir, "audit"));
      const lines = (await NodeFSP.readFile(NodePath.join(dir, "audit", files[0]!)))
        .toString()
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.strictEqual(lines.length, 2);
      assert.include(lines[0].url, "token=REDACTED");
      assert.strictEqual(lines[0].status, 200);
      assert.strictEqual(lines[1].blocked, "private host");
    }),
  );
});
