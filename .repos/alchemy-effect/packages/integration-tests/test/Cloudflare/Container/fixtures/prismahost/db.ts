import { Connection } from "@alchemy.run/prisma/Connection";
import { Postgres } from "@alchemy.run/prisma/Postgres";
import { Project } from "@alchemy.run/prisma/Project";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";

/**
 * Local Prisma Postgres used as the container's DATABASE_URL origin — the
 * #1334 demo shape (arbitrary image + connection.directConnectionString).
 */
export const PrismaHostConnection = Effect.gen(function* () {
  const project = yield* Project("PrismaHostProject", {
    createDatabase: false,
  });
  const database = yield* Postgres("PrismaHostDb", {
    project,
    name: "main",
    dev: {
      name: `alchemy-container-prisma-host-${yield* Stage}`,
      persistenceMode: "stateless",
    },
  });
  return yield* Connection("PrismaHostConnection", { database });
});
