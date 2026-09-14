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

interface DateTimeSelection<T> {
  readonly item: T;
  readonly timestamp: number;
  readonly raw: string;
}

function compareDateTimeSelections<T>(
  left: DateTimeSelection<T>,
  right: DateTimeSelection<T>,
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
  heap: Array<DateTimeSelection<T>>,
  index: number,
  compare: (left: DateTimeSelection<T>, right: DateTimeSelection<T>) => number,
): void {
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (compare(heap[index]!, heap[parent]!) <= 0) return;
    const swap = heap[index]!;
    heap[index] = heap[parent]!;
    heap[parent] = swap;
    index = parent;
  }
}

function siftDown<T>(
  heap: Array<DateTimeSelection<T>>,
  index: number,
  compare: (left: DateTimeSelection<T>, right: DateTimeSelection<T>) => number,
): void {
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let largest = index;
    if (left < heap.length && compare(heap[left]!, heap[largest]!) > 0) largest = left;
    if (right < heap.length && compare(heap[right]!, heap[largest]!) > 0) largest = right;
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
  const compare = (left: DateTimeSelection<T>, right: DateTimeSelection<T>): number =>
    compareDateTimeSelections(left, right, compareTie);
  if (limit >= items.length) {
    return items
      .map((item) => {
        const raw = getDate(item);
        return { item, raw, timestamp: parseTimestamp(raw) };
      })
      .sort(compare)
      .map((selection) => selection.item);
  }
  const heap: Array<DateTimeSelection<T>> = [];
  for (const item of items) {
    const raw = getDate(item);
    const selection = { item, raw, timestamp: parseTimestamp(raw) };
    if (heap.length < limit) {
      heap.push(selection);
      siftUp(heap, heap.length - 1, compare);
    } else if (compare(selection, heap[0]!) < 0) {
      heap[0] = selection;
      siftDown(heap, 0, compare);
    }
  }
  return heap.sort(compare).map((selection) => selection.item);
}
