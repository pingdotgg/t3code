import "./validation.ts";
import { defineContract } from "@/Prisma/ORM/index.ts";

export const contract = defineContract(
  { extensions: {} },
  ({ field, model }) => ({
    models: {
      Widget: model("Widget", {
        fields: {
          id: field
            .int()
            .id()
            .default({ kind: "function", expression: "autoincrement()" }),
          name: field.text(),
        },
      }).sql({ table: "widget" }),
    },
  }),
);
