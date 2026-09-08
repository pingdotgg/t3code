import { Stage } from "alchemy";
import * as Prisma from "alchemy/Prisma";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const region = "eu-west-3" as const;

export const appNameConfig = Effect.gen(function* () {
  const stage = yield* Stage;
  return yield* Config.string("PRISMA_EFFECT_APP").pipe(
    Effect.orElseSucceed(() => `alchemy-prisma-compute-effect-${stage}`),
  );
});

export const Project = Prisma.Project(
  "Project",
  Effect.gen(function* () {
    return {
      name: yield* Config.string("PRISMA_PROJECT").pipe(
        Effect.orElseSucceed(() => undefined),
      ),
      createDatabase: false,
      region,
    };
  }),
);

export const Postgres = Prisma.Postgres(
  "Postgres",
  Effect.gen(function* () {
    const project = yield* Project;
    return {
      project,
      region,
      // Project creation owns the default `main` branch. Select it by its
      // Management API natural key instead of trying to create it again.
      branchGitName: "main",
    };
  }),
);

export const Connection = Prisma.Connection(
  "Connection",
  Effect.gen(function* () {
    const postgres = yield* Postgres;
    return {
      database: postgres,
      name: "api",
    };
  }),
);
