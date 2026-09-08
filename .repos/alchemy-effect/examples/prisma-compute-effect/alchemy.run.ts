import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Connection, Postgres, Project } from "./src/Database.ts";

export default Alchemy.Stack(
  "PrismaComputeEffect",
  {
    providers: Prisma.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const project = yield* Project;
    const postgres = yield* Postgres;
    const connection = yield* Connection;
    const api = yield* Api;

    return {
      projectId: project.projectId,
      branchId: postgres.branchId,
      databaseId: postgres.databaseId,
      connectionId: connection.connectionId,
      appId: api.appId,
      deploymentId: api.deploymentId,
      url: api.url,
    };
  }),
);
