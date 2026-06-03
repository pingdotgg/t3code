import type {
  AttributeValue,
  ScalarAttributeType,
} from "@distilled.cloud/aws/dynamodb";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import * as AST from "effect/SchemaAST";
import {
  getSetValueAST,
  isClassSchema,
  isListSchema,
  isMapSchema,
  isNumberSchema,
  isRecordLikeSchema,
  isRecordSchema,
  isSetSchema,
  isStringSchema,
  isStructSchema,
} from "../../Schema.ts";

// this seems important for handling S.Struct.Fields https://effect.website/docs/schema/classes/#recursive-types-with-different-encoded-and-type
// interface CategoryEncoded extends Schema.Struct.Encoded<typeof fields> { .. }

export class InvalidAttributeValue extends Data.TaggedError(
  "InvalidAttributeValue",
)<{
  message: string;
  value: any;
}> {}

export const toAttributeValue: (
  value: any,
) => Effect.Effect<AttributeValue, InvalidAttributeValue, never> = Effect.fn(
  function* (value: any) {
    if (value === undefined) {
      return {
        NULL: false,
      };
    } else if (value === null) {
      return {
        NULL: true,
      };
    } else if (typeof value === "boolean") {
      return {
        BOOL: value,
      };
    } else if (typeof value === "string") {
      return {
        S: value,
      };
    } else if (typeof value === "number") {
      return {
        N: value.toString(10),
      };
    } else if (Array.isArray(value)) {
      return {
        L: yield* Effect.all(value.map(toAttributeValue)),
      };
    } else if (value instanceof Set) {
      const setType = getType(value);
      if (setType === "EMPTY_SET") {
        return {
          SS: [],
        };
      } else if (Array.isArray(setType)) {
        return {
          L: yield* Effect.all(setType.map(toAttributeValue)),
        };
      } else if (setType === "SS") {
        return {
          SS: Array.from(value.values()),
        };
      } else if (setType === "NS") {
        return {
          NS: Array.from(value.values()).map((value) => value.toString(10)),
        };
      } else if (setType === "BS") {
        return {
          BS: Array.from(value.values()),
        };
      } else {
        return {
          L: yield* Effect.all(
            Array.from(value.values()).map(toAttributeValue),
          ),
        };
      }
    } else if (Buffer.isBuffer(value)) {
      return {
        B: new Uint8Array(value),
      };
    } else if (value instanceof File) {
      return {
        B: new Uint8Array(yield* Effect.promise(() => value.arrayBuffer())),
      };
    } else if (value instanceof Uint8Array) {
      return {
        B: value,
      };
    } else if (value instanceof ArrayBuffer) {
      return {
        B: new Uint8Array(value),
      };
    } else if (typeof value === "object") {
      return {
        M: Object.fromEntries(
          yield* Effect.all(
            Object.entries(value).map(([key, value]) =>
              toAttributeValue(value).pipe(Effect.map((value) => [key, value])),
            ),
          ),
        ),
      };
    }

    return yield* Effect.fail(
      new InvalidAttributeValue({
        message: `Unknown value type: ${typeof value}`,
        value,
      }),
    );
  },
);

export const fromAttributeValue = (value: AttributeValue): any => {
  if (value.NULL) {
    return null;
  } else if (typeof value.BOOL === "boolean") {
    return value.BOOL;
  } else if (value.L) {
    return value.L.map(fromAttributeValue);
  } else if (value.M) {
    return Object.fromEntries(
      Object.entries(value.M).map(([key, value]) => [
        key,
        fromAttributeValue(value!),
      ]),
    );
  } else if (value.N) {
    return parseFloat(value.N);
  } else if (value.S) {
    // how do we know if this is a date?
    return value.S;
  } else if (value.SS) {
    return new Set(value.SS);
  } else if (value.NS) {
    return new Set(value.NS);
  } else if (value.BS) {
    return new Set(value.BS);
  } else {
    throw new Error(`Unknown attribute value: ${JSON.stringify(value)}`);
  }
};

type ValueType =
  | "L"
  | "BOOL"
  | "EMPTY_SET"
  | "M"
  | "NULL"
  | "N"
  | "M"
  | "S"
  | "SS"
  | "BS"
  | "NS"
  | "undefined";

const getType = (value: any): ValueType | ValueType[] => {
  if (value === undefined) {
    return "undefined";
  } else if (value === null) {
    return "NULL";
  } else if (typeof value === "boolean") {
    return "BOOL";
  } else if (typeof value === "string") {
    return "S";
  } else if (typeof value === "number") {
    return "N";
  } else if (Array.isArray(value)) {
    return "L";
  } else if (value instanceof Set) {
    return value.size === 0
      ? "EMPTY_SET"
      : (() => {
          const types = Array.from(value.values())
            .flatMap(getType)
            .filter((type, i, arr) => arr.indexOf(type) === i);

          return types.length === 1
            ? types[0] === "S"
              ? "SS"
              : types[0] === "N"
                ? "NS"
                : types[0] === "BOOL"
                  ? "BS"
                  : types[0]
            : "L";
        })();
  } else if (value instanceof Map) {
    return "M";
  } else if (typeof value === "object") {
    return "M";
  } else {
    throw new Error(`Unknown value type: ${typeof value}`);
  }
};

export const isScalarAttributeType = (
  type: string,
): type is ScalarAttributeType => {
  return type === "S" || type === "N" || type === "B";
};

export const toAttributeType = (schema: S.Schema<any>) => {
  if (isStringSchema(schema)) {
    return "S";
  } else if (isNumberSchema(schema)) {
    return "N";
  } else if (isRecordLikeSchema(schema)) {
    return "M";
  } else if (isStringSetSchema(schema)) {
    return "SS";
  } else if (isNumberSetSchema(schema)) {
    return "NS";
  } else if (isListSchema(schema)) {
    return "L";
  }
  return "S";
};

export const isMapSchemaType = (schema: S.Schema<any>) =>
  isMapSchema(schema) ||
  isRecordSchema(schema) ||
  isStructSchema(schema) ||
  isClassSchema(schema) ||
  false;

export const isStringSetSchema = (schema: S.Schema<any>) => {
  if (!isSetSchema(schema)) return false;
  const valueAST = getSetValueAST(schema);
  return valueAST !== undefined && AST.isString(valueAST);
};

export const isNumberSetSchema = (schema: S.Schema<any>) => {
  if (!isSetSchema(schema)) return false;
  const valueAST = getSetValueAST(schema);
  return valueAST !== undefined && AST.isNumber(valueAST);
};
