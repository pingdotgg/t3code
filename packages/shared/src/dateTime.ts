import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const isZonedIsoDateTime = Schema.is(
  Schema.String.check(
    Schema.isPattern(
      /^(?:\d{4}|[+-]\d{6})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?|24:00(?::00(?:\.0+)?)?)(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/,
    ),
    Schema.isTrimmed(),
  ),
);

function parseTimestamp(value: string): number {
  if (!isZonedIsoDateTime(value)) return Number.NaN;

  // Engines can normalize invalid calendar dates instead of rejecting them.
  const datePart = value.slice(0, value.indexOf("T"));
  const date = DateTime.make(`${datePart}T00:00:00.000Z`);
  if (Option.isNone(date)) return Number.NaN;
  const parts = DateTime.toPartsUtc(date.value);
  if (parts.month !== Number(datePart.slice(-5, -3)) || parts.day !== Number(datePart.slice(-2))) {
    return Number.NaN;
  }
  return Date.parse(value);
}

/** Compare date-time strings by absolute time, with stable handling for malformed stored values. */
export function compareDateTimeStrings(left: string, right: string): number {
  const leftTimestamp = parseTimestamp(left);
  const rightTimestamp = parseTimestamp(right);
  const leftIsValid = !Number.isNaN(leftTimestamp);
  const rightIsValid = !Number.isNaN(rightTimestamp);

  if (leftIsValid !== rightIsValid) return leftIsValid ? 1 : -1;
  if (leftIsValid) return leftTimestamp - rightTimestamp;
  return left < right ? -1 : left > right ? 1 : 0;
}

interface DateEntry<T> {
  readonly item: T;
  readonly raw: string;
  readonly timestamp: number;
}

function entryOf<T>(item: T, getDate: (item: T) => string): DateEntry<T> {
  const raw = getDate(item);
  return { item, raw, timestamp: parseTimestamp(raw) };
}

function compareDateEntries<T>(
  left: DateEntry<T>,
  right: DateEntry<T>,
  compareTie: (left: T, right: T) => number,
): number {
  const leftValid = !Number.isNaN(left.timestamp);
  const rightValid = !Number.isNaN(right.timestamp);
  if (leftValid !== rightValid) return leftValid ? 1 : -1;
  if (leftValid) {
    const byTime = left.timestamp - right.timestamp;
    return byTime !== 0 ? byTime : compareTie(left.item, right.item);
  }
  const byRaw = left.raw < right.raw ? -1 : left.raw > right.raw ? 1 : 0;
  return byRaw !== 0 ? byRaw : compareTie(left.item, right.item);
}

function siftUp<T>(
  heap: Array<DateEntry<T>>,
  index: number,
  compareTie: (left: T, right: T) => number,
): void {
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (compareDateEntries(heap[index]!, heap[parent]!, compareTie) <= 0) return;
    const swap = heap[index]!;
    heap[index] = heap[parent]!;
    heap[parent] = swap;
    index = parent;
  }
}

function siftDown<T>(
  heap: Array<DateEntry<T>>,
  index: number,
  compareTie: (left: T, right: T) => number,
): void {
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let largest = index;
    if (left < heap.length && compareDateEntries(heap[left]!, heap[largest]!, compareTie) > 0) {
      largest = left;
    }
    if (right < heap.length && compareDateEntries(heap[right]!, heap[largest]!, compareTie) > 0) {
      largest = right;
    }
    if (largest === index) return;
    const swap = heap[index]!;
    heap[index] = heap[largest]!;
    heap[largest] = swap;
    index = largest;
  }
}

export function selectFirstByDateTime<T>(
  items: readonly T[],
  getDate: (item: T) => string,
  limit: number,
  compareTie: (left: T, right: T) => number,
): T[] {
  if (limit <= 0) return [];
  const sortedItems = (entries: Array<DateEntry<T>>): T[] =>
    // `.sort()`, not `.toSorted()`: the entries array is created here, and this module is
    // shared with mobile, which runs on Hermes and has no ES2023 array methods.
    entries
      .sort((left, right) => compareDateEntries(left, right, compareTie))
      .map((entry) => entry.item);
  if (limit >= items.length) {
    return sortedItems(items.map((item) => entryOf(item, getDate)));
  }
  const heap: Array<DateEntry<T>> = [];
  for (const item of items) {
    const entry = entryOf(item, getDate);
    if (heap.length < limit) {
      heap.push(entry);
      siftUp(heap, heap.length - 1, compareTie);
    } else if (compareDateEntries(entry, heap[0]!, compareTie) < 0) {
      heap[0] = entry;
      siftDown(heap, 0, compareTie);
    }
  }
  return sortedItems(heap);
}
