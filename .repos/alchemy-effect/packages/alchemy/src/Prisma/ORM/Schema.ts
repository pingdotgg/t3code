import type {
  Contract,
  ContractField,
  ContractModel,
} from "@prisma/orm-postgres/contract/types";
import type { SqlStorage } from "@prisma/orm-postgres/family-contract/types";
import type { DefaultModelRow } from "@prisma/orm-postgres/orm-client";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";

/** An unsupported contract field requires an explicit codec mapping. */
export class SchemaError extends Data.TaggedError("Prisma.SchemaError")<{
  readonly field: string;
  readonly message: string;
}> {}

/** A custom codec's row validator and its standalone TypeScript expression. */
export interface CodecSchema {
  readonly schema: Schema.Codec<unknown, unknown>;
  /** Expression using `Schema` or names declared by `imports`. */
  readonly expression: string;
  /** Import declarations copied into standalone schema modules. */
  readonly imports?: readonly string[];
}

export interface SchemaOptions {
  readonly codecs?: Readonly<Record<string, CodecSchema>>;
}

export type ModelSchemas<C extends Contract<SqlStorage>> = {
  readonly [Ns in keyof C["domain"]["namespaces"] & string]: {
    readonly [
      M in keyof C["domain"]["namespaces"][Ns]["models"] & string
    ]: Schema.Codec<DefaultModelRow<C, M, Ns>, unknown>;
  };
};

const builtin = (
  schema: Schema.Codec<unknown, unknown>,
  expression: string,
): CodecSchema => ({ schema, expression });
const text = builtin(Schema.String, "Schema.String");
const int = builtin(Schema.Int, "Schema.Int");
const float = builtin(Schema.Number, "Schema.Number");
const bigint = builtin(Schema.BigInt, "Schema.BigInt");
const codecs: Readonly<Record<string, CodecSchema>> = {
  "pg/text@1": text,
  "sql/text@1": text,
  "pg/date-string@1": text,
  "pg/timestamp-string@1": text,
  "pg/timestamptz-string@1": text,
  "pg/time-string@1": text,
  "pg/char@1": text,
  "pg/varchar@1": text,
  "sql/char@1": text,
  "sql/varchar@1": text,
  "pg/inet@1": text,
  "pg/interval@1": text,
  "pg/timetz@1": text,
  "pg/bit@1": text,
  "pg/varbit@1": text,
  "pg/int@1": int,
  "sql/int@1": int,
  "pg/int4@1": int,
  "pg/int2@1": int,
  "pg/int8number@1": int,
  "pg/int8@1": bigint,
  "pg/unboundedint@1": bigint,
  "pg/float@1": float,
  "sql/float@1": float,
  "pg/float4@1": float,
  "pg/float8@1": float,
  "pg/bool@1": builtin(Schema.Boolean, "Schema.Boolean"),
  "pg/bytea@1": builtin(Schema.Uint8Array, "Schema.Uint8Array"),
  "pg/uuid@1": builtin(
    Schema.String.check(Schema.isGUID()),
    "Schema.String.check(Schema.isGUID())",
  ),
  "pg/numeric@1": builtin(
    Schema.String.check(
      Schema.isPattern(
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$|^(?:NaN|Infinity|-Infinity)$/,
      ),
    ),
    "Schema.String.check(Schema.isPattern(/^[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?$|^(?:NaN|Infinity|-Infinity)$/))",
  ),
  "pg/json@1": builtin(Schema.Json, "Schema.Json"),
  "pg/jsonb@1": builtin(Schema.Json, "Schema.Json"),
};

