import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { CursorCredentialSource } from "./accountCache.ts";
import { DEFAULT_CURSOR_API_ENDPOINT, exchangeCursorApiKey } from "./apiKey.ts";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

// Grok's xAI first-party rate entry has no bare alias.
export function cursorRateModel(model: string): string {
  const base = model
    .replace(/^cursor-/, "")
    .replace(/(?:-thinking)?(?:-(?:none|minimal|low|medium|high|xhigh|max))?(?:-fast)?$/, "");
  return base.startsWith("grok-") ? `xai/${base}` : base;
}

export interface CursorAccountUsageReadResult {
  readonly accountKey: string | null;
  readonly records: readonly UsageRecord[];
  readonly missing: boolean;
  readonly error: string | null;
}

class CursorAccountUsageInvalidError extends Schema.TaggedError<CursorAccountUsageInvalidError>()(
  "CursorAccountUsageInvalidError",
  { reason: Schema.String },
) {}

const invalid = (reason: string) => Effect.fail(new CursorAccountUsageInvalidError({ reason }));

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const pageRequestBody = (page: number, pageSize: number, sinceMs: number, endDate: number) =>
  JSON.stringify({ page, pageSize, startDate: String(sinceMs), endDate: String(endDate) });

const billedEventIdentity = (...fields: readonly unknown[]) => JSON.stringify(fields);

const textEncoder = new TextEncoder();

/**
 * The account identity of a Cursor user id (the last `|` segment of the token
 * subject): SHA-256 hex of the id. The server's dashboard CSV export source
 * derives the same key, so both fingerprint one account identically.
 */
