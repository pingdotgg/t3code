#!/usr/bin/env bun
/**
 * Round-robin cleanup of leftover API Gateway REST APIs in the current
 * account/region. Companion to {@link ./cleanup-apigateway-rest-apis.sh},
 * which iterates one API to completion before moving on; this version
 * pulls IDs from a shared queue and re-queues anything throttled, so a
 * single stubborn API never blocks the others.
 *
 * Usage:
 *   bun scripts/cleanup-apigateway-rest-apis.ts          # name CONTAINS "Ag"
 *   FILTER_QUERY="..." bun scripts/cleanup-apigateway-rest-apis.ts
 *   SPACING_MS=35000 bun scripts/cleanup-apigateway-rest-apis.ts
 *
 * Environment:
 *   FILTER_QUERY   JMESPath for `aws apigateway get-rest-apis --query`
 *                  (default: items[?contains(name, `Ag`)].id)
 *   SPACING_MS     Minimum delay between any two delete attempts.
 *                  Default 35000 — AWS DeleteRestApi is 1 request per 30s
 *                  account-wide, so we wait just over the window.
 *   AWS_PROFILE    Standard AWS CLI variable.
 *   AWS_REGION     Standard AWS CLI variable.
 */
import { execFileSync } from "node:child_process";

type Outcome =
  | { kind: "deleted" }
  | { kind: "throttled" }
  | { kind: "error"; message: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ts = () => new Date().toISOString();

const FILTER_QUERY =
  process.env.FILTER_QUERY ?? "items[?contains(name, `Ag`)].id";
const SPACING_MS = Number(process.env.SPACING_MS ?? 35_000);

const listApis = (): string[] => {
  const out = execFileSync(
    "aws",
    [
      "apigateway",
      "get-rest-apis",
      "--query",
      FILTER_QUERY,
      "--output",
      "text",
    ],
    { encoding: "utf8" },
  );
  return out
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
};

const tryDelete = (id: string): Outcome => {
  try {
    execFileSync(
      "aws",
      ["apigateway", "delete-rest-api", "--rest-api-id", id],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // Let this script own retry/backoff; SDK retries waste tokens.
          AWS_MAX_ATTEMPTS: "1",
          AWS_RETRY_MODE: "standard",
        },
      },
    );
    return { kind: "deleted" };
  } catch (e: any) {
    const msg = String(e.stderr ?? e.message ?? e);
    if (msg.includes("TooManyRequests") || msg.includes("Throttling")) {
      return { kind: "throttled" };
    }
    if (msg.includes("NotFoundException") || msg.includes("does not exist")) {
      return { kind: "deleted" };
    }
    return { kind: "error", message: msg.split("\n").slice(0, 2).join(" ") };
  }
};

const main = async () => {
  const ids = listApis();
  console.log(
    `${ts()} found ${ids.length} REST APIs to delete (filter: ${FILTER_QUERY})`,
  );

  const queue = [...ids];
  let deleted = 0;
  let lastAttemptAt = 0;

  while (queue.length > 0) {
    const wait = SPACING_MS - (Date.now() - lastAttemptAt);
    if (wait > 0) {
      await sleep(wait);
    }
    const id = queue.shift()!;
    lastAttemptAt = Date.now();
    const res = tryDelete(id);
    if (res.kind === "deleted") {
      deleted += 1;
      console.log(
        `${ts()} deleted ${id} (${deleted}/${ids.length}, ${queue.length} left)`,
      );
    } else if (res.kind === "throttled") {
      // Push to the back of the queue; the next attempt will go to a
      // different ID. This drains the throttle bucket evenly across the
      // remaining APIs instead of stalling on a single one.
      queue.push(id);
      console.error(
        `${ts()} throttled ${id} — requeued (${queue.length} left)`,
      );
    } else {
      console.error(`${ts()} error ${id}: ${res.message}`);
    }
  }

  console.log(`${ts()} done — deleted ${deleted}/${ids.length}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
