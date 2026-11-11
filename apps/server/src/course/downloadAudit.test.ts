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
          url: "https://example.com/a?access_token=X&pwd=Y&id=1#token=Z",
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
        .map((line) => JSON.parse(line));
      assert.strictEqual(lines.length, 2);
      assert.include(lines[0].url, "token=REDACTED");
      assert.include(lines[0].url, "pwd=REDACTED");
      assert.notInclude(lines[0].url, "#token");
      assert.strictEqual(
        lines[0].sha256,
        "2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df",
      );
      assert.strictEqual(lines[0].status, 200);
      assert.strictEqual(lines[1].blocked, "private host");
    }),
  );

  it.live("retains three months and caps oversized logs", () =>
    Effect.promise(async () => {
      const dir = await NodeFSP.mkdtemp(NodePath.join("/tmp", "course-audit-retention-"));
      const auditDir = NodePath.join(dir, "audit");
      await NodeFSP.mkdir(auditDir);
      await NodeFSP.writeFile(NodePath.join(auditDir, "downloads-2020-01.jsonl"), "old\n");
      await auditDownload({ stateDir: dir }, { url: "https://example.com/ok" });
      assert.deepStrictEqual(await NodeFSP.readdir(auditDir), ["downloads-2026-11.jsonl"]);
      const current = NodePath.join(auditDir, "downloads-2026-11.jsonl");
      await NodeFSP.truncate(current, 100 * 1024 * 1024 + 1);
      await auditDownload({ stateDir: dir }, { url: "https://example.com/capped" });
      assert.include((await NodeFSP.readFile(current, "utf8")).slice(-30), '"capped":true');
    }),
  );
});
