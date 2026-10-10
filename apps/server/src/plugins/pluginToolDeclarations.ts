/**
 * Turns a manifest's tool declarations into what the host lists and enforces.
 *
 * Input schemas are compiled from the JSON Schema subset documented in the
 * contracts' PluginTools module into an Effect Schema. Each accepted keyword
 * is built with JSON Schema's meaning (closed objects reject extra keys,
 * string lengths count code points), so the declared schema an agent sees is
 * exactly what calls are checked against. Anything outside the subset is a
 * problem naming the keyword; nothing is silently dropped. The manifest loader
 * refuses a plugin with a problem, so an enabled plugin's tools always compile.
 */
import {
  PLUGIN_TOOL_LIMITS,
  type PluginToolDeclaration,
  type PluginToolListing,
  qualifyPluginToolName,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";

interface PreparedPluginTool {
  readonly listing: PluginToolListing;
  readonly validate: (input: unknown) => Exit.Exit<unknown, Schema.SchemaError>;
  readonly timeoutSeconds: number;
}

export interface PreparedPluginTools {
  readonly tools: ReadonlyMap<string, PreparedPluginTool>;
  /** Serialized size of the listings as one page holds them, separators included. */
  readonly listingBytes: number;
}

type JsonObject = { readonly [key: string]: unknown };
type Compiled = Schema.Top;

class SchemaProblem {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const jsonBytes = (value: unknown) => Buffer.byteLength(encodeJson(value), "utf8");

const isString = (value: unknown) => typeof value === "string";
const isBoolean = (value: unknown) => typeof value === "boolean";
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
/** Annotations and the shape each must have; `default` may be any JSON value. */
const ANNOTATIONS = new Map<string, (value: unknown) => boolean>([
  ["title", isString],
  ["description", isString],
  ["default", () => true],
  ["examples", Array.isArray],
  ["deprecated", isBoolean],
  ["readOnly", isBoolean],
  ["writeOnly", isBoolean],
  ["format", isString],
  ["$comment", isString],
]);
const KEYWORDS_BY_TYPE: Record<string, ReadonlyArray<string>> = {
  object: ["properties", "required", "additionalProperties"],
  array: ["items", "minItems", "maxItems"],
  string: ["minLength", "maxLength"],
  number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"],
  integer: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"],
};
const TYPED_KEYWORDS = new Set(Object.values(KEYWORDS_BY_TYPE).flat());
const DEFINITION_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isPrimitive = (value: unknown) =>
  value === null || ["string", "number", "boolean"].includes(typeof value);
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const withChecks = <T>(
  schema: Schema.Codec<T>,
  checks: ReadonlyArray<SchemaAST.Check<T>>,
): Compiled => {
  const [first, ...rest] = checks;
  return (first === undefined ? schema : schema.check(first, ...rest)) as Compiled;
};

const codePoints = (text: string) => {
  let count = 0;
  for (const _ of text) count++;
  return count;
};

const literal = (value: unknown): Compiled =>
  value === null ? Schema.Null : Schema.Literal(value as string | number | boolean);

const matchesType = (value: unknown, type: string) =>
  type === "null"
    ? value === null
    : type === "integer"
      ? Number.isInteger(value)
      : type === "array" || type === "object"
        ? false
        : typeof value === type;

/**
 * Refuses a reference cycle that consumes no input: one reached through only
 * `$ref` and `anyOf`, never `properties` or `items`. This walks the whole
 * definition graph on its own so that compiling a definition once and reusing
 * it cannot hide a cycle on another path. Malformed schemas are left for
 * `compile` to name.
 */
const refuseUnguardedCycles = (definitions: JsonObject) => {
  // Each definition's references that are reached without consuming input.
  const edges = new Map<string, Array<{ readonly name: string; readonly path: string }>>();
  const collect = (schema: unknown, path: string, into: Array<{ name: string; path: string }>) => {
    if (!isObject(schema)) return;
    const ref = schema.$ref;
    if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
      const name = ref.slice(8);
      if (Object.hasOwn(definitions, name)) into.push({ name, path: `${path}/$ref` });
    } else if (Array.isArray(schema.anyOf))
      schema.anyOf.forEach((member, index) => collect(member, `${path}/anyOf/${index}`, into));
  };
  for (const [name, schema] of Object.entries(definitions)) {
    const into: Array<{ name: string; path: string }> = [];
    collect(schema, `#/$defs/${name}`, into);
    edges.set(name, into);
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string) => {
    state.set(name, "visiting");
    for (const edge of edges.get(name)!) {
      const seen = state.get(edge.name);
      if (seen === "visiting")
        throw new SchemaProblem(
          `${edge.path}: a reference cycle must pass through properties or items.`,
        );
      if (seen === undefined) visit(edge.name);
    }
    state.set(name, "done");
  };
  for (const name of edges.keys()) if (!state.has(name)) visit(name);
};

/**
 * Compiles one `inputSchema`. Throws `SchemaProblem` with a JSON-pointer-like
 * path; `compileInputSchema` turns it into a result.
 */
const compile = (root: JsonObject): Compiled => {
  const definitions = root.$defs === undefined ? {} : root.$defs;
  if (!isObject(definitions)) throw new SchemaProblem("#/$defs: must be an object.");
  for (const name of Object.keys(definitions))
    if (!DEFINITION_NAME.test(name))
      throw new SchemaProblem(
        `#/$defs/${name}: definition names are 1 to 64 letters, digits, "_", "." or "-".`,
      );
  refuseUnguardedCycles(definitions);
  const done = new Map<string, Compiled>();
  const inProgress = new Set<string>();

  /** The compiled definition `name`; any cycle back into it consumes input. */
  const definition = (name: string, depth: number): Compiled => {
    const compiled = done.get(name);
    if (compiled !== undefined) return compiled;
    if (inProgress.has(name)) return Schema.suspend((): Compiled => done.get(name)!);
    inProgress.add(name);
    const result = node(definitions[name], `#/$defs/${name}`, depth);
    inProgress.delete(name);
    done.set(name, result);
    return result;
  };

  const node = (schema: unknown, path: string, depth: number): Compiled => {
    if (depth > PLUGIN_TOOL_LIMITS.maxInputSchemaDepth)
      throw new SchemaProblem(
        `${path}: schemas nest deeper than ${PLUGIN_TOOL_LIMITS.maxInputSchemaDepth}.`,
      );
    if (!isObject(schema)) throw new SchemaProblem(`${path}: a schema must be an object.`);
    for (const [key, valid] of ANNOTATIONS)
      if (Object.hasOwn(schema, key) && !valid(schema[key]))
        throw new SchemaProblem(`${path}/${key}: not a valid ${key} annotation.`);
    const keywords = Object.keys(schema).filter(
      (key) => !ANNOTATIONS.has(key) && !(path === "#" && key === "$defs"),
    );
    if (path !== "#" && "$defs" in schema)
      throw new SchemaProblem(`${path}: $defs is only supported at the root.`);
    const only = (keyword: string) => {
      const others = keywords.filter((key) => key !== keyword);
      if (others.length > 0)
        throw new SchemaProblem(`${path}: ${others[0]} cannot be used beside ${keyword}.`);
    };

    if ("$ref" in schema) {
      only("$ref");
      const ref = schema.$ref;
      const name = typeof ref === "string" && ref.startsWith("#/$defs/") ? ref.slice(8) : "";
      if (!Object.hasOwn(definitions, name))
        throw new SchemaProblem(
          `${path}/$ref: only "#/$defs/<name>" references to root definitions are supported.`,
        );
      return definition(name, depth + 1);
    }

    if ("anyOf" in schema) {
      only("anyOf");
      const members = schema.anyOf;
      if (!Array.isArray(members) || members.length === 0)
        throw new SchemaProblem(`${path}/anyOf: must be a non-empty array.`);
      return Schema.Union(
        members.map((member, index) => node(member, `${path}/anyOf/${index}`, depth + 1)),
      );
    }

    const types =
      schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
    if (
      types.some((type) => typeof type !== "string" || !TYPES.has(type)) ||
      new Set(types).size !== types.length ||
      (schema.type !== undefined && types.length === 0)
    )
      throw new SchemaProblem(
        `${path}/type: must be one or more distinct of ${[...TYPES].join(", ")}.`,
      );
    for (const keyword of keywords) {
      if (keyword === "type" || keyword === "enum" || keyword === "const") continue;
      if (!TYPED_KEYWORDS.has(keyword))
        throw new SchemaProblem(`${path}/${keyword}: this keyword is not supported.`);
      if (!types.some((type: string) => KEYWORDS_BY_TYPE[type]?.includes(keyword)))
        throw new SchemaProblem(`${path}/${keyword}: needs a type it applies to.`);
    }

    if ("enum" in schema || "const" in schema) {
      if ("enum" in schema && "const" in schema)
        throw new SchemaProblem(`${path}: use enum or const, not both.`);
      const values = "const" in schema ? [schema.const] : schema.enum;
      if (!Array.isArray(values) || values.length === 0 || !values.every(isPrimitive))
        throw new SchemaProblem(
          `${path}: enum and const take string, number, boolean, or null values.`,
        );
      const other = keywords.find((key) => key !== "type" && key !== "enum" && key !== "const");
      if (other !== undefined)
        throw new SchemaProblem(`${path}/${other}: cannot be used beside enum or const.`);
      if (
        types.length > 0 &&
        !values.every((value) => types.some((type) => matchesType(value, type)))
      )
        throw new SchemaProblem(`${path}: an enum or const value does not match its type.`);
      return values.length === 1 ? literal(values[0]) : Schema.Union(values.map(literal));
    }

    if (types.length === 0) return Schema.Json as Compiled;
    const byType = types.map((type: string): Compiled => {
      switch (type) {
        case "null":
          return Schema.Null;
        case "boolean":
          return Schema.Boolean;
        case "string":
          return stringSchema(schema, path);
        case "number":
        case "integer":
          return numberSchema(schema, path, type === "integer");
        case "array": {
          const items =
            schema.items === undefined
              ? (Schema.Json as Compiled)
              : node(schema.items, `${path}/items`, depth + 1);
          return withChecks(Schema.Array(items as Schema.Codec<unknown>), [
            ...(schema.minItems === undefined
              ? []
              : [Schema.isMinLength(count(schema, "minItems", path))]),
            ...(schema.maxItems === undefined
              ? []
              : [Schema.isMaxLength(count(schema, "maxItems", path))]),
          ]);
        }
        default:
          return objectSchema(schema, path, depth);
      }
    });
    return byType.length === 1 ? byType[0]! : Schema.Union(byType);
  };

  const objectSchema = (schema: JsonObject, path: string, depth: number): Compiled => {
    // Only an absent keyword takes its default; `null` is not a valid value for any of them.
    const properties = schema.properties === undefined ? {} : schema.properties;
    if (!isObject(properties)) throw new SchemaProblem(`${path}/properties: must be an object.`);
    const required = schema.required === undefined ? [] : schema.required;
    if (
      !Array.isArray(required) ||
      !required.every((name) => typeof name === "string" && Object.hasOwn(properties, name)) ||
      new Set(required).size !== required.length
    )
      throw new SchemaProblem(`${path}/required: must list distinct names from properties.`);
    const additional =
      schema.additionalProperties === undefined ? true : schema.additionalProperties;
    if (typeof additional !== "boolean")
      throw new SchemaProblem(`${path}/additionalProperties: must be true or false.`);
    const fields: Record<string, Schema.Top> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (key === "__proto__")
        throw new SchemaProblem(`${path}/properties: __proto__ is not supported.`);
      const property = node(value, `${path}/properties/${key}`, depth + 1);
      fields[key] = required.includes(key) ? property : Schema.optionalKey(property);
    }
    // An empty struct accepts any object, so a closed empty object is a record of nothing.
    if (!additional && Object.keys(fields).length === 0)
      return Schema.Record(Schema.String, Schema.Never);
    const struct = Schema.Struct(fields);
    // Calls are decoded with `onExcessProperty: "error"`, so a closed object rejects
    // extra keys and an open one keeps them.
    return additional
      ? Schema.StructWithRest(struct, [Schema.Record(Schema.String, Schema.Json)])
      : struct;
  };

  if (root.type !== "object") throw new SchemaProblem(`#/type: the root must be "object".`);
  const compiled = node(root, "#", 0);
  // A definition nothing references is still part of the declaration, so it is held to the subset too.
  for (const name of Object.keys(definitions)) definition(name, 1);
  return compiled;
};