function fieldSchema(
  contract: Contract<SqlStorage>,
  field: ContractField,
  name: string,
  options: SchemaOptions,
): CodecSchema {
  const fail = (message: string): never => {
    throw new SchemaError({ field: name, message: `${name}: ${message}` });
  };
  if (field.type.kind !== "scalar")
    return fail(
      `unsupported ${field.type.kind} field; use an explicit application schema`,
    );
  const codec = field.type.codecId;
  let value: CodecSchema | undefined =
    options.codecs && Object.hasOwn(options.codecs, codec)
      ? options.codecs[codec]
      : undefined;
  if (!value && field.valueSet) {
    const ref = field.valueSet;
    if (ref.spaceId || ref.entityKind !== "enum")
      return fail("external value sets require an explicit codec mapping");
    const enumeration =
      contract.domain.namespaces[ref.namespaceId]?.enum?.[ref.entityName];
    if (!enumeration)
      return fail(`enum ${ref.namespaceId}.${ref.entityName} is missing`);
    const literals = enumeration.members.map((member) => member.value);
    if (
      !literals.every(
        (literal): literal is string | number | boolean =>
          typeof literal === "string" ||
          typeof literal === "number" ||
          typeof literal === "boolean",
      )
    ) {
      return fail(
        "non-primitive enum values require an explicit codec mapping",
      );
    }
    value = builtin(
      Schema.Literals(literals),
      `Schema.Literals(${JSON.stringify(literals)})`,
    );
  }
  value ??= Object.hasOwn(codecs, codec) ? codecs[codec] : undefined;
  if (!value)
    return fail(
      `unsupported codec ${codec}; supply options.codecs[${JSON.stringify(codec)}] with a schema and standalone expression`,
    );
  let { schema, expression } = value;
  if (field.many) {
    schema = Schema.Array(schema);
    expression = `Schema.Array(${expression})`;
  }
  if (field.dict) {
    schema = Schema.Record(Schema.String, schema);
    expression = `Schema.Record(Schema.String, ${expression})`;
  }
  if (field.nullable) {
    schema = Schema.NullOr(schema);
    expression = `Schema.NullOr(${expression})`;
  }
  return { ...value, schema, expression };
}

function rowFields(model: ContractModel, name: string) {
  if (model.base || model.variants || model.discriminator) {
    throw new SchemaError({
      field: name,
      message: `${name}: variant and inherited models require an explicit application schema`,
    });
  }
  return model.fields;
}

/**
 * Derive scalar row validators without opening a database connection.
 * Relations and mutation defaults are not row fields. These are database row
 * schemas, not create/update inputs or public API response definitions.
 */
export function makeSchemas<C extends Contract<SqlStorage>>(
  contract: C,
  options: SchemaOptions = {},
): ModelSchemas<C> {
  return Object.fromEntries(
    Object.entries(contract.domain.namespaces).map(([ns, namespace]) => [
      ns,
      Object.fromEntries(
        Object.entries(namespace.models).map(([model, definition]) => [
          model,
          Schema.Struct(
            Object.fromEntries(
              Object.entries(rowFields(definition, `${ns}.${model}`)).map(
                ([name, field]) => [
                  name,
                  fieldSchema(
                    contract,
                    field,
                    `${ns}.${model}.${name}`,
                    options,
                  ).schema,
                ],
              ),
            ),
          ),
        ]),
      ),
    ]),
  ) as unknown as ModelSchemas<C>;
}

const propertyKey = (name: string) =>
  name === "__proto__" ? '["__proto__"]' : JSON.stringify(name);

/** Emit a standalone module importing only Effect and explicit custom mappings. */
export function emitSchemas(
  contract: Contract<SqlStorage>,
  options: SchemaOptions = {},
): string {
  const imports = new Set<string>();
  const namespaces = Object.entries(contract.domain.namespaces)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ns, namespace]) => {
      const models = Object.entries(namespace.models)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([model, definition]) => {
          const fields = Object.entries(rowFields(definition, `${ns}.${model}`))
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([name, field]) => {
              const mapped = fieldSchema(
                contract,
                field,
                `${ns}.${model}.${name}`,
                options,
              );
              for (const statement of mapped.imports ?? [])
                imports.add(statement);
              return `      ${propertyKey(name)}: ${mapped.expression},`;
            });
          return `    ${propertyKey(model)}: Schema.Struct({\n${fields.join("\n")}\n    }),`;
        });
      return `  ${propertyKey(ns)}: {\n${models.join("\n")}\n  },`;
    });
  return `// Generated by alchemy prisma generate.\nimport * as Schema from "effect/Schema";\n${[...imports].sort().join("\n")}\nexport const schemas = {\n${namespaces.join("\n")}\n} as const;\n`;
}
