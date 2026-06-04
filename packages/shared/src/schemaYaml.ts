import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  parse as parseYamlString,
  stringify as stringifyYamlValue,
  type CreateNodeOptions,
  type DocumentOptions,
  type ParseOptions,
  type SchemaOptions,
  type ToJSOptions,
  type ToStringOptions,
} from "yaml";

export type YamlParseOptions = ParseOptions & DocumentOptions & SchemaOptions & ToJSOptions;
export type YamlStringifyOptions = DocumentOptions &
  SchemaOptions &
  ParseOptions &
  CreateNodeOptions &
  ToStringOptions;

function formatYamlError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parses a YAML string into a value.
 *
 * **When to use**
 *
 * Use when you need a schema getter to parse a present encoded YAML string
 * during decoding.
 *
 * **Details**
 *
 * Parse failures become `SchemaIssue.InvalidValue` values.
 *
 * **Example** (Parse YAML)
 *
 * ```ts
 * import { parseYaml } from "@t3tools/shared/schemaYaml"
 *
 * const parse = parseYaml<string>()
 * // Getter<unknown, string>
 * ```
 *
 * @see {@link stringifyYaml} for the inverse operation
 */
export function parseYaml<E extends string>(
  options?: YamlParseOptions,
): SchemaGetter.Getter<unknown, E> {
  return SchemaGetter.transformOrFail((input: E) =>
    Effect.try({
      try: () => parseYamlString(input, options) as unknown,
      catch: (error) =>
        new SchemaIssue.InvalidValue(Option.some(input), { message: formatYamlError(error) }),
    }),
  );
}

/**
 * Stringifies a present value as YAML.
 *
 * **When to use**
 *
 * Use when you need a schema getter to serialize a present decoded value to
 * YAML text during encoding.
 *
 * **Details**
 *
 * Stringify failures become `SchemaIssue.InvalidValue` values.
 *
 * **Example** (Stringify YAML)
 *
 * ```ts
 * import { stringifyYaml } from "@t3tools/shared/schemaYaml"
 *
 * const stringify = stringifyYaml()
 * // Getter<string, unknown>
 * ```
 *
 * @see {@link parseYaml} for the inverse operation
 */
export function stringifyYaml(
  options?: YamlStringifyOptions,
): SchemaGetter.Getter<string, unknown> {
  return SchemaGetter.transformOrFail((input: unknown) =>
    Effect.try({
      try: () => stringifyYamlValue(input, options),
      catch: (error) =>
        new SchemaIssue.InvalidValue(Option.some(input), { message: formatYamlError(error) }),
    }),
  );
}

/**
 * Decodes a YAML string and encodes a value as YAML text.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to decode YAML stored or
 * transmitted as a string before validating the parsed structure.
 *
 * **Details**
 *
 * Decode and encode failures become `InvalidValue` schema issues.
 *
 * **Example** (Parsing YAML)
 *
 * ```ts
 * import * as Schema from "effect/Schema"
 * import { fromYamlString } from "@t3tools/shared/schemaYaml"
 *
 * const schema = Schema.String.pipe(Schema.decodeTo(Schema.Unknown, fromYamlString))
 * ```
 */
export const fromYamlString = new SchemaTransformation.Transformation<unknown, string>(
  parseYaml(),
  stringifyYaml(),
);

/**
 * Build a schema that decodes a YAML string into `A`.
 *
 * Decode parses the input as YAML before validating the parsed value with the
 * provided schema. Encode validates the value and serializes it as YAML text.
 */
export const fromYaml = <S extends Schema.Top>(schema: S) =>
  Schema.String.pipe(Schema.decodeTo(schema, fromYamlString));
