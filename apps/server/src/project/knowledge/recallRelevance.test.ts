import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type { OrchestrationV2NotificationSource } from "@t3tools/contracts";

import { renderSeatTurnPrompt } from "../../orchestration-v2/GroupPrompt.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import {
  recallForMessage,
  recallTokens,
  recallTrigger,
  type RecallFactText,
  type RecallMessage,
  type TermStats,
} from "./recallRelevance.ts";

const CORPUS = 718;
const docsFor = (rare: ReadonlyArray<string>, common: ReadonlyArray<string>) => {
  const docs = new Map<string, number>();
  for (const term of rare) docs.set(term, 1);
  for (const term of common) docs.set(term, 200);
  return docs;
};

const stats: TermStats = {
  corpusSize: CORPUS,
  docs: (term) =>
    docsFor(
      ["ledger", "labs", "toggle", "gates", "billing", "changes", "enable", "ship", "acme"],
      [
        "continue",
        "remaining",
        "work",
        "keep",
        "current",
        "structure",
        "place",
        "same",
        "checkout",
      ],
    ).get(term) ?? 0,
};

const ledger: RecallFactText = {
  id: "ledger-labs",
  content: "The ledger labs toggle gates billing changes.",
  entities: ["ledger labs"],
};

const remaining: RecallFactText = {
  id: "remaining-work",
  content: "Continue the remaining work in the same checkout.",
  entities: ["checkout"],
};

const receipts: RecallFactText = {
  id: "receipt-archive",
  content:
    "Archive receipts preserve invoice timestamps during nightly exports and reconciliation.",
  entities: ["receipt archive"],
};

const facts = [ledger, remaining, receipts];

const filler = "Continue the remaining work and keep the current structure in place. ";
const boilerplate = filler.repeat(Math.ceil(240 / filler.length)).slice(0, 240);
const delegateBrief = `${boilerplate}Enable the ledger labs toggle before billing changes.`;

const idsFor = (message: RecallMessage) =>
  recallForMessage(message, facts, stats).map((fact) => fact.id);

it("recalls a fact the message actually names, and stays quiet otherwise", () => {
  assert.isAbove(boilerplate.length, 200);
  assert.isBelow(delegateBrief.length, 8_192);
  const buried = `${"padding ".repeat(2_000)}Enable the ledger labs toggle`;
  assert.isAbove(buried.indexOf("Enable"), 8_192);
  const seat = renderSeatTurnPrompt({
    delta: [
      {
        label: "Ada",
        model: null,
        text: "Enable the ledger labs toggle before billing changes.",
      },
    ],
    reaction: false,
  });
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly message: RecallMessage;
    readonly ids: ReadonlyArray<string>;
  }> = [
    {
      name: "delegate brief names the fact after the boilerplate",
      message: { text: delegateBrief },
      ids: ["ledger-labs"],
    },
    {
      name: "a narrow fact covers too little of a broad message",
      message: {
        text: `${Array.from({ length: 300 }, (_, index) => `orchard${index}`).join(" ")} Enable the ledger labs toggle before billing changes.`,
      },
      ids: [],
    },
    {
      name: "continue with remaining work",
      message: { text: "continue with remaining work" },
      ids: [],
    },
    {
      name: "can you also do the work here",
      message: { text: "can you also do the work here" },
      ids: [],
    },
    {
      name: "background command notice",
      message: {
        text: "Background command finished (exit code 0) after the ledger labs toggle.",
        notification: { source: { kind: "command" } },
      },
      ids: [],
    },
    {
      name: "subagent completion notice",
      message: {
        text: "Subagent finished the ledger labs toggle.",
        notification: { source: { kind: "subagent" } },
      },
      ids: [],
    },
    {
      name: "pull request watch has only seven matching terms",
      message: {
        text: "Checks failed: archive receipts preserve invoice timestamps during exports.",
        notification: { source: { kind: "monitor" } },
      },
      ids: [],
    },
    {
      name: "pull request watch has eight matching terms",
      message: {
        text: "Checks failed: archive receipts preserve invoice timestamps during nightly exports.",
        notification: { source: { kind: "monitor" } },
      },
      ids: ["receipt-archive"],
    },
    {
      name: "a person names the fact",
      message: { text: "Enable the ledger labs toggle" },
      ids: ["ledger-labs"],
    },
    {
      name: "a seat prompt names the fact and has no notification",
      message: { text: seat },
      ids: ["ledger-labs"],
    },
    {
      name: "a slash command",
      message: { text: "/enable the ledger labs toggle" },
      ids: [],
    },
    {
      name: "the fact is named only past the character bound",
      message: { text: buried },
      ids: [],
    },
  ];
  assert.deepEqual(
    cases.map((entry) => [entry.name, idsFor(entry.message)]),
    cases.map((entry) => [entry.name, entry.ids]),
  );
});

