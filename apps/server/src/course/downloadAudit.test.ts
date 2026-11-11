// @effect-diagnostics nodeBuiltinImport:off globalDate:off
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
      await auditDownload(
        { stateDir: dir, threadId: "thread-1", courseId: null },
        { url: "https://user:pw@example.com/a", status: 200 },
      );
      const withUserinfo = JSON.parse(
        (await NodeFSP.readFile(NodePath.join(dir, "audit", files[0]!)))
          .toString()
          .trim()
          .split("\n")[2]!,
      );
      assert.notInclude(withUserinfo.url, "user");
      assert.notInclude(withUserinfo.url, "pw");
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
      const monthName = (offset: number) => {
        // Retention is calendar based, so the test must derive the current month.
        // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- required for month rollover coverage.
        const date = new Date();
        date.setUTCDate(1);
        date.setUTCMonth(date.getUTCMonth() - offset);
        return `downloads-${date.toISOString().slice(0, 7)}.jsonl`;
      };
      const twoMonthsAgo = monthName(2);
      const threeMonthsAgo = monthName(3);
      await NodeFSP.writeFile(NodePath.join(auditDir, twoMonthsAgo), "old\n");
      await NodeFSP.writeFile(NodePath.join(auditDir, threeMonthsAgo), "old\n");
      await auditDownload({ stateDir: dir }, { url: "https://example.com/ok" });
      const currentName = monthName(0);
      assert.include(await NodeFSP.readdir(auditDir), currentName);
      assert.include(await NodeFSP.readdir(auditDir), twoMonthsAgo);
      assert.notInclude(await NodeFSP.readdir(auditDir), threeMonthsAgo);
      const current = NodePath.join(auditDir, currentName);
      await NodeFSP.truncate(current, 100 * 1024 * 1024 + 1);
      await NodeFSP.utimes(current, 0, 0);
      await auditDownload({ stateDir: dir }, { url: "https://example.com/capped" });
      assert.include((await NodeFSP.readFile(current, "utf8")).slice(-30), '"capped":true');
    }),
  );
});
