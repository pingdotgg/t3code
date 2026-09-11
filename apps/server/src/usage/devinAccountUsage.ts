// @effect-diagnostics globalDate:off -- API date values are normalized to calendar-day labels.
/**
 * Pure parsing helpers for Devin's organization consumption endpoint.
 *
 * The API reports account billing units (ACUs), not model tokens. The payload
 * shape is decoded with an Effect Schema so raw API responses stay out of the
 * usage contract; malformed rows and fields are dropped rather than failing
 * the whole response.
 *
 * @module devinAccountUsage
 */
import { UsageDay, type UsageAccountConsumptionDay } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface ParsedDevinAccountConsumption {
  readonly totalAcus: number;
  readonly days: readonly UsageAccountConsumptionDay[];
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** ACU amounts are counts: finite and never negative. */
const AcuAmount = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

/** Devin currently returns Unix seconds, but tolerate milliseconds and ISO dates. */
const DayKey = Schema.Union([Schema.String, Schema.Number]);

const ConsumptionDayRecord = Schema.Struct({
  date: Schema.optional(DayKey),
  day: Schema.optional(DayKey),
  acus: AcuAmount,
  acus_by_product: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  byProduct: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const ConsumptionPayload = Schema.Struct({
  consumption_by_date: Schema.Array(Schema.Unknown),
  total_acus: Schema.optional(Schema.Unknown),
  totalAcus: Schema.optional(Schema.Unknown),
});

const decodePayload = Schema.decodeUnknownOption(ConsumptionPayload);
const decodeDayRecord = Schema.decodeUnknownOption(ConsumptionDayRecord);
const decodeAcu = Schema.decodeUnknownOption(AcuAmount);

const decodeOptionalAcu = (value: unknown): number | undefined => {
  const decoded = decodeAcu(value);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

/** Devin currently returns Unix seconds, but tolerate milliseconds and ISO dates. */
const toUsageDay = (key: string | number): UsageDay | null => {
  if (typeof key === "string") {
    const trimmed = key.trim();
    if (DATE_ONLY_PATTERN.test(trimmed)) return UsageDay.make(trimmed);
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed)
      ? UsageDay.make(new Date(parsed).toISOString().slice(0, 10))
      : null;
  }
  const milliseconds = key < 100_000_000_000 ? key * 1_000 : key;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? UsageDay.make(date.toISOString().slice(0, 10)) : null;
};

/** Drops product entries that are not usable non-negative amounts. */
const parseProducts = (
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, number>> => {
  const products: Record<string, number> = {};
  for (const [name, raw] of Object.entries(value)) {
    const amount = decodeOptionalAcu(raw);
    if (amount !== undefined && name.trim().length > 0) products[name] = amount;
  }
  return products;
};

/**
 * Parse the documented `{ total_acus, consumption_by_date }` response.
 * Invalid rows are ignored; a response with no usable rows is rejected so a
 * transient proxy/error body cannot look like a legitimate zero-usage result.
 */
export function parseDevinAccountConsumptionPayload(
  document: unknown,
): ParsedDevinAccountConsumption | null {
  const payload = decodePayload(document);
  if (Option.isNone(payload)) return null;

  const days: UsageAccountConsumptionDay[] = [];
  for (const rawDay of payload.value.consumption_by_date) {
    const entry = decodeDayRecord(rawDay);
    if (Option.isNone(entry)) continue;
    const day = toUsageDay(entry.value.date ?? entry.value.day ?? "");
    if (day === null) continue;
    days.push({
      day,
      acus: entry.value.acus,
      byProduct: parseProducts(entry.value.acus_by_product ?? entry.value.byProduct ?? {}),
    });
  }

  const totalFromResponse =
    decodeOptionalAcu(payload.value.total_acus) ?? decodeOptionalAcu(payload.value.totalAcus);
  if (days.length === 0 && totalFromResponse === undefined) return null;
  return {
    totalAcus: totalFromResponse ?? days.reduce((total, day) => total + day.acus, 0),
    days,
  };
}
