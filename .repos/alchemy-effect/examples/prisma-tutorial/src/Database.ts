import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";

export const Project = Prisma.Project("Project", {
  createDatabase: false,
  region: "eu-west-3",
});

export const Postgres = Prisma.Postgres(
  "Postgres",
  Effect.gen(function* () {
    const project = yield* Project;
    return { project, region: "eu-west-3" as const, branchGitName: "main" };
  }),
);

export const Connection = Prisma.Connection(
  "Connection",
  Effect.gen(function* () {
    const database = yield* Postgres;
    return { database, name: "api" };
  }),
);
