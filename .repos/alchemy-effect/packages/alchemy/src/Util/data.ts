import * as Predicate from "effect/Predicate";
import * as EffectRecord from "effect/Record";
import * as Redacted from "effect/Redacted";

export type Primitive =
  | never
  | undefined
  | null
  | boolean
  | number
  | string
  | bigint
  | symbol;

export const isPrimitive = (value: any): value is Primitive =>
  value === undefined ||
  value === null ||
  typeof value === "boolean" ||
  typeof value === "number" ||
  typeof value === "string" ||
  typeof value === "symbol" ||
  typeof value === "bigint";

export const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> => {
  if (!Predicate.isObject(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
};

export const stripFields = <T>(value: T, empty: null | undefined): T => {
  if (Array.isArray(value)) {
    return value.map((item) => stripFields(item, empty)) as T;
  }
  if (!isPlainObject(value)) return value;
  return EffectRecord.map(
    EffectRecord.filter(value, (entry) => entry !== empty),
    (entry) => stripFields(entry, empty),
  ) as T;
};

export const stripNullFields = <T>(value: T): T => stripFields(value, null);

export const stripUndefinedFields = <T>(value: T): T =>
  stripFields(value, undefined);

type UnwrapRedacted<T> =
  T extends Redacted.Redacted<infer U>
    ? U
    : T extends Record<string, any>
      ? { [K in keyof T]: UnwrapRedacted<T[K]> }
      : T extends Array<infer U>
        ? Array<UnwrapRedacted<U>>
        : T;

export const unwrapRedacted = <T>(value: T): UnwrapRedacted<T> => {
  if (Redacted.isRedacted(value)) {
    return Redacted.value(value) as UnwrapRedacted<T>;
  }
  if (Array.isArray(value)) {
    return value.map(unwrapRedacted) as UnwrapRedacted<T>;
  }
  if (!isPlainObject(value)) return value as UnwrapRedacted<T>;
  return EffectRecord.map(value, unwrapRedacted) as UnwrapRedacted<T>;
};
