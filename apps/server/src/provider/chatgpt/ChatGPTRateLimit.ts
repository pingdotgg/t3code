// Persistent admission is transactional across provider rebuilds and processes.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";
import * as DateTime from "effect/DateTime";

export interface ChatGPTLimits {
  readonly minimumIntervalSeconds: number;
  readonly requestsPerHour: number;
  readonly requestsPerDay: number;
  readonly cooldownMinutes: number;
}

export class ChatGPTRateLimit {
  private readonly db: NodeSqlite.DatabaseSync;
  private readonly limits: ChatGPTLimits;

  constructor(path: string, limits: ChatGPTLimits) {
    this.limits = limits;
    this.db = new NodeSqlite.DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS attempts (at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS attempts_at ON attempts(at);
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), blocked_until INTEGER NOT NULL);
      INSERT OR IGNORE INTO state VALUES (1, 0);`);
  }

  /** Reserve before sending. Failed/cancelled sends still count conservatively. */
  reserve(now: number): { readonly waitMs: number } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM attempts WHERE at <= ?").run(now - 86_400_000);
      const blocked = this.db.prepare("SELECT blocked_until FROM state WHERE id=1").get();
      const until = Number(blocked?.blocked_until ?? 0);
      if (until > now)
        throw new Error(
          `ChatGPT cooldown until ${DateTime.formatIso(DateTime.makeUnsafe(until))}.`,
        );
      const rows = this.db.prepare("SELECT at FROM attempts ORDER BY at").all();
      const day = rows.map((row) => Number(row.at));
      const hour = day.filter((at) => at > now - 3_600_000);
      if (day.length >= this.limits.requestsPerDay || hour.length >= this.limits.requestsPerHour) {
        const reset = Math.max(
          day.length >= this.limits.requestsPerDay
            ? day[day.length - this.limits.requestsPerDay]! + 86_400_000
            : 0,
          hour.length >= this.limits.requestsPerHour
            ? hour[hour.length - this.limits.requestsPerHour]! + 3_600_000
            : 0,
        );
        throw new Error(
          `ChatGPT request limit reached. Next request after ${DateTime.formatIso(DateTime.makeUnsafe(reset))}. Edit limits in provider settings.`,
        );
      }
      const last = day.at(-1);
      const waitMs =
        last === undefined
          ? 0
          : Math.max(0, last + this.limits.minimumIntervalSeconds * 1000 - now);
      if (waitMs === 0) this.db.prepare("INSERT INTO attempts VALUES (?)").run(now);
      this.db.exec("COMMIT");
      return { waitMs };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  block(now: number) {
    this.db
      .prepare("UPDATE state SET blocked_until = MAX(blocked_until, ?) WHERE id=1")
      .run(now + this.limits.cooldownMinutes * 60_000);
  }

  close() {
    this.db.close();
  }
}
