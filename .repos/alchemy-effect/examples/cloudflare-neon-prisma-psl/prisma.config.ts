import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";
import { definePrismaConfig } from "prisma/config";
import { withEffect } from "alchemy/Prisma/ORM/generator";

export default definePrismaConfig({
  orm: withEffect(
    ormConfig({
      contract: "./src/prisma/contract.psl",
      output: "./src/prisma/generated",
    }),
    { client: true, schemas: true },
  ),
});
