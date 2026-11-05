import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { CursorCredentialSource } from "./accountCache.ts";
import { DEFAULT_CURSOR_API_ENDPOINT, exchangeCursorApiKey } from "./apiKey.ts";
import * as CursorKeychain from "./CursorKeychain.ts";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Cursor reports token counts as decimal strings; a missing meter counts as zero. */
function tokenCount(value: unknown): number | null {
  if (value === undefined) return 0;
  const count = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null;
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

class CursorAccountUsageSignInError extends Schema.TaggedError<CursorAccountUsageSignInError>()(
  "CursorAccountUsageSignInError",
  {},
) {}

const invalid = (reason: string) => Effect.fail(new CursorAccountUsageInvalidError({ reason }));

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const pageRequestBody = (page: number, pageSize: number, sinceMs: number, endDate: number) =>
  JSON.stringify({ page, pageSize, startDate: String(sinceMs), endDate: String(endDate) });

const billedEventIdentity = (...fields: readonly unknown[]) => JSON.stringify(fields);

const textEncoder = new TextEncoder();

const accountHash = Effect.fn("accountHash")(function* (value: string) {
  const digest = yield* Digest.Digest;
  return Hex.encode(yield* digest.digest(Digest.sha256, textEncoder.encode(value)));
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

const BILLING_ITEMS_URL = "https://cursor.com/api/dashboard/v2/query-billing-items";
const FILTERED_USAGE_RPC_URL = `${DEFAULT_CURSOR_API_ENDPOINT}/aiserver.v1.DashboardService/GetFilteredUsageEvents`;
const PAGE_SIZE = 1000;
/** Cursor's previous usage endpoint answered 400 above 1,000 items; this one's cap is unpublished. */
const FALLBACK_PAGE_SIZE = 100;
/** A busy account bills tens of thousands of items a month, read as day slices six at a time. */
const SLICE_MS = 24 * 60 * 60 * 1000;
const CONCURRENT_SLICES = 6;
const PAGE_TIMEOUT = Duration.seconds(10);

/** The session cookie must never follow a redirect off cursor.com. */
const NO_REDIRECT: RequestInit = { redirect: "error" };

const readTimeoutForSlices = (sinceMs: number, endDate: number) => {
  const sliceCount = Math.max(1, Math.ceil((endDate - sinceMs) / SLICE_MS));
  const rounds = Math.ceil(sliceCount / CONCURRENT_SLICES);
  // Each round can spend one page timeout per concurrent slice chain; keep a 60s floor.
  return Duration.seconds(Math.max(60, rounds * 15));
};

export const readCursorAccountUsage = Effect.fn("readCursorAccountUsage")(function* (
  credentialSource: CursorCredentialSource,
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
  FileSystem.FileSystem | Digest.Digest | HttpClient.HttpClient
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
      : credentialSource.kind === "apiKey"
        ? exchangeCursorApiKey(credentialSource.apiKey).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.mapError(
              () => new CursorAccountUsageInvalidError({ reason: "Invalid API key" }),
            ),
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
          : credentialSource.kind === "apiKey"
            ? "Cursor account usage could not be read."
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
  const useBillingItems =
    typeof credentialSource === "string" || credentialSource.kind === "keychain";
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
    if (
      Option.isNone(DateTime.make(sinceMs)) ||
      Option.isNone(DateTime.make(endDate)) ||
      sinceMs < 0 ||
      sinceMs > endDate
    )
      return yield* invalid("Invalid date window");

    if (useBillingItems) {
      return yield* readBillingItemsHistory({
        httpClient,
        accessToken,
        userId,
        accountKey,
        sinceMs,
        endDate,
      });
    }

    return yield* readFilteredUsageEventsHistory({
      httpClient,
      accessToken,
      accountKey,
      sinceMs,
      endDate,
    });
  });
  return yield* read.pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: useBillingItems ? readTimeoutForSlices(sinceMs, endDate) : Duration.seconds(60),
      orElse: () => invalid("Account usage read timed out"),
    }),
    Effect.catchTags({
      CursorAccountUsageSignInError: () =>
        Effect.succeed({
          accountKey,
          records: [],
          missing: false,
          error: "Sign in to Cursor again to read account usage.",
        } satisfies CursorAccountUsageReadResult),
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

const readBillingItemsHistory = Effect.fn("CursorAccountUsage.readBillingItemsHistory")(
  function* (input: {
    readonly httpClient: HttpClient.HttpClient;
    readonly accessToken: string;
    readonly userId: string;
    readonly accountKey: string;
    readonly sinceMs: number;
    readonly endDate: number;
  }) {
    const { httpClient, accessToken, userId, accountKey, sinceMs, endDate } = input;
    const readPage = Effect.fn("CursorAccountUsage.readBillingPage")(
      function* (startMs: number, endMs: number, pageSize: number, cursor: string | undefined) {
        const response = yield* httpClient
          .execute(
            HttpClientRequest.get(BILLING_ITEMS_URL, {
              urlParams: {
                scope: "user",
                startTime: DateTime.formatIso(DateTime.makeUnsafe(startMs)),
                endTime: DateTime.formatIso(DateTime.makeUnsafe(endMs)),
                pageSize,
                ...(cursor === undefined ? {} : { cursor }),
              },
            }).pipe(
              HttpClientRequest.setHeaders({
                Origin: "https://cursor.com",
                Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${accessToken}`)}`,
              }),
            ),
          )
          .pipe(
            Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
            Effect.mapError(
              () => new CursorAccountUsageInvalidError({ reason: "Account usage request failed" }),
            ),
          );
        if (response.status === 401 || response.status === 403)
          return yield* new CursorAccountUsageSignInError();
        if (response.status === 400 && cursor === undefined && pageSize !== FALLBACK_PAGE_SIZE)
          return null;
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
        if ("error" in body || "message" in body || "code" in body)
          return yield* invalid("Account usage error response");
        // Cursor's JSON omits empty fields, so an idle slice answers `{}`.
        const data = Object.keys(body).length === 0 ? [] : body.data;
        const pagination = body.pagination ?? {};
        if (!Array.isArray(data) || typeof pagination !== "object" || Array.isArray(pagination))
          return yield* invalid("Invalid account usage page");
        const nextCursor = object(pagination).nextCursor ?? undefined;
        if (nextCursor !== undefined && (typeof nextCursor !== "string" || !nextCursor))
          return yield* invalid("Invalid account usage page");
        return { items: data as unknown[], nextCursor };
      },
      Effect.timeoutOrElse({
        duration: PAGE_TIMEOUT,
        orElse: () => invalid("Account usage request timed out"),
      }),
    );
    let pageSize = PAGE_SIZE;
    const readSlice = Effect.fn("CursorAccountUsage.readSlice")(function* (startMs: number) {
      const endMs = Math.min(startMs + SLICE_MS, endDate);
      const items: unknown[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const page = yield* readPage(startMs, endMs, pageSize, cursor);
        if (page === null) {
          pageSize = FALLBACK_PAGE_SIZE;
          continue;
        }
        items.push(...page.items);
        cursor = page.nextCursor;
        if (cursor === undefined) return items;
        if (cursors.has(cursor)) return yield* invalid("Account usage pagination loop");
        cursors.add(cursor);
      }
    });
    const sliceStarts: number[] = [];
    for (let startMs = sinceMs; sliceStarts.length === 0 || startMs < endDate; startMs += SLICE_MS)
      sliceStarts.push(startMs);
    const slices = yield* Effect.forEach(sliceStarts, readSlice, {
      concurrency: CONCURRENT_SLICES,
    });
    const records: UsageRecord[] = [];
    const itemIds = new Set<string>();
    for (const items of slices) {
      for (const raw of items) {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw))
          return yield* invalid("Invalid account usage event");
        const item = object(raw);
        if (item.hasTokenMeters === false || item.usage === undefined || item.usage === null)
          continue;
        const usage = item.usage;
        if (typeof usage !== "object" || Array.isArray(usage))
          return yield* invalid("Invalid account usage totals");
        const meters = object(usage);
        const uncachedInputTokens = tokenCount(meters["prompt-text-tokens"]);
        const cachedInputTokens = tokenCount(meters["cached-prompt-text-tokens"]);
        const cacheCreationTokens = tokenCount(meters["cache-write-text-tokens"]);
        const outputTokens = tokenCount(meters["completion-text-tokens"]);
        if (
          uncachedInputTokens === null ||
          cachedInputTokens === null ||
          cacheCreationTokens === null ||
          outputTokens === null
        )
          return yield* invalid("Invalid account usage totals");
        const timestampMs = typeof item.eventTime === "string" ? Date.parse(item.eventTime) : NaN;
        const model = object(item.displayExtras).model;
        const id = item.billingItemId;
        if (
          !Number.isFinite(timestampMs) ||
          typeof model !== "string" ||
          !model ||
          typeof id !== "string" ||
          !id
        )
          return yield* invalid("Invalid account usage event");
        if (timestampMs < sinceMs || timestampMs > endDate || itemIds.has(id)) continue;
        itemIds.add(id);
        const pricing = object(item.pricing);
        const contracted =
          typeof pricing.contracted === "string" ? Number(pricing.contracted) : pricing.contracted;
        records.push({
          provider: "cursor",
          timestampMs,
          model,
          rateModel: cursorRateModel(model),
          sessionId: "",
          totals: {
            uncachedInputTokens,
            cachedInputTokens,
            cacheCreationTokens,
            outputTokens,
            reasoningTokens: 0,
          },
          // Included-plan items are contracted at 0, so price those from the rate table instead.
          reportedCostUsd:
            pricing.currency === "USD" &&
            typeof contracted === "number" &&
            Number.isFinite(contracted) &&
            contracted > 0
              ? contracted
              : null,
          speed: "standard",
          dedupeKey: `cursor-account:${accountKey}:${id}`,
        });
      }
    }
    return {
      accountKey,
      records,
      missing: false,
      error: null,
    } satisfies CursorAccountUsageReadResult;
  },
);

/** API-key tokens are rejected by the web dashboard; Cursor's RPC API still accepts them. */
const readFilteredUsageEventsHistory = Effect.fn(
  "CursorAccountUsage.readFilteredUsageEventsHistory",
)(function* (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly accessToken: string;
  readonly accountKey: string;
  readonly sinceMs: number;
  readonly endDate: number;
}) {
  const { httpClient, accessToken, accountKey, sinceMs, endDate } = input;
  const pageRequest = HttpClientRequest.post(FILTERED_USAGE_RPC_URL).pipe(
    HttpClientRequest.bearerToken(accessToken),
    HttpClientRequest.setHeader("connect-protocol-version", "1"),
  );
  const records: UsageRecord[] = [];
  const occurrences = new Map<string, number>();
  const pages: unknown[][] = [];
  let completed = false;
  const pageSize = 1000;
  let total: number | undefined;
  const readPage = Effect.fn("CursorAccountUsage.readFilteredPage")(
    function* (page: number) {
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
        return yield* new CursorAccountUsageSignInError();
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
      duration: PAGE_TIMEOUT,
      orElse: () => invalid("Account usage request timed out"),
    }),
  );
  const ahead: Fiber.Fiber<
    Effect.Success<ReturnType<typeof readPage>>,
    CursorAccountUsageInvalidError | CursorAccountUsageSignInError
  >[] = [];
  for (let page = 1; ; page++) {
    while (ahead.length < Math.min(6, Math.ceil((total ?? 0) / pageSize) - page + 1)) {
      ahead.push(yield* Effect.forkScoped(readPage(page + ahead.length)));
    }
    const next = ahead.shift();
    const events = yield* next === undefined ? readPage(page) : Fiber.join(next);
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
      const reportedCostUsd = typeof usage.totalCents === "number" ? usage.totalCents / 100 : null;
      const sessionId = typeof event.conversationId === "string" ? event.conversationId : "";
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
