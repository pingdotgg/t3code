/**
 * Repro rig for the "green destroy but leaked state" race (leaked
 * rpchttpteststack-* / rpcworkerbindingstack-* workers in the 2026-08-05
 * full-suite run): a `destroy(Stack)` whose plan printed "no changes"
 * even though the localState stage dir had committed rows on disk.
 *
 * Mirrors the Test/Alchemy harness topology exactly: each simulated "file"
 * loops deploy -> destroy of its own `Alchemy.Stack` with `localState()`,
 * through Core.deploy / Core.destroy / Core.toEffect with a shared scope,
 * with K files running concurrently to simulate full-suite load.
 *
 * An anomaly is any iteration where, after a successful destroy, the
 * stage directory still exists with state rows in it.
 *
 * Run from packages/alchemy:
 *   bun test/State/destroy-consistency-repro.ts [files] [iterations]
 */
import * as Alchemy from "@/index.ts";
import * as Core from "@/Test/Core.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { Bucket, TestLayers } from "../test.resources.ts";

const FILES = Number(process.argv[2] ?? 16);
const ITERATIONS = Number(process.argv[3] ?? 50);

const stateRoot = path.join(process.cwd(), ".alchemy", "state");

let anomalies = 0;
let completed = 0;

const simulateFile = async (fileIdx: number) => {
  const stackName = `DestroyRaceRepro${fileIdx}`;
  const stack = Alchemy.Stack(
    stackName,
    {
      providers: TestLayers(),
      state: Alchemy.localState(),
    },
    Effect.gen(function* () {
      const bucket = yield* Bucket(`bucket`, { name: `repro-${fileIdx}` });
      return { arn: bucket.bucketArn.as<string>() };
    }),
  );
  const options: Core.MakeOptions = { providers: TestLayers() };

  for (let i = 0; i < ITERATIONS; i++) {
    // fresh scope per iteration, like a fresh test file
    const scope = Scope.makeUnsafe("sequential");
    const run = <A>(eff: Core.TestEffect<A>) =>
      Effect.runPromise(Core.toEffect(eff, options, scope) as Effect.Effect<A>);
    try {
      await run(Core.deploy(options, stack as any, { scope }));
      const stageDir = path.join(stateRoot, stackName, "test");
      if (!existsSync(stageDir) || readdirSync(stageDir).length === 0) {
        anomalies++;
        console.error(
          `ANOMALY[deploy] iter=${i} file=${fileIdx}: state dir missing/empty after deploy`,
        );
      }
      await run(Core.destroy(options, stack as any, { scope }));
      if (existsSync(stageDir)) {
        const rows = readdirSync(stageDir);
        anomalies++;
        console.error(
          `ANOMALY[destroy] iter=${i} file=${fileIdx}: stage dir survived destroy: ${JSON.stringify(rows)}`,
        );
      }
    } finally {
      await Effect.runPromise(
        Effect.suspend(() => Scope.close(scope, Exit.void)).pipe(Effect.ignore),
      );
    }
    completed++;
    if (completed % 100 === 0) {
      console.log(
        `progress: ${completed}/${FILES * ITERATIONS} anomalies=${anomalies}`,
      );
    }
  }
};

const t0 = Date.now();
await Promise.all(Array.from({ length: FILES }, (_, i) => simulateFile(i)));
console.log(
  `done: ${FILES * ITERATIONS} deploy/destroy cycles in ${((Date.now() - t0) / 1000).toFixed(1)}s, anomalies=${anomalies}`,
);
process.exit(anomalies > 0 ? 1 : 0);
