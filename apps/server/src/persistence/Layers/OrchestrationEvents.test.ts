import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {  ManagedRuntime, Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationEventRepository } from "../Services/OrchestrationEvents.ts";
import { makeSqliteOrchestrationEventRepositoryLive } from "./OrchestrationEvents.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("OrchestrationEventRepository", () => {
  it("persists and replays events across restarts", async () => {
    const stateDir = makeTempDir("t3code-event-store-");
    const dbPath = path.join(stateDir, "orchestration.sqlite");

    const createdAt = new Date().toISOString();

    const firstRuntime = ManagedRuntime.make(makeSqliteOrchestrationEventRepositoryLive(dbPath));
    const first = await firstRuntime.runPromise(Effect.service(OrchestrationEventRepository));
    const saved = await firstRuntime.runPromise(
      first.append({
        eventId: "event-1",
        type: "thread.created",
        aggregateType: "thread",
        aggregateId: "thread-1",
        occurredAt: createdAt,
        commandId: "cmd-1",
        payload: { id: "thread-1", projectId: "project-1", title: "demo" },
      }),
    );
    expect(saved.sequence).toBe(1);
    await firstRuntime.dispose();

    const secondRuntime = ManagedRuntime.make(makeSqliteOrchestrationEventRepositoryLive(dbPath));
    const second = await secondRuntime.runPromise(Effect.service(OrchestrationEventRepository));
    const replayed = await secondRuntime.runPromise(second.readFromSequence(0));
    expect(replayed).toEqual([saved]);
    await secondRuntime.dispose();
  });

  it("creates and reuses the migrator tracking table", async () => {
    const stateDir = makeTempDir("t3code-event-store-migrations-");
    const dbPath = path.join(stateDir, "orchestration.sqlite");


    const firstRuntime = ManagedRuntime.make(makeSqliteOrchestrationEventRepositoryLive(dbPath));
    const first = await firstRuntime.runPromise(Effect.service(OrchestrationEventRepository));
    await firstRuntime.runPromise(first.readAll());
    await firstRuntime.dispose();

    const secondRuntime = ManagedRuntime.make(makeSqliteOrchestrationEventRepositoryLive(dbPath));
    const second = await secondRuntime.runPromise(Effect.service(OrchestrationEventRepository));
    await secondRuntime.runPromise(second.readAll());
    await secondRuntime.dispose();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tableRow = db
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name IN ('effect_sql_migrations', 'orchestration_sql_migrations')
          ORDER BY name ASC
        `,
      )
      .get() as { name: string } | undefined;
    expect(tableRow?.name).toBeDefined();
    expect(tableRow).toBeDefined();
    if (!tableRow) return;

    const migrationRows = db
      .prepare(
        `
          SELECT *
          FROM ${tableRow.name}
        `,
      )
      .all() as Array<Record<string, unknown>>;
    expect(migrationRows.length).toBeGreaterThanOrEqual(1);
    expect(Object.values(migrationRows[0] ?? {}).length).toBeGreaterThan(0);
    db.close();
  });
});
