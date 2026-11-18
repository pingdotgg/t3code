import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

/**
 * Comparison operators for ordered values (numbers, dates, strings).
 */
export interface OrderedOps<V> {
  readonly equals?: V;
  readonly not?: V | null;
  readonly in?: ReadonlyArray<V>;
  readonly notIn?: ReadonlyArray<V>;
  readonly lt?: V;
  readonly lte?: V;
  readonly gt?: V;
  readonly gte?: V;
}

/**
 * String operators.
 */
export interface StringOps<V> extends OrderedOps<V> {
  readonly contains?: string;
  readonly startsWith?: string;
  readonly endsWith?: string;
}

/**
 * Array operators.
 */
export interface ArrayOps<E> {
  readonly some?: FieldFilter<E>;
  readonly every?: FieldFilter<E>;
  readonly none?: FieldFilter<E>;
  readonly has?: E;
  readonly isEmpty?: boolean;
  readonly length?: FieldFilter<number>;
}

type NonNull<V> = V extends DateTime.Utc
  ? V | OrderedOps<V>
  : V extends string
    ? V | StringOps<V>
    : V extends number
      ? V | OrderedOps<V>
      : V extends boolean
        ? V | { readonly not?: boolean }
        : V extends ReadonlyArray<infer E>
          ? ArrayOps<E>
          : V extends object
            ? Filter<V> | { readonly equals: V }
            : never;

/**
 * A filter for one field: a bare value means equality, an object holds
 * operators chosen by the field's type.
 */
export type FieldFilter<V> = null extends V
  ? null | { readonly not: null } | NonNull<NonNullable<V>>
  : NonNull<V>;

/**
 * A Prisma-style filter over a value of type `T`. Sibling keys combine with
 * AND. Filters are plain data, so they can be sent over the wire and evaluated
 * where the data lives.
 *
 * **Example:** Filtering a view
 * ```typescript
 * const frozenAndEmpty: Filter<AccountSummary> = { frozen: true, balance: { lte: 0 } };
 * const either: Filter<TransferStatus> = {
 *   OR: [{ completedAt: { not: null } }, { failedReason: { not: null } }],
 * };
 * ```
 */
export type Filter<T> = {
  readonly [K in keyof T]?: FieldFilter<T[K]>;
} & {
  readonly AND?: ReadonlyArray<Filter<T>>;
  readonly OR?: ReadonlyArray<Filter<T>>;
  readonly NOT?: Filter<T>;
};

/**
 * Sort order for list queries.
 */
export type OrderBy<T> = { readonly [K in keyof T]?: "asc" | "desc" };

const OPERATORS = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "startsWith",
  "endsWith",
  "some",
  "every",
  "none",
  "has",
  "isEmpty",
  "length",
]);

const normalize = (value: unknown): unknown =>
  DateTime.isDateTime(value) ? DateTime.toEpochMillis(value) : value;

const normalizeAgainst = (field: unknown, operand: unknown): unknown => {
  if (DateTime.isDateTime(field) && typeof operand === "string") {
    return Date.parse(operand);
  }
  return normalize(operand);
};

const deepEqual = (a: unknown, b: unknown): boolean => {
  const x = normalize(a);
  const y = normalize(b);
  if (x === y) return true;
  if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false;
  if (Array.isArray(x) !== Array.isArray(y)) return false;
  const kx = Object.keys(x);
  const ky = Object.keys(y);
  if (kx.length !== ky.length) return false;
  return kx.every((k) => deepEqual((x as any)[k], (y as any)[k]));
};

const isOperatorObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !DateTime.isDateTime(value) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).every((k) => OPERATORS.has(k));

const isObject = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !DateTime.isDateTime(value);

/** An operand on the wire: a `DateTime` travels as its ISO string, which {@link matches} compares with a date field. */
const Operand = Schema.Union([Schema.String, Schema.DateTimeUtc, Schema.Unknown]);

/** One field's filter on the wire: a value to equal, operators, or a nested filter. */
const FieldJson: Schema.Codec<unknown> = Schema.Union([
  Operand.check(Schema.makeFilter((value) => !isObject(value))),
  Schema.suspend(() => OperatorsJson),
  Schema.suspend(() => FilterJson.check(Schema.makeFilter((value) => !isOperatorObject(value)))),
]);

const OperatorsJson = Schema.Struct({
  equals: Schema.optionalKey(Operand),
  not: Schema.optionalKey(Operand),
  in: Operand.pipe(Schema.Array, Schema.optionalKey),
  notIn: Operand.pipe(Schema.Array, Schema.optionalKey),
  lt: Schema.optionalKey(Operand),
  lte: Schema.optionalKey(Operand),
  gt: Schema.optionalKey(Operand),
  gte: Schema.optionalKey(Operand),
  contains: Schema.optionalKey(Schema.String),
  startsWith: Schema.optionalKey(Schema.String),
  endsWith: Schema.optionalKey(Schema.String),
  some: Schema.optionalKey(FieldJson),
  every: Schema.optionalKey(FieldJson),
  none: Schema.optionalKey(FieldJson),
  has: Schema.optionalKey(Operand),
  isEmpty: Schema.optionalKey(Schema.Boolean),
  length: Schema.optionalKey(FieldJson),
}).check(Schema.makeFilter(isOperatorObject));

