import { withEffect } from "@alchemy.run/prisma/ORM/generator";
import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";
import { definePrismaConfig } from "prisma/config";

export default definePrismaConfig({
  orm: withEffect(
    ormConfig({
      contract: "./contract.psl",
      output: "./generated",
    }),
  ),
});
