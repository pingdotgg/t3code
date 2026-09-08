import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

/**
 * A Drizzle schema + Neon project + feature branch. The branch's
 * `migrations` prop is wired to the schema resource, so the
 * provider order becomes:
 *
 *   1. `Drizzle.Schema` regenerates pending migration SQL files.
 *   2. `Neon.Branch` scans the directory and applies any new migrations
 *      transactionally.
 */
export const NeonDb = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;

  const schema = yield* Drizzle.Schema("app-schema", {
    schema: "./src/schema.ts",
    out: "./migrations",
  });

  const project = stage.startsWith("pr-")
    ? yield* Neon.Project.ref("app-db", { stage: `staging-${stage}` })
    : yield* Neon.Project("app-db", {
        region: "aws-us-east-1",
      });

  const branch = yield* Neon.Branch("app-branch", {
    project,
    migrations: schema,
  });

  return { project, branch, schema };
});

export const Hyperdrive = Effect.gen(function* () {
  const { branch } = yield* NeonDb;
  return yield* Cloudflare.Hyperdrive.Connection("app-hyperdrive", {
    origin: branch.origin,
  });
});
