import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Runtime, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationEventRepository } from "../Services/OrchestrationEvents";
import { makeSqliteOrchestrationEventRepositoryLive } from "./OrchestrationEvents";

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
    const runtime = Runtime.defaultRuntime;
    const createdAt = new Date().toISOString();

    const firstRuntime = ManagedRuntime.make(makeSqliteOrchestrationEventRepositoryLive(dbPath));
    const first = await firstRuntime.runPromise(OrchestrationEventRepository);
    const saved = await Runtime.runPromise(runtime)(
      first.append({
        eventId: "event-1",
        type: "project.created",
        aggregateType: "project",
        aggregateId: "project-1",
        occurredAt: createdAt,
        commandId: "cmd-1",
        payload: { id: "project-1", name: "demo" },
      }),
    );
    expect(saved.sequence).toBe(1);
    await firstRuntime.dispose();

    const secondRuntime = ManagedRuntime.make(makeSqliteOrchestrationEventRepositoryLive(dbPath));
    const second = await secondRuntime.runPromise(OrchestrationEventRepository);
    const replayed = await Runtime.runPromise(runtime)(second.readFromSequence(0));
    expect(replayed).toEqual([saved]);
    await secondRuntime.dispose();
  });

  it("creates and reuses the migrator tracking table", async () => {
    const stateDir = makeTempDir("t3code-event-store-migrations-");
    const dbPath = path.join(stateDir, "orchestration.sqlite");
    const runtime = Runtime.defaultRuntime;

    const firstRuntime = ManagedRuntime.make(makeSqliteOrchestrationEventRepositoryLive(dbPath));
    const first = await firstRuntime.runPromise(OrchestrationEventRepository);
    await Runtime.runPromise(runtime)(first.readAll());
    await firstRuntime.dispose();

    const secondRuntime = ManagedRuntime.make(makeSqliteOrchestrationEventRepositoryLive(dbPath));
    const second = await secondRuntime.runPromise(OrchestrationEventRepository);
    await Runtime.runPromise(runtime)(second.readAll());
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
    if (!tableRow) {
      throw new Error("Expected migrations table to exist");
    }

    const migrationRows = db
      .prepare(
        `
          SELECT *
          FROM ${tableRow.name}
        `,
      )
      .all() as Array<Record<string, unknown>>;
    expect(migrationRows).toHaveLength(1);
    expect(Object.values(migrationRows[0] ?? {}).length).toBeGreaterThan(0);
    db.close();
  });
});