/**
 * A {@link Filter} as it crosses the wire. A read decodes `where` with it, so
 * a malformed filter is refused before {@link matches} evaluates it.
 */
export const FilterJson: Schema.Codec<unknown> = Schema.StructWithRest(
  Schema.Struct({
    AND: Schema.suspend(() => FilterJson).pipe(Schema.Array, Schema.optionalKey),
    OR: Schema.suspend(() => FilterJson).pipe(Schema.Array, Schema.optionalKey),
    NOT: Schema.optionalKey(Schema.suspend(() => FilterJson)),
  }),
  [Schema.Record(Schema.String, FieldJson)],
);

const compare = (field: unknown, operand: unknown): number => {
  const a = normalize(field) as any;
  const b = normalizeAgainst(field, operand) as any;
  return a < b ? -1 : a > b ? 1 : 0;
};

const matchesField = (value: unknown, filter: unknown): boolean => {
  if (filter === null) return value === null || value === undefined;
  if (!isOperatorObject(filter)) {
    if (
      typeof filter === "object" &&
      !Array.isArray(filter) &&
      !DateTime.isDateTime(filter) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !DateTime.isDateTime(value)
    ) {
      return matches(filter as Filter<any>, value);
    }
    return deepEqual(value, normalizeAgainst(value, filter));
  }
  const ops = filter;
  const present = value !== null && value !== undefined;
  for (const [op, operand] of Object.entries(ops)) {
    switch (op) {
      case "equals":
        if (!deepEqual(value, normalizeAgainst(value, operand))) return false;
        break;
      case "not":
        if (operand === null ? !present : deepEqual(value, normalizeAgainst(value, operand))) {
          return false;
        }
        break;
      case "in":
        if (
          !(operand as ReadonlyArray<unknown>).some((o) =>
            deepEqual(value, normalizeAgainst(value, o)),
          )
        ) {
          return false;
        }
        break;
      case "notIn":
        if (
          (operand as ReadonlyArray<unknown>).some((o) =>
            deepEqual(value, normalizeAgainst(value, o)),
          )
        ) {
          return false;
        }
        break;
      case "lt":
        if (!present || compare(value, operand) >= 0) return false;
        break;
      case "lte":
        if (!present || compare(value, operand) > 0) return false;
        break;
      case "gt":
        if (!present || compare(value, operand) <= 0) return false;
        break;
      case "gte":
        if (!present || compare(value, operand) < 0) return false;
        break;
      case "contains":
        if (typeof value !== "string" || !value.includes(operand as string)) return false;
        break;
      case "startsWith":
        if (typeof value !== "string" || !value.startsWith(operand as string)) return false;
        break;
      case "endsWith":
        if (typeof value !== "string" || !value.endsWith(operand as string)) return false;
        break;
      case "some":
        if (!Array.isArray(value) || !value.some((e) => matchesField(e, operand))) return false;
        break;
      case "every":
        if (!Array.isArray(value) || !value.every((e) => matchesField(e, operand))) return false;
        break;
      case "none":
        if (!Array.isArray(value) || value.some((e) => matchesField(e, operand))) return false;
        break;
      case "has":
        if (!Array.isArray(value) || !value.some((e) => deepEqual(e, operand))) return false;
        break;
      case "isEmpty":
        if (!Array.isArray(value) || (value.length === 0) !== operand) return false;
        break;
      case "length":
        if (!Array.isArray(value) || !matchesField(value.length, operand)) return false;
        break;
    }
  }
  return true;
};

/**
 * Evaluate a {@link Filter} against a value.
 */
export const matches = <T>(filter: Filter<T> | undefined, value: T): boolean => {
  if (filter === undefined) return true;
  for (const [key, operand] of Object.entries(filter as Record<string, unknown>)) {
    if (operand === undefined) continue;
    if (key === "AND") {
      if (!(operand as ReadonlyArray<Filter<T>>).every((f) => matches(f, value))) return false;
    } else if (key === "OR") {
      if (!(operand as ReadonlyArray<Filter<T>>).some((f) => matches(f, value))) return false;
    } else if (key === "NOT") {
      if (matches(operand as Filter<T>, value)) return false;
    } else if (!matchesField((value as any)?.[key], operand)) {
      return false;
    }
  }
  return true;
};

/**
 * Sort values by an {@link OrderBy} specification.
 */
export const sort = <T>(values: ReadonlyArray<T>, orderBy: OrderBy<T> | undefined): Array<T> => {
  if (!orderBy) return [...values];
  const keys = Object.entries(orderBy as Record<string, "asc" | "desc">);
  return [...values].sort((a, b) => {
    for (const [key, direction] of keys) {
      const c = compare((a as any)[key], (b as any)[key]);
      if (c !== 0) return direction === "desc" ? -c : c;
    }
    return 0;
  });
};
