/**
 * Cursor account usage from its dashboard API, read with the saved CLI or
 * Keychain login. The dashboard covers CLI, desktop and headless usage from
 * every machine on the account.
 *
 * @module provider-cursor/server/accountUsage
 */
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as CursorKeychain from "./CursorKeychain.ts";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Maps Cursor's tiered names (`cursor-grok-4.6-high-fast`,
 * `claude-fable-5-1-thinking-high`) to the base model's rate-table key.
 * Grok resolves through xAI's first-party entry, which has no bare alias.
 */
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

/** Why a dashboard read was abandoned; the caller only sees the generic message. */
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

const accountHash = Effect.fn("accountHash")(function* (value: string) {
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(yield* crypto.digest("SHA-256", textEncoder.encode(value)));
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

/** Find the longest exact suffix/prefix overlap in linear time. */
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

const DASHBOARD_USAGE_URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";

/** The session cookie must never follow a redirect off cursor.com. */
const NO_REDIRECT: RequestInit = { redirect: "error" };

/**
 * Dashboard usage includes headless agents and reports fresh input separately
 * from cache reads. `keychainToken` is only run for a Keychain login.
 */
export const readCursorAccountUsage = Effect.fn("readCursorAccountUsage")(function* (
  credentialSource: string | { readonly kind: "keychain" },
  sinceMs: number,
  endDate: number,
  keychainToken: Effect.Effect<
    string | null,
    | CursorKeychain.CursorKeychainTimeoutError
    | CursorKeychain.CursorKeychainReadError
    | CursorAccountUsageInvalidError
  > = invalid("No Keychain reader"),
): Effect.fn.Return<
  CursorAccountUsageReadResult,
  never,
  FileSystem.FileSystem | Crypto.Crypto | HttpClient.HttpClient
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const credential = yield* Effect.result<
    unknown,
    | PlatformError.PlatformError
    | Schema.SchemaError
    | CursorKeychain.CursorKeychainTimeoutError
    | CursorKeychain.CursorKeychainReadError
    | CursorAccountUsageInvalidError,
    never
  >(
    typeof credentialSource === "string"
      ? fileSystem.readFileString(credentialSource).pipe(
          Effect.flatMap(decodeJson),
          Effect.map((credentials) => object(credentials).accessToken),
        )
      : keychainToken,
  );
  if (Result.isFailure(credential)) {
    const cause = credential.failure;
    const missing =
      typeof credentialSource === "string" &&
      PlatformError.isPlatformError(cause) &&
      cause.reason._tag === "NotFound";
    return {
      accountKey: null,
      records: [],
      missing,
      error: missing
        ? null
        : typeof credentialSource === "string"
          ? "Cursor credentials could not be read."
          : CursorKeychain.isCursorKeychainTimeoutError(cause)
            ? "Allow Keychain access on the Mac running T3 Code, then refresh."
            : "Cursor Keychain credentials could not be read.",
    };
  }
  const accessToken = credential.success;
  if (typeof accessToken !== "string" || !accessToken) {
    return {
      accountKey: null,
      records: [],
      missing: true,
      error:
        typeof credentialSource === "string"
          ? null
          : "Cursor account history needs a macOS Keychain CLI login on this server.",
    };
  }
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
    accountKey = yield* accountHash(subject);
    if (!Number.isFinite(sinceMs) || !Number.isFinite(endDate) || sinceMs < 0 || sinceMs > endDate)
      return yield* invalid("Invalid date window");
    const records: UsageRecord[] = [];
    const occurrences = new Map<string, number>();
    const pages: unknown[][] = [];
    let completed = false;
    const pageSize = 1000;
    let total: number | undefined;
    const readPage = (page: number) =>
      Effect.gen(function* () {
        // A count can include overlapping page boundaries. Allow room to
        // reconcile them without imposing a fixed account-size limit.
        if (page > (total === undefined ? 1000 : Math.ceil(total / pageSize) * 2 + 1)) {
          return yield* invalid("Account usage page limit exceeded");
        }
        const response = yield* httpClient
          .execute(
            HttpClientRequest.post(DASHBOARD_USAGE_URL).pipe(
              HttpClientRequest.setHeaders({
                Origin: "https://cursor.com",
                Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${accessToken}`)}`,
              }),
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
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(10),
          orElse: () => invalid("Account usage request timed out"),
        }),
      );
    // Cursor caps a page at 1,000 events and takes about a second to answer one, so the pages
    // the first one's count implies are requested up to six ahead and consumed in page order.
    // Pages still in flight when the read ends are interrupted with its scope.
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
      // A rejected login comes back as the finished result instead of a page.
      if (!Array.isArray(events)) return events;
      pages.push(events);
      if (events.length < pageSize) {
        completed = true;
        break;
      }
    }
    if (!completed) return yield* invalid("Account usage page limit exceeded");
    const rawCount = pages.reduce((sum, page) => sum + page.length, 0);
    if (total !== undefined && rawCount < total)
      return yield* invalid("Incomplete account usage pages");
    let removalsRemaining = total === undefined ? 0 : rawCount - total;
    let previousKeys: string[] = [];
    for (const events of pages) {
      const eventKeys =
        removalsRemaining > 0
          ? yield* Effect.forEach(events, (event) => accountHash(canonicalJson(event)))
          : [];
      const removalCount = Math.min(removalsRemaining, boundaryOverlap(previousKeys, eventKeys));
      removalsRemaining -= removalCount;
      previousKeys = eventKeys;
      for (const raw of events.slice(removalCount)) {
        const event = object(raw);
        const usage = object(event.tokenUsage);
        if (event.tokenUsage === undefined || event.tokenUsage === null) continue;
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
        if (timestampMs < sinceMs || timestampMs > endDate) continue;
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
        const occurrence = occurrences.get(key) ?? 0;
        occurrences.set(key, occurrence + 1);
        records.push({
          provider: "cursor",
          timestampMs,
          model: event.model,
          rateModel: cursorRateModel(event.model),
          sessionId,
          totals,
          reportedCostUsd,
          speed: "standard",
          dedupeKey: `cursor-account:${accountKey}:${key}:${occurrence}`,
        });
      }
      yield* Effect.yieldNow;
    }
    if (removalsRemaining !== 0) return yield* invalid("Inconsistent account usage boundaries");
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
    Effect.catch(() =>
      Effect.succeed({
        accountKey,
        records: [],
        missing: false,
        error: "Cursor account usage could not be read.",
      } satisfies CursorAccountUsageReadResult),
    ),
  );
});