const count = (schema: JsonObject, keyword: string, path: string) => {
  const value = schema[keyword];
  if (!isCount(value))
    throw new SchemaProblem(`${path}/${keyword}: must be a non-negative integer.`);
  return value;
};

const stringSchema = (schema: JsonObject, path: string): Compiled => {
  const min = schema.minLength === undefined ? undefined : count(schema, "minLength", path);
  const max = schema.maxLength === undefined ? undefined : count(schema, "maxLength", path);
  if (min === undefined && max === undefined) return Schema.String;
  return Schema.String.check(
    Schema.makeFilter((text: string) => {
      const length = codePoints(text);
      if (min !== undefined && length < min) return `Expected at least ${min} characters`;
      return max === undefined || length <= max || `Expected at most ${max} characters`;
    }),
  );
};

const numberSchema = (schema: JsonObject, path: string, integer: boolean): Compiled => {
  const bound = (keyword: string) => {
    const value = schema[keyword];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new SchemaProblem(`${path}/${keyword}: must be a number.`);
    return value;
  };
  return withChecks(Schema.Number, [
    ...(integer
      ? [Schema.makeFilter((value: number) => Number.isInteger(value) || "Expected an integer")]
      : []),
    ...[
      [bound("minimum"), Schema.isGreaterThanOrEqualTo],
      [bound("exclusiveMinimum"), Schema.isGreaterThan],
      [bound("maximum"), Schema.isLessThanOrEqualTo],
      [bound("exclusiveMaximum"), Schema.isLessThan],
    ].flatMap(([value, check]) =>
      typeof value === "number" ? [(check as typeof Schema.isLessThan)(value)] : [],
    ),
  ]);
};

