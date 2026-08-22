import { DurableObject } from "cloudflare:workers";

import type { WorkerEnv } from "../alchemy.run.ts";
import { handleRequest } from "./app.ts";
import { resumeCursorStatus, type StoredGitHubEvent } from "./event-log.ts";
import type { GitHubEvent } from "./events.ts";
import { formatSseEvent } from "./sse.ts";

const RETAINED_EVENT_COUNT = 512;
const RETAINED_DELIVERY_COUNT = 10_000;
const RETAINED_PR_HEAD_COUNT = 10_000;
const MAX_SUBSCRIBERS = 64;

interface Subscriber {
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  readonly pullRequestNumber?: number;
  readonly release: () => void;
}

interface SequenceRow extends Record<string, SqlStorageValue> {
  readonly sequence: number;
}

interface PullRequestNumberRow extends Record<string, SqlStorageValue> {
  readonly pullRequestNumber: number;
}

interface EventRow extends SequenceRow {
  readonly eventJson: string;
}

interface BoundsRow extends Record<string, SqlStorageValue> {
  readonly earliestSequence: number | null;
  readonly latestSequence: number | null;
}

function rowsAfter(sql: SqlStorage, sequence: number): Iterator<EventRow> {
  const cursor = sql.exec<EventRow>(
    `SELECT sequence, event_json AS "eventJson"
    FROM github_events
    WHERE sequence > ?
    ORDER BY sequence ASC`,
    sequence,
  );
  return cursor[Symbol.iterator]();
}

