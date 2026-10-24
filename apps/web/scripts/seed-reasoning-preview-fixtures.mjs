#!/usr/bin/env node
// Evidence fixtures for the collapsed reasoning preview (#22985): one synthetic
// thread per reasoning shape, cloned from a completed thread in an isolated dev
// database. Run it with that worktree's dev server stopped:
//
//   vp run migrate-dev-db
//   node apps/web/scripts/seed-reasoning-preview-fixtures.mjs .t3/userdata/statev2.sqlite
//
// These are projection-only visual fixtures (orchestration_events is untouched).
// Every other thread is archived and every fixture thread is marked active, so
// the sidebar and screenshots only show fixture content.
import * as NodeSqlite from "node:sqlite";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const dbPath = NodePath.resolve(process.argv[2] ?? "");
if (NodePath.basename(dbPath) !== "statev2.sqlite")
  throw new Error("pass <base>/userdata/statev2.sqlite");
if (dbPath.startsWith(NodePath.join(NodeOS.homedir(), ".t3") + NodePath.sep)) {
  throw new Error("refusing to write the live ~/.t3 database");
}

const words = (n) => "word ".repeat(n);
const FIXTURES = {
  R1: "Checking the **router** config and `vite.config.ts` before editing.",
  R2: `${words(1638)}ab`,
  R2b: `${words(1638)}abc`,
  R3: `Opening **reasoning** with \`code\`.\n\n${"plain **fragment** ".repeat(10_000)}\n\nFinal reasoning conclusion.`,
  R4: Array.from({ length: 6_000 }, (_, i) => `- step ${i}: inspect file ${i}.ts`).join("\n"),
  R5: `${"x".repeat(190_000)} Final reasoning conclusion.`,
  R6a_link: `[Important reasoning](https://example.com/${"a".repeat(7_900)}) then continue`,
  R6a_bold: `**Important reasoning ${words(1_560)}end**`,
  R6b_link: `[Important reasoning](https://example.com/${"a".repeat(8_300)}) then continue`,
  R6b_bold: `**Important reasoning ${words(4_000)}end**\n\nHidden tail.`,
  R6b_ref: `[Important reasoning][ref]\n\n${words(2_000)}\n\n[ref]: /destination`,
  R6b_math: `$x${" + x".repeat(2_100)}$ then continue`,
  R6c_math: "Before **bold** $x^2$ after.\n\n$$\ny = 2\n$$\n\nEnd.",
  R9: "  ## Plan\n\nUse **bold** *words* and `code` here.\n\n> quoted\n> text\n\n- first\n- second\n\n![an image](image.png)\n\n<div>hidden</div>\n\n[ref]: /hidden",
  R11_html: "<div>hidden</div>",
  R11_def: "[ref]: /hidden",
};

const db = new NodeSqlite.DatabaseSync(dbPath);
const tables = db
  .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
  .all()
  .map(({ name }) => ({
    name,
    columns: db
      .prepare(`PRAGMA table_info("${name}")`)
      .all()
      .map((c) => c.name),
  }))
  .filter(
    ({ name, columns }) =>
      columns.includes("thread_id") &&
      /^orchestration_v2_(projection_|turn_item_positions)/.test(name),
  );

// Thread ids embed a 64-hex token that survives every level of percent-encoding
// in derived ids (run, provider thread, checkpoints), so swapping it clones the
// thread consistently. Provider-native ids (items, turns, threads) don't
// carry it, so they get the fixture tag spliced in after `native-<kind>:`.
const template = db
  .prepare(
    `SELECT t.thread_id, r.run_id FROM orchestration_v2_projection_threads t
     JOIN orchestration_v2_projection_runs r USING (thread_id)
     WHERE r.status = 'completed' AND t.deleted_at IS NULL AND t.thread_id NOT LIKE '%pr23001fx%'
       AND EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items i
                   WHERE i.run_id = r.run_id AND i.type = 'user_message')
       AND EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items i
                   WHERE i.run_id = r.run_id AND i.type = 'assistant_message')
     ORDER BY (SELECT count(*) FROM orchestration_v2_projection_runs x WHERE x.thread_id = t.thread_id), r.completed_at DESC`,
  )
  .all()
  .find(({ thread_id }) => /[0-9a-f]{64}/.test(thread_id));
if (!template)
  throw new Error("no completed thread with a hex id; run `vp run migrate-dev-db` first");
const token = template.thread_id.match(/[0-9a-f]{64}/)[0];

const now = new Date();
const iso = (offsetSeconds) => new Date(now.getTime() - offsetSeconds * 1000).toISOString();
const setText = (payload, text) => ("text" in payload ? { ...payload, text } : payload);

