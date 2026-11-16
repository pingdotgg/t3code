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

const facts = [ledger, remaining];

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
      name: "pull request watch names the fact",
      message: {
        text: "Checks failed for the ledger labs toggle.",
        notification: { source: { kind: "monitor" } },
      },
      ids: ["ledger-labs"],
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
