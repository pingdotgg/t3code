import { Task } from "@/AWS/ECS/Task.ts";
import * as Effect from "effect/Effect";
import pg from "pg";

/**
 * Regression fixture for CommonJS dual-package resolution in bundled
 * programs: `pg` is a CJS consumer whose `require("pg-pool")` used to
 * receive pg-pool's ESM namespace (the bundlers' `conditionNames` listed
 * `"import"`, which applies to BOTH import kinds, and pg-pool's `exports`
 * lists `import` first) — the module then died AT LOAD with
 * `TypeError: The superclass is not a constructor`, before any user code.
 *
 * Importing `pg` and constructing a Pool in a deployed task pins the whole
 * path behaviorally: a mis-resolved bundle exits 1 at boot; a correct one
 * logs the marker and exits 0.
 */
export class CjsDualPackageTask extends Task<CjsDualPackageTask>()(
  "EcsCjsDualPackageTask",
) {}

export default CjsDualPackageTask.make(
  {
    main: import.meta.filename,
    // Docker Hub's `oven/bun`; the public.ecr.aws default mirror rate-limits
    // anonymous pulls during local builds (see fixtures/task.ts).
    image: "oven/bun:1",
    cpu: 256,
    memory: 512,
    // Build/run on ARM64 so an image built on an Apple Silicon host matches
    // the Fargate runtime architecture (Graviton).
    runtimePlatform: {
      cpuArchitecture: "ARM64",
      operatingSystemFamily: "LINUX",
    },
    taskName: "alchemy-test-ecs-cjs-dual",
  },
  Effect.gen(function* () {
    return {
      run: Effect.gen(function* () {
        // Constructing (not connecting) exercises pg-pool's BoundPool class
        // — the exact site that died when Pool was a module namespace.
        const pool = new pg.Pool({
          connectionString: "postgres://user:pass@localhost:5432/db",
        });
        yield* Effect.log(
          `alchemy-cjs-dual-ran: query=${typeof pool.query === "function"}`,
        );
        yield* Effect.promise(() => pool.end());
      }),
    };
  }),
);
