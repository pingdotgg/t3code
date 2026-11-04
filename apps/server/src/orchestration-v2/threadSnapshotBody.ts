import {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const ENCODE_BATCH_ITEMS = 256;
const CHUNK_CHARS = 256 * 1024;

type Encode = (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>;

// The endpoint encodes its success with toCodecJson (HttpApiEndpoint): values come out as JSON.
const encodeJson = (schema: Schema.Top): Encode =>
  Schema.encodeUnknownEffect(
    Schema.toCodecJson(schema) as unknown as Schema.Codec<unknown, unknown>,
  );

const encodeSnapshot = encodeJson(OrchestrationV2ThreadDetailSnapshot);
const encodeProjectionField = new Map<string, Encode>(
  Object.entries(OrchestrationV2ThreadProjection.fields).map(([key, schema]) => [
    key,
    encodeJson(schema),
  ]),
);
const encodeRowsWithoutItem = encodeJson(
  Schema.Array(OrchestrationV2ProjectedTurnItem.mapFields(({ item: _item, ...fields }) => fields)),
);
// A row encodes its fields in schema order; a reused item matches that only as the last field.
const ROW_ITEM_IS_LAST = Object.keys(OrchestrationV2ProjectedTurnItem.fields).at(-1) === "item";

const batchesOf = <A>(values: ReadonlyArray<A>) =>
  Array.from({ length: Math.ceil(values.length / ENCODE_BATCH_ITEMS) }, (_, index) =>
    values.slice(index * ENCODE_BATCH_ITEMS, (index + 1) * ENCODE_BATCH_ITEMS),
  );

// Visible rows repeat local turn items; reuse their encoding instead of encoding each item twice.
// Untraced: it runs once per batch, inside the traced encode.
const encodeVisibleRows = Effect.fnUntraced(function* (
  rows: ReadonlyArray<{ readonly item: unknown }>,
  encodedItems: ReadonlyMap<unknown, unknown>,
  encodeRows: Encode,
) {
  const rests = (yield* encodeRowsWithoutItem(
    rows.map(({ item: _item, ...rest }) => rest),
  )) as ReadonlyArray<object>;
  const encoded: Array<unknown> = [];
  const missed: Array<number> = [];
  rows.forEach((row, index) => {
    const item = ROW_ITEM_IS_LAST ? encodedItems.get(row.item) : undefined;
    if (item === undefined) missed.push(index);
    encoded.push(item === undefined ? undefined : { ...rests[index], item });
  });
  if (missed.length > 0) {
    const full = (yield* encodeRows(missed.map((index) => rows[index]))) as ReadonlyArray<unknown>;
    missed.forEach((index, position) => (encoded[index] = full[position]));
  }
  return encoded;
});

type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };
type Container = ReadonlyArray<Json> | { readonly [key: string]: Json };

const isContainer = (value: Json): value is Container =>
  typeof value === "object" && value !== null;

// Deeper values are written level by level: JSON.stringify recurses, and deep enough it throws.
// Kept low so the lookahead below stays cheap on deeply nested values.
const MAX_NATIVE_DEPTH = 128;

// Lookahead: whether its JSON is about longer than a chunk (escapes can add more) or nests too
// deep for one JSON.stringify. Stops as soon as either holds, so it costs a chunk at most.
const tooLargeForOneString = (root: Json) => {
  let budget = CHUNK_CHARS;
  const pending: Array<readonly [Json, number]> = [[root, 0]];
  while (pending.length > 0 && budget >= 0) {
    const [value, depth] = pending.pop()!;
    if (typeof value === "string") budget -= value.length + 2;
    else if (!isContainer(value)) budget -= 8;
    else if (depth >= MAX_NATIVE_DEPTH) return true;
    else if (Array.isArray(value)) {
      // Every element costs at least its comma, so a longer array is over budget already.
      if ((budget -= value.length + 2) >= 0) {
        for (const element of value) pending.push([element, depth + 1]);
      }
    } else {
      budget -= 2;
      for (const key in value) {
        if ((budget -= key.length + 3) < 0) break;
        pending.push([(value as Readonly<Record<string, Json>>)[key]!, depth + 1]);
      }
    }
  }
  return budget < 0;
};

// Never between the halves of a surrogate pair: apart, each half encodes differently.
const sliceEnd = (text: string, start: number) => {
  const end = Math.min(start + CHUNK_CHARS, text.length);
  const last = text.charCodeAt(end - 1);
  return end < text.length && last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
};

function* stringParts(text: string): Generator<string> {
  if (text.length <= CHUNK_CHARS) {
    yield JSON.stringify(text);
    return;
  }
  yield '"';
  for (let start = 0; start < text.length;) {
    const end = sliceEnd(text, start);
    yield JSON.stringify(text.slice(start, end)).slice(1, -1);
    start = end;
  }
  yield '"';
}

/** JSON.stringify of a JSON value in parts of about a chunk or less, without recursion. */
function* jsonParts(root: Json): Generator<string> {
  if (!tooLargeForOneString(root)) {
    yield JSON.stringify(root);
    return;
  }
  if (!isContainer(root)) {
    yield* stringParts(root as string);
    return;
  }
  // Only the open containers are held: each with its keys, if an object, and the next index.
  const stack: Array<{
    readonly container: Container;
    readonly keys: ReadonlyArray<string> | undefined;
    index: number;
  }> = [];
  let next: Json | undefined = root;
  while (true) {
    if (next !== undefined) {
      if (typeof next === "string") yield* stringParts(next);
      else if (!isContainer(next) || (next !== root && !tooLargeForOneString(next))) {
        yield JSON.stringify(next);
      } else {
        const keys = Array.isArray(next) ? undefined : Object.keys(next);
        yield keys === undefined ? "[" : "{";
        stack.push({ container: next, keys, index: 0 });
      }
      next = undefined;
    }
    const frame = stack.at(-1);
    if (frame === undefined) return;
    const { container, keys } = frame;
    if (frame.index === (keys ?? (container as ReadonlyArray<Json>)).length) {
      stack.pop();
      yield keys === undefined ? "]" : "}";
      continue;
    }
    if (frame.index > 0) yield ",";
    if (keys === undefined) next = (container as ReadonlyArray<Json>)[frame.index]!;
    else {
      const key = keys[frame.index]!;
      yield* stringParts(key);
      yield ":";
      next = (container as Readonly<Record<string, Json>>)[key]!;
    }
    frame.index++;
  }
}

function* objectParts(
  value: Readonly<Record<string, Json>>,
  memberParts: (key: string, member: Json) => Iterable<string>,
): Generator<string> {
  yield "{";
  let separator = "";
  for (const key of Object.keys(value)) {
    yield separator;
    yield* stringParts(key);
    yield ":";
    yield* memberParts(key, value[key]!);
    separator = ",";
  }
  yield "}";
}

function* elementsParts(elements: ReadonlyArray<Json>): Generator<string> {
  yield "[";
  for (let index = 0; index < elements.length; index++) {
    if (index > 0) yield ",";
    yield* jsonParts(elements[index]!);
  }
  yield "]";
}

// Parts are sized before escaping, which can make one six times longer: cut the written text.
function* chunks(parts: Iterable<string>): Generator<Uint8Array> {
  let pending = "";
  for (const part of parts) {
    pending += part;
    while (pending.length >= CHUNK_CHARS) {
      const end = sliceEnd(pending, 0);
      yield Buffer.from(pending.slice(0, end), "utf8");
      pending = pending.slice(end);
    }
  }
  if (pending.length > 0) yield Buffer.from(pending, "utf8");
}

/**
 * The thread snapshot's body, byte for byte what HttpApiBuilder sends: `JSON.stringify` of its
 * toCodecJson encoding. It encodes in batches before returning, so a schema failure still precedes
 * the response; the text is made chunk by chunk as the body is read.
 */
export const encodeThreadSnapshotBody = Effect.fn("ThreadSnapshotBody.encode")(function* (
  snapshot: OrchestrationV2ThreadDetailSnapshot,
) {
  const projection = snapshot.projection as unknown as Readonly<Record<string, unknown>>;
  const arrayKeys = [...encodeProjectionField.keys()].filter((key) =>
    Array.isArray(projection[key]),
  );
  const envelope = (yield* encodeSnapshot({
    ...snapshot,
    projection: { ...projection, ...Object.fromEntries(arrayKeys.map((key) => [key, []])) },
  })) as Readonly<Record<string, Json>>;
  const encodedItems = new Map<unknown, unknown>();
  const arrays = new Map<string, ReadonlyArray<Json>>();
  for (const key of arrayKeys) {
    const encode = encodeProjectionField.get(key)!;
    const batches: Array<ReadonlyArray<unknown>> = [];
    for (const batch of batchesOf(projection[key] as ReadonlyArray<unknown>)) {
      const encoded =
        key === "visibleTurnItems"
          ? yield* encodeVisibleRows(
              batch as ReadonlyArray<{ readonly item: unknown }>,
              encodedItems,
              encode,
            )
          : ((yield* encode(batch)) as ReadonlyArray<unknown>);
      if (key === "turnItems")
        batch.forEach((item, index) => encodedItems.set(item, encoded[index]));
      batches.push(encoded);
      yield* Effect.yieldNow;
    }
    arrays.set(key, batches.flat() as ReadonlyArray<Json>);
  }
  encodedItems.clear();
  // The encoded arrays replace the envelope's empty ones, in the envelope's key order.
  return Stream.suspend(() =>
    Stream.fromIterable(
      chunks(
        objectParts(envelope, (key, value) =>
          key === "projection"
            ? objectParts(value as Readonly<Record<string, Json>>, (field, member) => {
                const elements = arrays.get(field);
                return elements === undefined ? jsonParts(member) : elementsParts(elements);
              })
            : jsonParts(value),
        ),
      ),
      { chunkSize: 1 },
    ),
  );
});