const cursorAccountKey = Effect.fnUntraced(function* (userId: string) {
  const digest = yield* Digest.Digest;
  return yield* digest.digestHex(Digest.sha256, textEncoder.encode(userId));
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function boundaryOverlap(previous: readonly string[], current: readonly string[]): number {
  const sequence = [...current, "", ...previous];
  const lengths = Array.from({ length: sequence.length }, () => 0);
  for (let index = 1; index < sequence.length; index++) {
    let length = lengths[index - 1]!;
    while (length > 0 && sequence[index] !== sequence[length]) length = lengths[length - 1]!;
    if (sequence[index] === sequence[length]) length++;
    lengths[index] = length;
  }
  return lengths.at(-1) ?? 0;
}

/** Never forward the access token through a redirect. */
const NO_REDIRECT: RequestInit = { redirect: "error" };

export const readCursorAccountUsage = Effect.fn("readCursorAccountUsage")(function* (
  credentialSource: CursorCredentialSource,
  sinceMs: number,
  endDate: number,
): Effect.fn.Return<CursorAccountUsageReadResult, never, Digest.Digest | HttpClient.HttpClient> {
  const httpClient = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;
  // Per-event hashes share the scan span and use the native hex encoder.
  const accountHash = (value: string) => digest.digestHex(Digest.sha256, textEncoder.encode(value));
  const credential = yield* Effect.result(exchangeCursorApiKey(credentialSource.apiKey));
  if (Result.isFailure(credential)) {
    return {
      accountKey: null,
      records: [],
      missing: false,
      error: "Cursor account usage could not be read.",
    };
  }
  const accessToken = credential.success;
  let accountKey: string | null = null;
  const read = Effect.gen(function* () {
    const payload = Base64Url.decodeString(accessToken.split(".")[1] ?? "");
    if (Result.isFailure(payload)) return yield* invalid("Invalid authentication");
    const subject = object(
      yield* decodeJson(payload.success).pipe(
        Effect.catch(() => invalid("Invalid authentication")),
      ),
    ).sub;
    if (typeof subject !== "string" || !subject) return yield* invalid("Invalid authentication");
    const userId = subject.split("|").at(-1);
    if (!userId) return yield* invalid("Invalid authentication");
    accountKey = yield* cursorAccountKey(userId);
    if (!Number.isFinite(sinceMs) || !Number.isFinite(endDate) || sinceMs < 0 || sinceMs > endDate)
      return yield* invalid("Invalid date window");
    const pageRequest = HttpClientRequest.post(
      `${DEFAULT_CURSOR_API_ENDPOINT}/aiserver.v1.DashboardService/GetFilteredUsageEvents`,
    ).pipe(
      HttpClientRequest.bearerToken(accessToken),
      HttpClientRequest.setHeader("connect-protocol-version", "1"),
    );
    const records: UsageRecord[] = [];
    const occurrences = new Map<string, number>();
    const normalized: Array<(Omit<UsageRecord, "dedupeKey"> & { dedupeKey: string }) | null> = [];
    const pages: Array<{ start: number; end: number; overlap: number }> = [];
    let previousEvents: unknown[] = [];
    const pageSize = 1000;
    let total: number | undefined;
    const readPage = Effect.fn("CursorAccountUsage.readPage")(
      function* (page: number) {
        // A count can include overlapping page boundaries. Allow room to
        // reconcile them without imposing a fixed account-size limit.
        if (page > (total === undefined ? 1000 : Math.ceil(total / pageSize) * 2 + 1)) {
          return yield* invalid("Account usage page limit exceeded");
        }
        const response = yield* httpClient
          .execute(
            pageRequest.pipe(
              HttpClientRequest.bodyText(
                pageRequestBody(page, pageSize, sinceMs, endDate),
                "application/json",
              ),
            ),
          )
          .pipe(
            Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
            Effect.mapError(
              () => new CursorAccountUsageInvalidError({ reason: "Account usage request failed" }),
            ),
          );
        if (response.status === 401 || response.status === 403) {
          return {
            accountKey,
            records: [],
            missing: false,
            error: "Sign in to Cursor again to read account usage.",
          } satisfies CursorAccountUsageReadResult;
        }
        if (response.status < 200 || response.status >= 300)
          return yield* invalid("Account usage request failed");
        const parsed: unknown = yield* response.json.pipe(
          Effect.mapError(
            () => new CursorAccountUsageInvalidError({ reason: "Invalid account usage page" }),
          ),
        );
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return yield* invalid("Invalid account usage page");
        }
        const body = object(parsed);
        const keys = Object.keys(body);
        if ("error" in body || "message" in body || "code" in body)
          return yield* invalid("Account usage error response");
        const count = keys.length === 0 ? 0 : body.totalUsageEventsCount;
        const events =
          keys.length === 0 || (keys.length === 1 && keys[0] === "totalUsageEventsCount")
            ? []
            : body.usageEventsDisplay;
        if (
          (count !== undefined &&
            (typeof count !== "number" ||
              !Number.isSafeInteger(count) ||
              count < 0 ||
              (total !== undefined && count !== total))) ||
          !Array.isArray(events) ||
          events.length > pageSize ||
          (count === undefined && !Array.isArray(body.usageEventsDisplay))
        ) {
          return yield* invalid("Inconsistent account usage page");
        }
        if (typeof count === "number") total = count;
        return events as unknown[];
      },
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () => invalid("Account usage request timed out"),
      }),
    );
    // Cursor caps a page at 1,000 events and takes about a second to answer one, so the pages
    // the first one's count implies are requested up to six ahead and consumed in page order.
    const ahead: Fiber.Fiber<
      Effect.Success<ReturnType<typeof readPage>>,
      CursorAccountUsageInvalidError
    >[] = [];
    for (let page = 1; ; page++) {
      while (ahead.length < Math.min(6, Math.ceil((total ?? 0) / pageSize) - page + 1)) {
        ahead.push(yield* Effect.forkScoped(readPage(page + ahead.length)));
      }
      const next = ahead.shift();
      const events = yield* next === undefined ? readPage(page) : Fiber.join(next);
      if (!Array.isArray(events)) return events;
      const start = normalized.length;
      const firstTimestamp = object(events[0]).timestamp;
      // Equal raw events must have equal timestamps; avoid canonicalizing disjoint pages.
      const mayOverlap =
        (typeof firstTimestamp !== "string" && typeof firstTimestamp !== "number") ||
        previousEvents.some((event) => object(event).timestamp === firstTimestamp);
      const overlap = mayOverlap
        ? boundaryOverlap(previousEvents.map(canonicalJson), events.map(canonicalJson))
        : 0;
      previousEvents = events;
      for (const raw of events) {
        const event = object(raw);
        const usage = object(event.tokenUsage);
        if (event.tokenUsage === undefined || event.tokenUsage === null) {
          normalized.push(null);
          continue;
        }
        for (const key of [
          "inputTokens",
          "outputTokens",
          "cacheReadTokens",
          "cacheWriteTokens",
          "totalCents",
        ]) {
          const value = usage[key];
          if (
            value !== undefined &&
            (typeof value !== "number" || !Number.isFinite(value) || value < 0)
          ) {
            return yield* invalid("Invalid account usage totals");
          }
        }
        const timestampMs =
          typeof event.timestamp === "string" && event.timestamp.trim() !== ""
            ? Number(event.timestamp)
            : event.timestamp;
        if (
          typeof timestampMs !== "number" ||
          !Number.isFinite(timestampMs) ||
          typeof event.model !== "string" ||
          !event.model
        )
          return yield* invalid("Invalid account usage event");
        if (timestampMs < sinceMs || timestampMs > endDate) {
          normalized.push(null);
          continue;
        }
        const totals = {
          uncachedInputTokens: tokens(usage.inputTokens),
          cachedInputTokens: tokens(usage.cacheReadTokens),
          cacheCreationTokens: tokens(usage.cacheWriteTokens),
          outputTokens: tokens(usage.outputTokens),
          reasoningTokens: 0,
        };
        const reportedCostUsd =
          typeof usage.totalCents === "number" ? usage.totalCents / 100 : null;
        const sessionId = typeof event.conversationId === "string" ? event.conversationId : "";
        // No event ID is provided. Preserve identical billed rows with an occurrence index.
        const key = yield* accountHash(
          billedEventIdentity(timestampMs, event.model, sessionId, totals, reportedCostUsd),
        );
        normalized.push({
          provider: "cursor",
          timestampMs,
          model: event.model,
          rateModel: cursorRateModel(event.model),
          sessionId,
          totals,
          reportedCostUsd,
          speed: "standard",
          // Account events are one billed call each.
          recordCount: 1,
          dedupeKey: key,
        });
      }
      pages.push({ start, end: normalized.length, overlap });
      if (events.length < pageSize) break;
      yield* Effect.yieldNow;
    }
    const rawCount = normalized.length;
    if (total !== undefined && rawCount < total)
      return yield* invalid("Incomplete account usage pages");
    let removalsRemaining = total === undefined ? 0 : rawCount - total;
    // The final count proves which boundary copies to remove, including non-token events.
    for (const page of pages) {
      const removalCount = Math.min(removalsRemaining, page.overlap);
      removalsRemaining -= removalCount;
      for (let index = page.start; index < page.end; index++) {
        const record = normalized[index];
        normalized[index] = null;
        if (index < page.start + removalCount || record == null) continue;
        const key = record.dedupeKey;
        const occurrence = occurrences.get(key) ?? 0;
        occurrences.set(key, occurrence + 1);
        record.dedupeKey = `cursor-account:${accountKey}:${key}:${occurrence}`;
        records.push(record);
      }
      yield* Effect.yieldNow;
    }
    if (removalsRemaining !== 0) return yield* invalid("Inconsistent account usage boundaries");
    yield* Effect.annotateCurrentSpan({
      "cursor.usage.pages": pages.length,
      "cursor.usage.events": rawCount,
      "cursor.usage.records": records.length,
    });
    return {
      accountKey,
      records,
      missing: false,
      error: null,
    } satisfies CursorAccountUsageReadResult;
  });
  return yield* read.pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: Duration.seconds(60),
      orElse: () => invalid("Account usage read timed out"),
    }),
    Effect.orElseSucceed(
      () =>
        ({
          accountKey,
          records: [],
          missing: false,
          error: "Cursor account usage could not be read.",
        }) satisfies CursorAccountUsageReadResult,
    ),
  );
});