/** The validator for one declared `inputSchema`, or why it is outside the subset. */
export const compileInputSchema = (
  inputSchema: JsonObject,
):
  | { readonly validate: (input: unknown) => Exit.Exit<unknown, Schema.SchemaError> }
  | { readonly problem: string } => {
  if (jsonBytes(inputSchema) > PLUGIN_TOOL_LIMITS.maxInputSchemaBytes)
    return { problem: `inputSchema exceeds ${PLUGIN_TOOL_LIMITS.maxInputSchemaBytes} bytes.` };
  try {
    return {
      validate: Schema.decodeUnknownExit(compile(inputSchema) as Schema.Codec<unknown>, {
        onExcessProperty: "error",
      }),
    };
  } catch (error) {
    if (error instanceof SchemaProblem) return { problem: `inputSchema ${error.message}` };
    throw error;
  }
};

/** Prepares every declared tool of one plugin, or names the first that cannot be offered. */
export const preparePluginTools = (
  plugin: { readonly id: string; readonly name: string },
  declarations: ReadonlyArray<PluginToolDeclaration>,
): PreparedPluginTools | { readonly problem: string } => {
  const tools = new Map<string, PreparedPluginTool>();
  let listingBytes = 0;
  for (const declaration of declarations) {
    if (tools.has(declaration.name))
      return { problem: `it declares the tool ${declaration.name} twice.` };
    const compiled = compileInputSchema(declaration.inputSchema);
    if ("problem" in compiled)
      return { problem: `the tool ${declaration.name}'s ${compiled.problem}` };
    const listing: PluginToolListing = {
      tool: qualifyPluginToolName(plugin.id, declaration.name),
      plugin: { id: plugin.id, name: plugin.name },
      ...(declaration.title === undefined ? {} : { title: declaration.title }),
      description: declaration.description,
      inputSchema: declaration.inputSchema,
      sideEffect: declaration.sideEffect,
      openWorld: declaration.openWorld,
    };
    listingBytes += jsonBytes(listing) + 1;
    tools.set(declaration.name, {
      listing,
      validate: compiled.validate,
      timeoutSeconds: declaration.timeoutSeconds ?? PLUGIN_TOOL_LIMITS.defaultTimeoutSeconds,
    });
  }
  if (listingBytes > PLUGIN_TOOL_LIMITS.maxPluginListingBytes)
    return {
      problem: `its tools take more than ${PLUGIN_TOOL_LIMITS.maxPluginListingBytes} bytes to list.`,
    };
  return { tools, listingBytes };
};
