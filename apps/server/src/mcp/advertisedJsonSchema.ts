import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

type Json = unknown;
type JsonObject = { [key: string]: Json };

const isNullSchema = (value: Json) =>
  Predicate.isObject(value) && value.type === "null" && Object.keys(value).length === 1;

const isBareAnyOf = (value: Json): value is { anyOf: Array<Json> } =>
  Predicate.isObject(value) && Array.isArray(value.anyOf) && Object.keys(value).length === 1;

// A `Schema.fromJsonString` fallback. Advertised beside object shapes, it invites stringified input.
const isJsonStringSchema = (value: Json) =>
  Predicate.isObject(value) &&
  value.type === "string" &&
  value.contentMediaType === "application/json";

const SAFE_INTEGER_BOUNDS: Record<string, number> = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: Number.MIN_SAFE_INTEGER,
};

// Gemini rejects function declarations whose enums hold anything but strings.
const isNonStringEnum = (key: string, value: Json) =>
  key === "enum" && Array.isArray(value) && value.some((item) => typeof item !== "string");

const tagOf = (branch: JsonObject, key: string): Json => {
  const property = Predicate.isObject(branch.properties) ? branch.properties[key] : undefined;
  return Predicate.isObject(property) && Array.isArray(property.enum) && property.enum.length === 1
    ? property.enum[0]
    : undefined;
};

/** One object for a tagged union of objects: each property once, the tag listing every value. */
const mergeTaggedObjects = (branches: ReadonlyArray<Json>): JsonObject | undefined => {
  if (branches.length < 2) return undefined;
  const objects = branches.filter(
    (branch): branch is JsonObject & { properties: JsonObject } =>
      Predicate.isObject(branch) &&
      branch.type === "object" &&
      Predicate.isObject(branch.properties),
  );
  if (objects.length !== branches.length) return undefined;
  const tag = Object.keys(objects[0]!.properties).find((key) => {
    const values = objects.map((object) => tagOf(object, key));
    return values.every((value) => value !== undefined) && new Set(values).size === values.length;
  });
  if (tag === undefined) return undefined;
  const properties: JsonObject = {
    [tag]: { type: "string", enum: objects.map((object) => tagOf(object, tag)) },
  };
  for (const object of objects) {
    for (const [name, property] of Object.entries(object.properties)) {
      if (name === tag) continue;
      const seen = properties[name];
      if (seen === undefined) properties[name] = property;
      else if (JSON.stringify(seen) !== JSON.stringify(property)) {
        const options = Predicate.isObject(seen) && isBareAnyOf(seen) ? seen.anyOf : [seen];
        if (!options.some((option) => JSON.stringify(option) === JSON.stringify(property)))
          properties[name] = { anyOf: [...options, property] };
      }
    }
  }
  const [first = [], ...others] = objects.map((object) =>
    Array.isArray(object.required) ? object.required : [],
  );
  const requiredByAll = first.filter(
    (name) => name !== tag && others.every((required) => required.includes(name)),
  );
  return { type: "object", properties, required: [tag, ...requiredByAll] };
};

const isObjectMap = (branch: Json): branch is JsonObject =>
  Predicate.isObject(branch) &&
  branch.type === "object" &&
  (branch.properties === undefined ||
    (Predicate.isObject(branch.properties) && Object.keys(branch.properties).length === 0));

const isArrayOfObjects = (branch: Json) =>
  Predicate.isObject(branch) &&
  branch.type === "array" &&
  Predicate.isObject(branch.items) &&
  branch.items.type === "object";

/** Cursor's CallDynamicTool strips or corrupts a nested array-or-object union. Advertise the object map. */
const preferObjectMapOverItemArray = (branches: ReadonlyArray<Json>): JsonObject | undefined => {
  if (branches.length !== 2) return undefined;
  const objectMap = branches.find(isObjectMap);
  const itemArray = branches.find(isArrayOfObjects);
  return objectMap && itemArray ? objectMap : undefined;
};

const compact = (schema: Json, optional: boolean, toolInput = true): Json => {
  if (Array.isArray(schema)) return schema.map((item) => compact(item, false, toolInput));
  if (!Predicate.isObject(schema)) return schema;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  let result: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" && value === true) continue;
    if (SAFE_INTEGER_BOUNDS[key] === value) continue;
    if (toolInput && isNonStringEnum(key, value)) continue;
    result[key] =
      key === "properties" && Predicate.isObject(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, property]) => [
              name,
              compact(property, !required.has(name), toolInput),
            ]),
          )
        : compact(value, false, toolInput);
  }
  if (Array.isArray(result.anyOf)) {
    const branches = result.anyOf
      .flatMap((branch) => (isBareAnyOf(branch) ? branch.anyOf : [branch]))
      .filter(
        (branch) => !(toolInput && optional && isNullSchema(branch)) && !isJsonStringSchema(branch),
      );
    const { anyOf: _anyOf, ...rest } = result;
    const only =
      branches.length === 1
        ? branches[0]
        : (mergeTaggedObjects(branches) ?? preferObjectMapOverItemArray(branches));
    result = Predicate.isObject(only) ? { ...only, ...rest } : { ...rest, anyOf: branches };
  }
  return result;
};

/**
 * The input schema T3 advertises for a tool. Drops JSON noise that every thread pays for:
 * `additionalProperties: true`, safe-integer bounds, nested `anyOf`, JSON-string fallbacks, and
 * the `null` branch of optional properties. A tagged union of objects becomes one object.
 * An array-or-object map union advertises only the object map. Decoding still uses the full schema.
 */
export const advertisedJsonSchema = (tool: Tool.Any) =>
  compact(Tool.getJsonSchema(tool), false) as ReturnType<typeof Tool.getJsonSchema>;

/** For a schema a tool returns: keeps `null` and non-string enums, which tool inputs drop. */
export const advertisedSchemaOf = (schema: Schema.Constraint) =>
  compact(Tool.getJsonSchemaFromSchema(schema), false, false) as ReturnType<
    typeof Tool.getJsonSchema
  >;
