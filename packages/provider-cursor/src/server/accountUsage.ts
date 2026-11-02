import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as CursorKeychain from "./CursorKeychain.ts";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

const textEncoder = new TextEncoder();

const accountHash = Effect.fn("accountHash")(function* (value: string) {
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(yield* crypto.digest("SHA-256", textEncoder.encode(value)));
});

const BILLING_ITEMS_URL = "https://cursor.com/api/dashboard/v2/query-billing-items";
const PAGE_SIZE = 1000;
/** Cursor's previous usage endpoint answered 400 above 1,000 items; this one's cap is unpublished. */
const FALLBACK_PAGE_SIZE = 100;
/** A busy account bills tens of thousands of items a month, read as day slices six at a time. */
const SLICE_MS = 24 * 60 * 60 * 1000;
const CONCURRENT_SLICES = 6;

/** The session cookie must never follow a redirect off cursor.com. */
const NO_REDIRECT: RequestInit = { redirect: "error" };

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
    if (
      Option.isNone(DateTime.make(sinceMs)) ||
      Option.isNone(DateTime.make(endDate)) ||
      sinceMs < 0 ||
      sinceMs > endDate
    )
      return yield* invalid("Invalid date window");
    const readPage = Effect.fn("CursorAccountUsage.readPage")(
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
        duration: Duration.seconds(10),
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
  });
  return yield* read.pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(60),
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
