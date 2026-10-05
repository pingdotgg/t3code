import { defineContract, model } from "@/Prisma/ORM/index.ts";
import {
  defineContract as nativeDefineContract,
  model as nativeModel,
} from "@prisma/orm-postgres/contract-builder";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { contract } from "./fixtures/client/contract.ts";

it.effect(
  "uses native Prisma functions and runtime metadata unchanged",
  () =>
    Effect.sync(() => {
      expect(defineContract).toBe(nativeDefineContract);
      expect(model).toBe(nativeModel);
      expect(
        contract.domain.namespaces.public.models.Post.relations.author,
      ).toMatchObject({
        cardinality: "N:1",
        nullable: false,
        to: { namespace: "public", model: "User" },
      });
      expect(
        contract.domain.namespaces.public.models.User.relations.posts,
      ).toMatchObject({
        cardinality: "1:N",
        to: { namespace: "public", model: "Post" },
      });
      expect(
        contract.storage.namespaces.public.entries.table.user.columns.id,
      ).toMatchObject({
        codecId: "pg/int4@1",
        default: { kind: "function", expression: "autoincrement()" },
      });
      expect(
        contract.storage.namespaces.public.entries.table.user.columns.email,
      ).not.toHaveProperty("many");
      expect(
        contract.storage.namespaces.public.entries.table.user.uniques,
      ).toContainEqual(expect.objectContaining({ columns: ["email"] }));
    }),
  { tags: ["unit", "provider:prisma", "provider:prisma:orm", "local"] },
);

it.effect(
  "preserves namespaces, defaults, and scalar lists",
  () =>
    Effect.sync(() => {
      const authored = defineContract(
        { namespaces: ["auth"] },
        ({ field, model }) => ({
          models: {
            Account: model("Account", {
              namespace: "auth",
              fields: {
                id: field.int().id().defaultSql("1"),
                tags: field.text().many(),
                name: field.text().optional(),
              },
            }).sql({ table: "account" }),
          },
        }),
      );
      expect(
        authored.domain.namespaces.auth.models.Account.storage,
      ).toMatchObject({ namespaceId: "auth", table: "account" });
      expect(
        authored.storage.namespaces.auth.entries.table.account.columns.tags,
      ).toMatchObject({ codecId: "pg/text@1", many: true });
      expect(
        authored.storage.namespaces.auth.entries.table.account.columns.name,
      ).toMatchObject({ nullable: true });
    }),
  { tags: ["unit", "provider:prisma", "provider:prisma:orm", "local"] },
);
