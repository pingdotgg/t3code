import type { IsoDateTime } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

const USAGE_LIMIT_MESSAGE =
  /(?:usage|rate) limit|spend cap|model (?:is )?(?:currently )?at capacity|(?:provider|service|server) (?:is )?temporarily unavailable|quota (?:has been )?(?:exceeded|reached|exhausted)|too many requests|\b429\b|resource[_ ]exhausted|insufficient[_ ]quota/i;
const RETRY_AT_CLOCK_TIME =
  /\btry again at\s+(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+)?(\d{1,2}):([0-5]\d)\s*([ap])\.?m\.?\b/i;
const ABSOLUTE_RETRY_KEYS = new Set([
  "resetat",
  "resetsat",
  "reset_at",
  "resets_at",
  "retryat",
  "retry_at",
]);
const HTTP_STATUS_KEYS = new Set(["code", "status", "statuscode", "status_code"]);

export interface ProviderUsageLimit {
  readonly retryAt?: IsoDateTime;
}

export function retryAtFromUsageLimitMessage(
  message: string,
  now = DateTime.nowUnsafe(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): IsoDateTime | undefined {
  const match = RETRY_AT_CLOCK_TIME.exec(message);
  if (match === null) return undefined;
  const hour = Number(match[4]);
  if (hour < 1 || hour > 12) return undefined;
  const zonedNow = DateTime.makeZonedUnsafe(now, { timeZone });
  let retryAt = DateTime.setParts(zonedNow, {
    ...(match[1]
      ? {
          year: Number(match[3]),
          month:
            "jan feb mar apr may jun jul aug sep oct nov dec"
              .split(" ")
              .indexOf(match[1].toLowerCase()) + 1,
          day: Number(match[2]),
        }
      : {}),
    hour: (hour % 12) + (match[6]?.toLowerCase() === "p" ? 12 : 0),
    minute: Number(match[5]),
    second: 0,
    millisecond: 0,
  }).pipe(DateTime.add({ minutes: 1 }));
  if (!match[1] && DateTime.toEpochMillis(retryAt) <= DateTime.toEpochMillis(now)) {
    retryAt = DateTime.add(retryAt, { days: 1 });
  }
  return DateTime.formatIso(retryAt) as IsoDateTime;
}

function isoFromAbsoluteTime(value: unknown): IsoDateTime | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const epochMillis = value < 10_000_000_000 ? value * 1_000 : value;
    return DateTime.formatIso(DateTime.makeUnsafe(epochMillis)) as IsoDateTime;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return Option.match(DateTime.make(value), {
    onNone: () => undefined,
    onSome: (dateTime) => DateTime.formatIso(dateTime) as IsoDateTime,
  });
}

function retryAtFromDetail(value: unknown, depth = 0): IsoDateTime | undefined {
  if (depth > 6 || !Predicate.isObject(value)) {
    return undefined;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (ABSOLUTE_RETRY_KEYS.has(key.toLowerCase())) {
      const retryAt = isoFromAbsoluteTime(entry);
      if (retryAt !== undefined) {
        return retryAt;
      }
    }
  }
  for (const entry of Object.values(value)) {
    const retryAt = retryAtFromDetail(entry, depth + 1);
    if (retryAt !== undefined) {
      return retryAt;
    }
  }
  return undefined;
}

function detailContainsUsageLimit(value: unknown, depth = 0): boolean {
  if (depth > 6) {
    return false;
  }
  if (typeof value === "string") {
    return USAGE_LIMIT_MESSAGE.test(value);
  }
  if (!Predicate.isObject(value)) {
    return false;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      HTTP_STATUS_KEYS.has(key.toLowerCase()) &&
      (entry === 429 || (typeof entry === "string" && entry.trim() === "429"))
    ) {
      return true;
    }
    if (detailContainsUsageLimit(entry, depth + 1)) {
      return true;
    }
  }
  return false;
}

export function providerUsageLimitFromError(input: {
  readonly message: string;
  readonly detail?: unknown;
  readonly retryAt?: IsoDateTime;
}): ProviderUsageLimit | null {
  if (!USAGE_LIMIT_MESSAGE.test(input.message) && !detailContainsUsageLimit(input.detail)) {
    return null;
  }
  const retryAt =
    retryAtFromUsageLimitMessage(input.message) ?? retryAtFromDetail(input.detail) ?? input.retryAt;
  return retryAt === undefined ? {} : { retryAt };
}

export function retryAtFromEpochSeconds(value: number | undefined): IsoDateTime | undefined {
  return value === undefined ? undefined : isoFromAbsoluteTime(value);
}

export function nextUsageLimitRetryAt(input: {
  readonly now: IsoDateTime;
  readonly attempt: number;
  readonly providerRetryAt?: IsoDateTime;
}): IsoDateTime {
  const now = DateTime.makeUnsafe(input.now);
  const providerRetryAt =
    input.providerRetryAt === undefined
      ? undefined
      : Option.getOrUndefined(DateTime.make(input.providerRetryAt));
  if (
    providerRetryAt !== undefined &&
    DateTime.toEpochMillis(providerRetryAt) > DateTime.toEpochMillis(now)
  ) {
    return DateTime.formatIso(DateTime.add(providerRetryAt, { seconds: 2 })) as IsoDateTime;
  }
  const delay =
    input.attempt < 3 ? { minutes: 20 } : input.attempt < 8 ? { hours: 1 } : { hours: 6 };
  return DateTime.formatIso(DateTime.add(now, delay)) as IsoDateTime;
}
