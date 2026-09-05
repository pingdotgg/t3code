import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  YAMLParseError,
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

function formatYamlParseError(error: unknown): string {
  if (!(error instanceof YAMLParseError)) {
    return "Invalid YAML.";
  }

  const position = error.linePos?.[0];
  const location = position === undefined ? "" : `, line=${position.line}, column=${position.col}`;
  return `Invalid YAML (code=${error.code}${location}).`;
}

/** Parses YAML during decoding, reporting parse failures as InvalidValue issues. */
function parseYaml<E extends string>(options?: YamlParseOptions): SchemaGetter.Getter<unknown, E> {
  return SchemaGetter.transformOrFail((input: E) =>
    Effect.try({
      try: () => parseYamlString(input, options) as unknown,
      catch: (error) => new SchemaIssue.InvalidValue({ message: formatYamlParseError(error) }),
    }),
  );
}

/** Serializes YAML during encoding, reporting stringify failures as InvalidValue issues. */
function stringifyYaml(options?: YamlStringifyOptions): SchemaGetter.Getter<string, unknown> {
  return SchemaGetter.transformOrFail((input: unknown) =>
    Effect.try({
      try: () => stringifyYamlValue(input, options),
      catch: () => new SchemaIssue.InvalidValue({ message: "Failed to stringify YAML." }),
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
