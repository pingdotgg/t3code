import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";

/**
 * A Prisma contract + Neon project + branch. Passing the contract's
 * output to `Prisma.Migrate` orders the deploy:
 *
 *   1. `Prisma.Contract` re-emits the contract and plans a migration
 *      package when the contract drifted from the migration graph.
 *   2. `Prisma.Migrate` applies pending packages to the branch
 *      (graph-ordered, tracked by the database's contract marker).
 */
export const NeonDb = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;

  const contract = yield* Prisma.Contract("app-contract");

  const project = stage.startsWith("pr-")
    ? yield* Neon.Project.ref("app-db", { stage: `staging-${stage}` })
    : yield* Neon.Project("app-db", {
        region: "aws-us-east-1",
      });

  const branch = yield* Neon.Branch("app-branch", { project });

  const migrate = yield* Prisma.Migrate("app-migrate", {
    url: branch.connectionUri,
    contract,
  });

  return { project, branch, contract, migrate };
});

export const Hyperdrive = Effect.gen(function* () {
  const { branch } = yield* NeonDb;
  return yield* Cloudflare.Hyperdrive.Connection("app-hyperdrive", {
    origin: branch.origin,
    caching: { disabled: true },
  });
});
