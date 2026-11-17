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
  rankRecallCandidates,
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
      ids: ["ledger-labs", "remaining-work"],
    },
    {
      name: "a narrow fact covers too little of a broad message",
      message: {
        text: `${Array.from({ length: 300 }, (_, index) => `orchard${index}`).join(" ")} Enable the ledger labs toggle before billing changes.`,
      },
      ids: [],
    },
    {
      name: "a short request fully covers a common fact",
      message: { text: "continue with remaining work" },
      ids: ["remaining-work"],
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
        text: "Checks failed: during exports, invoice timestamps in archive receipts were lost; preserve them.",
        notification: { source: { kind: "monitor" } },
      },
      ids: [],
    },
    {
      name: "pull request watch has eight matching terms",
      message: {
        text: "Checks failed: during nightly exports, invoice timestamps in archive receipts were lost; preserve them.",
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
    recallForMessage({ text: "continue with remaining work" }, facts, {
      ...stats,
      corpusSize: 2000,
    }).map((fact) => fact.id),
    ["remaining-work"],
  );
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
    const indexed = new Set(rows.map((row) => row.term));
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

it("enforces coverage, overlap and relevance order", () => {
  const shared = "cobalt kestrel lantern";
  const padding =
    "orchard harbor willow badger meadow pebble granite thistle otter falcon river maple";
  const fact = (id: string, content: string, entities: string[] = []): RecallFactText => ({
    id,
    content,
    entities,
  });
  const cases = [
    {
      name: "long unspaced Han token",
      text: "数据库连接池配置",
      facts: [fact("han", "数据库连接池配置")],
      docs: 1,
      ids: ["han"],
    },
    {
      name: "short Han token",
      text: "数据库",
      facts: [fact("short-han", "数据库")],
      docs: 1,
      ids: [],
    },
    {
      name: "stopwords",
      text: "can you please",
      facts: [fact("stopwords", "can you please")],
      docs: 1,
      ids: [],
    },
    {
      name: "short identifiers",
      text: "go db ui",
      facts: [fact("short-terms", "go db ui")],
      docs: 1,
      ids: [],
    },
    {
      name: "two matched terms",
      text: "cobalt kestrel",
      facts: [fact("two", shared)],
      docs: 1,
      ids: [],
    },
    {
      name: "coverage below thirty percent on both sides",
      text: `${shared} ${padding}`,
      facts: [
        fact(
          "low",
          `${shared} violet copper quartz blossom crimson spruce coral eucalyptus fern almond cedar silver`,
        ),
      ],
      docs: 1,
      ids: [],
    },
    {
      name: "entity terms match alongside content",
      text: shared,
      facts: [fact("entity", "Formatting preferences apply locally.", [shared])],
      docs: 1,
      ids: ["entity"],
    },
    {
      name: "query coverage carries a narrow request",
      text: shared,
      facts: [fact("broad", `${shared} ${padding}`)],
      docs: 1,
      ids: ["broad"],
    },
    {
      name: "fact coverage carries a broad brief",
      text: `${shared} ${padding}`,
      facts: [fact("narrow", shared)],
      docs: 1,
      ids: ["narrow"],
    },
    {
      name: "leading whitespace before slash",
      text: ` \n\t/${shared}`,
      facts: [fact("slash", shared)],
      docs: 1,
      ids: [],
    },
    {
      name: "empty indexed content",
      text: shared,
      facts: [fact("empty", "!!!")],
      docs: 1,
      ids: [],
    },
    {
      name: "relevance orders the two attachments",
      text: `${shared} orchard harbor willow badger meadow pebble granite`,
      facts: [
        fact("weak", `${shared} violet copper quartz blossom crimson spruce coral`),
        fact("middle", `${shared} harbor orchard violet copper quartz blossom crimson`),
        fact("strong", `${shared} meadow badger willow harbor orchard violet copper`),
      ],
      docs: 1,
      ids: ["strong", "middle"],
    },
    {
      name: "overlap in a longer brief still admits the complete fact",
      text: "Update the invoice exporter. Archive receipts must preserve invoice timestamps during nightly exports, and the reconciliation job reads them afterwards.",
      facts: [
        fact("stated", "Archive receipts preserve invoice timestamps during nightly exports."),
        fact(
          "shared-words",
          "Nightly reconciliation rejects exports whose invoice timestamps differ from archive receipts.",
        ),
        fact("next", "The reconciliation job owns the invoice exporter schedule."),
      ],
      docs: 1,
      ids: ["stated", "shared-words"],
    },
    {
      name: "a question needs the saved requirement",
      text: "Should cache keys include tenant IDs?",
      facts: [fact("requirement", "Cache keys must include tenant IDs.")],
      docs: 1,
      ids: ["requirement"],
    },
    {
      name: "a contradictory request needs the saved prohibition",
      text: "Disable tenant authorization checks.",
      facts: [fact("prohibition", "Never disable tenant authorization checks.")],
      docs: 1,
      ids: ["prohibition"],
    },
    {
      name: "shared wording does not carry the fact's qualification",
      text: "Rotate production cache keys.",
      facts: [
        fact(
          "condition",
          "Rotate production cache keys only after replicas have acknowledged the new encryption material.",
        ),
      ],
      docs: 1,
      ids: ["condition"],
    },
    {
      name: "matching entities do not restate the saved content",
      text: "tenant authorization policy checks",
      facts: [
        fact("entity-only", "Release migrations require a verified backup.", [
          "tenant authorization policy checks",
        ]),
      ],
      docs: 1,
      ids: ["entity-only"],
    },
    {
      name: "a complete copied statement gives up its slot",
      text: "Cache keys must include tenant IDs.",
      facts: [
        fact("copied", "Cache keys must include tenant IDs."),
        fact("additional", "Tenant IDs in cache keys prevent cross-tenant data leaks."),
      ],
      docs: 1,
      ids: ["additional"],
    },
    {
      name: "surrounding whitespace still carries the complete statement",
      text: " \nNever disable tenant authorization checks.\n ",
      facts: [fact("copied", "Never disable tenant authorization checks.")],
      docs: 1,
      ids: [],
    },
    {
      name: "internal whitespace can change a quoted cache prefix",
      text: 'Cache keys use the prefix "tenant id".',
      facts: [fact("prefix", 'Cache keys use the prefix "tenant  id".')],
      docs: 1,
      ids: ["prefix"],
    },
  ];
  for (const row of cases) {
    const attached = recallForMessage({ text: row.text }, row.facts, {
      corpusSize: CORPUS,
      docs: () => row.docs,
    });
    assert.deepEqual(
      attached.map((f) => f.id),
      row.ids,
      row.name,
    );
  }
  assert.deepEqual(
    recallForMessage(
      { text: "数据库连接池配置", notification: { source: { kind: "monitor" } } },
      [fact("han", "数据库连接池配置")],
      stats,
    ),
    [],
  );
  assert.deepEqual(
    rankRecallCandidates("!!!", [fact("empty", "!!!")], stats).filter((m) => m.passes),
    [],
  );
});

it("weights distinctive terms", () => {
  const shared = "cobalt kestrel lantern";
  const query = `${shared} violet copper quartz meadow harbor zircon`;
  const ranked = rankRecallCandidates(
    query,
    [
      { id: "common", content: `${shared} crimson spruce coral birch cypress`, entities: [] },
      { id: "distinctive", content: "violet copper quartz willow fern almond", entities: [] },
    ],
    {
      corpusSize: 64,
      docs: (term) =>
        "cobalt kestrel lantern willow fern almond".split(" ").includes(term) ? 50 : 1,
    },
  );
  assert.deepEqual(
    ranked.filter((m) => m.passes).map((m) => m.fact.id),
    ["distinctive"],
  );
});