db.exec("BEGIN");
try {
  db.prepare(
    "DELETE FROM orchestration_v2_projection_threads WHERE thread_id LIKE '%pr23001fx%'",
  ).run();
  for (const { name } of tables)
    db.prepare(`DELETE FROM "${name}" WHERE thread_id LIKE '%pr23001fx%'`).run();
  db.prepare(
    "UPDATE orchestration_v2_projection_threads SET archived_at = coalesce(archived_at, ?), payload_json = json_set(payload_json, '$.archivedAt', coalesce(archived_at, ?))",
  ).run(iso(3600), iso(3600));

  Object.entries(FIXTURES).forEach(([name, text], index) => {
    const tag = `pr23001fx${name.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    const newToken = `${tag}${"0".repeat(64 - tag.length)}`;
    const swap = (value) =>
      typeof value === "string"
        ? value
            .replaceAll(token, newToken)
            .replace(/native-(item|turn|thread)(:|%(?:25)*3A)/g, `native-$1$2${tag}-`)
        : value;
    for (const { name: table, columns } of tables) {
      const rows = db
        .prepare(`SELECT * FROM "${table}" WHERE thread_id = ?`)
        .all(template.thread_id);
      const insert = db.prepare(
        `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      for (const row of rows) insert.run(...columns.map((c) => swap(row[c])));
    }
    const threadId = swap(template.thread_id);
    const runId = swap(template.run_id);

    const items = db
      .prepare(
        "SELECT * FROM orchestration_v2_projection_turn_items WHERE thread_id = ? ORDER BY ordinal",
      )
      .all(threadId);
    const user = items.find((item) => item.run_id === runId && item.type === "user_message");
    const assistant = items.findLast(
      (item) => item.run_id === runId && item.type === "assistant_message",
    );
    const keep = new Set([user.turn_item_id, assistant.turn_item_id]);
    for (const item of items) {
      if (keep.has(item.turn_item_id)) continue;
      db.prepare("DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ?").run(
        item.turn_item_id,
      );
      db.prepare(
        "DELETE FROM orchestration_v2_turn_item_positions WHERE thread_id = ? AND turn_item_id = ?",
      ).run(threadId, item.turn_item_id);
    }

    const userText = `Fixture ${name}: show a ${text.length}-character reasoning block.`;
    const assistantText = `Fixture ${name} answer. The reasoning row above is the evidence.`;
    const userPayload = JSON.parse(user.payload_json);
    const assistantPayload = JSON.parse(assistant.payload_json);
    db.prepare(
      "UPDATE orchestration_v2_projection_turn_items SET payload_json = ? WHERE turn_item_id = ?",
    ).run(JSON.stringify(setText(userPayload, userText)), user.turn_item_id);
    db.prepare(
      "UPDATE orchestration_v2_projection_turn_items SET payload_json = ? WHERE turn_item_id = ?",
    ).run(JSON.stringify(setText(assistantPayload, assistantText)), assistant.turn_item_id);
    const finalMessageId = assistantPayload.messageId;
    for (const message of db
      .prepare(
        "SELECT message_id, role, payload_json FROM orchestration_v2_projection_messages WHERE thread_id = ?",
      )
      .all(threadId)) {
      if (message.role === "user") {
        db.prepare(
          "UPDATE orchestration_v2_projection_messages SET payload_json = ? WHERE message_id = ?",
        ).run(
          JSON.stringify(setText(JSON.parse(message.payload_json), userText)),
          message.message_id,
        );
      } else if (finalMessageId && message.message_id !== finalMessageId) {
        db.prepare("DELETE FROM orchestration_v2_projection_messages WHERE message_id = ?").run(
          message.message_id,
        );
      } else {
        db.prepare(
          "UPDATE orchestration_v2_projection_messages SET payload_json = ? WHERE message_id = ?",
        ).run(
          JSON.stringify(setText(JSON.parse(message.payload_json), assistantText)),
          message.message_id,
        );
      }
    }

    const id = `turn-item:fixture:pr23001:${name}`;
    const ordinal = assistant.ordinal - 1;
    const at = assistantPayload.startedAt ?? iso(0);
    const reasoning = {
      id,
      threadId,
      runId,
      nodeId: userPayload.nodeId,
      providerThreadId: assistantPayload.providerThreadId,
      providerTurnId: assistantPayload.providerTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed",
      title: "Thinking",
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "reasoning",
      text,
      streaming: false,
    };
    db.prepare(
      `INSERT INTO orchestration_v2_projection_turn_items
       (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
        parent_item_id, ordinal, type, status, updated_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'reasoning', 'completed', ?, ?)`,
    ).run(
      id,
      threadId,
      runId,
      user.node_id,
      assistant.provider_thread_id,
      assistant.provider_turn_id,
      ordinal,
      at,
      JSON.stringify(reasoning),
    );
    db.prepare(
      "INSERT OR REPLACE INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal) VALUES (?, ?, ?)",
    ).run(threadId, id, ordinal);

    // Later fixtures sort lower in the sidebar, so R1 ends up at the top.
    const updatedAt = iso(index * 60);
    const title = `PR23001 ${name} (${text.length} chars)`;
    db.prepare(
      `UPDATE orchestration_v2_projection_threads
       SET title = ?, updated_at = ?, archived_at = NULL,
           payload_json = json_set(payload_json, '$.title', ?, '$.updatedAt', ?, '$.archivedAt', NULL,
             '$.settledOverride', 'active', '$.settledAt', NULL, '$.unsettledAt', ?)
       WHERE thread_id = ?`,
    ).run(title, updatedAt, title, updatedAt, updatedAt, threadId);
    console.log(`${name}\t${text.length}\t${threadId}`);
  });
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