export class GitHubEventHub extends DurableObject<WorkerEnv> {
  readonly #encoder = new TextEncoder();
  readonly #subscribers = new Map<number, Subscriber>();
  #nextSubscriberId = 1;
  #streamCount = 0;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS github_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS github_deliveries (
        delivery_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS github_pr_heads (
        head_sha TEXT NOT NULL,
        pull_request_number INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        PRIMARY KEY (head_sha, pull_request_number)
      );
      CREATE INDEX IF NOT EXISTS github_pr_heads_sequence
        ON github_pr_heads (sequence);
      INSERT OR IGNORE INTO github_deliveries (delivery_id, sequence)
        SELECT delivery_id, sequence FROM github_events
    `);
  }

  #publish(event: GitHubEvent): Response {
    const outcome: {
      duplicateSequence: number | null;
      storedEvent: StoredGitHubEvent | null;
    } = { duplicateSequence: null, storedEvent: null };

    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<SequenceRow>(
          "SELECT sequence FROM github_deliveries WHERE delivery_id = ? LIMIT 1",
          event.deliveryId,
        )
        .toArray()[0];
      if (existing) {
        outcome.duplicateSequence = existing.sequence;
        return;
      }

      let normalizedEvent = event;
      if (event.pullRequestNumbers.length === 0 && event.headSha) {
        const associatedNumbers = this.ctx.storage.sql
          .exec<PullRequestNumberRow>(
            `SELECT pull_request_number AS "pullRequestNumber"
            FROM github_pr_heads
            WHERE head_sha = ?
            ORDER BY sequence DESC, pull_request_number ASC
            LIMIT 64`,
            event.headSha,
          )
          .toArray()
          .map(({ pullRequestNumber }) => pullRequestNumber);
        if (associatedNumbers.length > 0) {
          normalizedEvent = {
            ...event,
            pullRequestNumbers: [...new Set(associatedNumbers)],
          };
        }
      }

      const stored = this.ctx.storage.sql
        .exec<SequenceRow>(
          `INSERT INTO github_events (delivery_id, event_json)
          VALUES (?, ?)
          RETURNING sequence`,
          normalizedEvent.deliveryId,
          JSON.stringify(normalizedEvent),
        )
        .toArray()[0]!;
      this.ctx.storage.sql.exec(
        "INSERT INTO github_deliveries (delivery_id, sequence) VALUES (?, ?)",
        normalizedEvent.deliveryId,
        stored.sequence,
      );
      if (normalizedEvent.headSha) {
        for (const pullRequestNumber of normalizedEvent.pullRequestNumbers) {
          this.ctx.storage.sql.exec(
            `INSERT INTO github_pr_heads (head_sha, pull_request_number, sequence)
            VALUES (?, ?, ?)
            ON CONFLICT (head_sha, pull_request_number)
            DO UPDATE SET sequence = excluded.sequence`,
            normalizedEvent.headSha,
            pullRequestNumber,
            stored.sequence,
          );
        }
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM github_events WHERE sequence <= ?",
        stored.sequence - RETAINED_EVENT_COUNT,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM github_deliveries WHERE sequence <= ?",
        stored.sequence - RETAINED_DELIVERY_COUNT,
      );
      this.ctx.storage.sql.exec(
        `DELETE FROM github_pr_heads
        WHERE rowid IN (
          SELECT rowid FROM github_pr_heads
          ORDER BY sequence DESC, head_sha ASC, pull_request_number ASC
          LIMIT -1 OFFSET ?
        )`,
        RETAINED_PR_HEAD_COUNT,
      );
      outcome.storedEvent = { ...normalizedEvent, sequence: stored.sequence };
    });

    if (outcome.duplicateSequence !== null) {
      return Response.json(
        { duplicate: true, sequence: outcome.duplicateSequence },
        { status: 200 },
      );
    }
    if (!outcome.storedEvent) {
      return Response.json({ error: "event was not stored" }, { status: 500 });
    }
    this.#broadcast(outcome.storedEvent);
    return Response.json(
      { duplicate: false, sequence: outcome.storedEvent.sequence },
      { status: 201 },
    );
  }

  #broadcast(event: StoredGitHubEvent): void {
    const encoded = this.#encoder.encode(formatSseEvent(event));
    for (const subscriber of this.#subscribers.values()) {
      if (
        subscriber.pullRequestNumber !== undefined &&
        !event.pullRequestNumbers.includes(subscriber.pullRequestNumber)
      ) {
        continue;
      }
      if ((subscriber.controller.desiredSize ?? 1) <= 0) {
        try {
          subscriber.controller.close();
        } catch {
          // The subscriber already disconnected.
        }
        subscriber.release();
        continue;
      }
      try {
        subscriber.controller.enqueue(encoded);
      } catch {
        subscriber.release();
      }
    }
  }

  #subscribe(url: URL, request: Request): Response {
    const afterValue = url.searchParams.get("after");
    const pullValue = url.searchParams.get("pull");
    const after = afterValue === null ? undefined : Number(afterValue);
    const pullRequestNumber = pullValue === null ? undefined : Number(pullValue);
    if (
      (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) ||
      (pullRequestNumber !== undefined &&
        (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0))
    ) {
      return Response.json({ error: "invalid cursor or pull request number" }, { status: 400 });
    }

    const bounds = this.ctx.storage.sql
      .exec<BoundsRow>(
        `SELECT
          MIN(sequence) AS "earliestSequence",
          MAX(sequence) AS "latestSequence"
        FROM github_events`,
      )
      .toArray()[0];
    const earliestSequence = bounds?.earliestSequence ?? null;
    const latestSequence = bounds?.latestSequence ?? 0;
    const cursorStatus = resumeCursorStatus(earliestSequence, latestSequence, after);
    if (cursorStatus === "expired") {
      return Response.json(
        {
          error: "event cursor expired",
          earliestSequence,
          latestSequence,
        },
        { status: 410 },
      );
    }
    if (cursorStatus === "future") {
      return Response.json(
        {
          error: "event cursor is ahead of the feed",
          earliestSequence,
          latestSequence,
        },
        { status: 409 },
      );
    }
    if (this.#streamCount >= MAX_SUBSCRIBERS) {
      return Response.json({ error: "too many subscribers" }, { status: 503 });
    }

    const subscriberId = this.#nextSubscriberId++;
    this.#streamCount += 1;
    const encoder = this.#encoder;
    const subscribers = this.#subscribers;
    const sql = this.ctx.storage.sql;
    let lastSequence = after ?? 0;
    let rows = rowsAfter(sql, lastSequence);
    let registered = false;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      subscribers.delete(subscriberId);
      this.#streamCount -= 1;
    };

    const registerWhenCaughtUp = (
      controller: ReadableStreamDefaultController<Uint8Array>,
    ): void => {
      if (registered) return;
      if (request.signal.aborted) {
        release();
        return;
      }
      while ((controller.desiredSize ?? 1) > 0) {
        let next = rows.next();
        if (next.done) {
          rows = rowsAfter(sql, lastSequence);
          next = rows.next();
          if (next.done) {
            subscribers.set(subscriberId, {
              controller,
              release,
              ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
            });
            registered = true;
            return;
          }
        }

        const row = next.value;
        lastSequence = row.sequence;
        const event = {
          ...(JSON.parse(row.eventJson) as GitHubEvent),
          sequence: row.sequence,
        };
        if (
          pullRequestNumber === undefined ||
          event.pullRequestNumbers.includes(pullRequestNumber)
        ) {
          controller.enqueue(encoder.encode(formatSseEvent(event)));
        }
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (request.signal.aborted) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode("retry: 5000\n\n"));
        registerWhenCaughtUp(controller);
        request.signal.addEventListener("abort", release, { once: true });
      },
      pull(controller) {
        registerWhenCaughtUp(controller);
      },
      cancel() {
        release();
      },
    });

    return new Response(stream, {
      headers: {
        "cache-control": "no-store, no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream",
        "x-accel-buffering": "no",
      },
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/events") return new Response("not found", { status: 404 });
    if (request.method === "POST") {
      return this.#publish((await request.json()) as GitHubEvent);
    }
    if (request.method === "GET") return this.#subscribe(url, request);
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  }
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
