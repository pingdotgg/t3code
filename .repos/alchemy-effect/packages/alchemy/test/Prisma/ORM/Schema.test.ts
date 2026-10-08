import {
  defineContract,
  enumType,
  field,
  member,
  model,
} from "@/Prisma/ORM/index.ts";
import { emitSchemas, makeSchemas, SchemaError } from "@/Prisma/ORM/Schema.ts";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { contract } from "./fixtures/client/contract.ts";

it.effect(
  "derives row schemas without a client and preserves nullable fields",
  () =>
    Effect.gen(function* () {
      const schemas = makeSchemas(contract);
      const row = yield* Schema.decodeUnknownEffect(schemas.public.User)({
        id: 1,
        email: "a@example.com",
        name: null,
      });
      expect(row).toEqual({ id: 1, email: "a@example.com", name: null });
      expect(
        Schema.is(schemas.public.User)({
          id: "1",
          email: "a@example.com",
          name: null,
        }),
      ).toBe(false);
      expect(
        Schema.is(schemas.public.User)({ id: 1, email: "a@example.com" }),
      ).toBe(false);
      expect(
        Schema.is(schemas.public.User)({
          id: 1.5,
          email: "a@example.com",
          name: null,
        }),
      ).toBe(false);
    }),
  { tags: ["unit", "provider:prisma", "provider:prisma:orm", "local"] },
);

it.effect(
  "maps lists and namespaces without including navigation relations",
  () =>
    Effect.sync(() => {
      const contract = defineContract(
        { namespaces: ["auth"] },
        ({ field, model }) => ({
          models: {
            Account: model("Account", {
              namespace: "auth",
              fields: {
                id: field.int().id(),
                tags: field.text().many(),
                name: field.text().optional(),
              },
            }),
          },
        }),
      );
      const schemas = makeSchemas(contract);
      expect(
        Schema.is(schemas.auth.Account)({ id: 1, tags: ["a"], name: null }),
      ).toBe(true);
      expect(
        Schema.is(schemas.auth.Account)({ id: 1, tags: [1], name: null }),
      ).toBe(false);
      expect(emitSchemas(contract)).not.toContain("Postgres");
      expect(emitSchemas(contract)).not.toContain("@prisma");
    }),
  { tags: ["unit", "provider:prisma", "provider:prisma:orm", "local"] },
);

it.effect(
  "preserves enums, bigint, decimals, bytes, temporal strings, and JSON",
  () =>
    Effect.sync(() => {
      const Status = enumType(
        "Status",
        { codecId: "pg/text@1", nativeType: "text" },
        member("Active", "active"),
        member("Inactive", "inactive"),
      );
      const contract = defineContract({
        enums: { Status },
        models: {
          Value: model("Value", {
            fields: {
              id: field
                .column({ codecId: "pg/int8@1", nativeType: "int8" })
                .id(),
              decimal: field.column({
                codecId: "pg/numeric@1",
                nativeType: "numeric",
              }),
              bytes: field.column({
                codecId: "pg/bytea@1",
                nativeType: "bytea",
              }),
              uuid: field.column({ codecId: "pg/uuid@1", nativeType: "uuid" }),
              date: field.column({
                codecId: "pg/date-string@1",
                nativeType: "date",
              }),
              json: field.column({
                codecId: "pg/jsonb@1",
                nativeType: "jsonb",
              }),
              status: field.namedType(Status),
            },
          }),
        },
      });
      const schema = makeSchemas(contract).public.Value;
      const row = {
        id: 9007199254740993n,
        decimal: "12345678901234567890.123456",
        bytes: new Uint8Array([1]),
        date: "2026-09-18",
        uuid: "00000000-0000-0000-0000-000000000001",
        json: { nested: [null, 1, true] },
        status: "active",
      };
      expect(Schema.is(schema)(row)).toBe(true);
      expect(Schema.is(schema)({ ...row, id: 1 })).toBe(false);
      expect(Schema.is(schema)({ ...row, decimal: 1.5 })).toBe(false);
      expect(Schema.is(schema)({ ...row, decimal: "invalid" })).toBe(false);
      expect(Schema.is(schema)({ ...row, json: { invalid: undefined } })).toBe(
        false,
      );
      expect(Schema.is(schema)({ ...row, status: "missing" })).toBe(false);
      expect(emitSchemas(contract)).toContain(
        'Schema.Literals(["active","inactive"])',
      );
    }),
  { tags: ["unit", "provider:prisma", "provider:prisma:orm", "local"] },
);

it.effect(
  "emits deterministic standalone expressions for the same contract",
  () =>
    Effect.sync(() => {
      const first = emitSchemas(contract);
      expect(first).toBe(emitSchemas(contract));
      expect(first).toContain('"name": Schema.NullOr(Schema.String)');
      expect(first).not.toContain('"posts":');
      expect(first).not.toContain('"author":');
    }),
  { tags: ["unit", "provider:prisma", "provider:prisma:orm", "local"] },
);

it.effect(
  "rejects unsupported codecs instead of silently accepting unknown rows",
  () =>
    Effect.sync(() => {
      const custom = {
        ...contract,
        domain: {
          namespaces: {
            public: {
              models: {
                Custom: {
                  fields: {
                    id: {
                      nullable: false,
                      type: { kind: "scalar" as const, codecId: "custom/id@1" },
                    },
                  },
                  relations: {},
                  storage: {},
                },
              },
            },
          },
        },
      };
      expect(() => makeSchemas(custom)).toThrow(SchemaError);
      expect(() => emitSchemas(custom)).toThrow(
        'options.codecs["custom/id@1"]',
      );
      const options = {
        codecs: {
          "custom/id@1": { schema: Schema.String, expression: "Schema.String" },
        },
      };
      expect(
        Schema.is(makeSchemas(custom, options).public.Custom)({ id: "custom" }),
      ).toBe(true);
      expect(emitSchemas(custom, options)).toContain('"id": Schema.String');
    }),
  { tags: ["unit", "provider:prisma", "provider:prisma:orm", "local"] },
);
