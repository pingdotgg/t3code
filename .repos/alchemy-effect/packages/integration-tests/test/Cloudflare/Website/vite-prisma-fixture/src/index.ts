import { PrismaD1 } from "@prisma/adapter-d1";
import { PrismaClient } from "./generated/prisma/client";

interface Env {
  DB: D1Database;
}

export default {
  async fetch(_, env) {
    const adapter = new PrismaD1(env.DB);
    const prisma = new PrismaClient({ adapter });
    const users = await prisma.user.findMany();

    return Response.json(users);
  },
} satisfies ExportedHandler<Env>;
