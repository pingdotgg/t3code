import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";
import { definePrismaConfig } from "prisma/config";
import { withEffect } from "alchemy/Prisma/ORM/generator";

export default definePrismaConfig({
  orm: withEffect(
    ormConfig({ contract: "./contract.psl", output: "./generated" }),
    { client: true, schemas: false },
  ),
});