it("classifies every notification kind, and only a pull request watch stays eligible", () => {
  const expectSkip: { [Kind in OrchestrationV2NotificationSource["kind"]]: boolean } = {
    command: true,
    subagent: true,
    background_task: true,
    system: true,
    group: true,
    delegated_task: true,
    monitor: false,
  };
  for (const kind of Object.keys(expectSkip) as Array<OrchestrationV2NotificationSource["kind"]>) {
    const trigger = recallTrigger({
      text: "Enable the ledger labs toggle",
      notification: { source: { kind } },
    });
    assert.equal(trigger.recall, !expectSkip[kind]);
  }
});

it.effect("splits terms the way the FTS vocabulary does", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const content = "The naïve billing-ledger Café_Menu 2026 ok";
    const entities = JSON.stringify(["Café Menu"]);
    yield* sql`
      INSERT INTO project_knowledge_facts (
        id, project_id, status, revision, content, entities_json, tags_json, kind, trust,
        retrieval_count, created_at, updated_at, forgotten_at, sources_json, origin_json
      ) VALUES (
        'fact-tokens', 'project-tokens', 'saved', 1, ${content}, ${entities}, '[]', 'note', 0.5,
        0, '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z', NULL, '[]', '{"kind":"user"}'
      )
    `;
    const rows = yield* sql<{ readonly term: string }>`
      SELECT term FROM project_knowledge_fts_vocab ORDER BY term
    `;
    const indexed = new Set(rows.map((row) => row.term).filter((term) => term.length >= 3));
    assert.deepEqual([...recallTokens(`${content} Café Menu`)].sort(), [...indexed].sort());
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it("uses unicode61 tokens across scripts and identifier punctuation", () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE VIRTUAL TABLE sample USING fts5(content); CREATE VIRTUAL TABLE vocab USING fts5vocab(sample, 'row')",
    );
    const samples = [
      "café naïve résumé Ærøskøbing straße İstanbul Cấu hình kết nối cơ sở dữ liệu",
      "πύλη πληρωμών απορρίπτει συναλλαγές Σ σ ς Ελληνικά",
      "Привет мир тестирование",
      "캐시 키에는 테넌트 한국어텍스트",
      "ガバナンス ばなな キャッシュキー",
      "数据库连接池配置 東京タワー",
      "การย้ายฐานข้อมูล ภายใน ธุรกรรม",
      "हिन्दी भाषा परीक्षण",
      "ﬁlesystem ＦＵＬＬＷＩＤＴＨ ①②③ x²y³ ㎒",
      "emoji🚀rocket deploy✅done",
      "snake_case-name dotted.name path/to/file.ts CamelCase HTTPServer2",
      "a\u0301 e\u0302\u0301 क\u093f क\u094dष",
    ];
    for (const text of samples) {
      db.exec("DELETE FROM sample");
      db.prepare("INSERT INTO sample(content) VALUES (?)").run(text);
      const indexed = db
        .prepare("SELECT term FROM vocab ORDER BY term")
        .all()
        .map((row) => row.term);
      assert.deepEqual([...recallTokens(text)].sort(), indexed, text);
    }
  } finally {
    db.close();
  }
});
