#!/usr/bin/env bun
/**
 * Delete every Neon project visible to `NEON_API_KEY`.
 *
 * Usage:
 *   doppler run -c dev --project alchemy-v2 -- bun packages/alchemy/scripts/cleanup-neon-projects.ts
 *   DRY_RUN=1 doppler run -c dev --project alchemy-v2 -- bun packages/alchemy/scripts/cleanup-neon-projects.ts
 *   CONCURRENCY=4 doppler run -c dev --project alchemy-v2 -- bun packages/alchemy/scripts/cleanup-neon-projects.ts
 *
 * Environment:
 *   NEON_API_KEY   Required. Injected by Doppler (`alchemy-v2` / `dev`) or `.env` via `bun download:env`.
 *   DRY_RUN        Set to `1` to list projects without deleting.
 *   CONCURRENCY    Parallel deletes (default 4).
 */
import {
  CredentialsFromEnv,
  deleteProject,
  listProjects,
  Retry,
} from "@distilled.cloud/neon";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const DRY_RUN = process.env.DRY_RUN === "1";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 4));

if (!process.env.NEON_API_KEY) {
  console.error("NEON_API_KEY is not set");
  process.exit(1);
}

console.log(
  `→ neon cleanup dryRun=${DRY_RUN} concurrency=${CONCURRENCY} (listing projects…)`,
);

let total = 0;
let ok = 0;
let fail = 0;

const program = listProjects.pages({ limit: 400 }).pipe(
  Stream.tap((page) =>
    Effect.sync(() => console.log(`→ page: ${page.projects.length} projects`)),
  ),
  Stream.flatMap((page) => Stream.fromIterable(page.projects)),
  Stream.tap((p: { id: string; name: string }) =>
    Effect.sync(() => {
      total += 1;
      console.log(`   - ${p.name} (${p.id})`);
    }),
  ),
  Stream.mapEffect(
    (p) =>
      DRY_RUN
        ? Effect.void
        : deleteProject({ project_id: p.id }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                ok += 1;
                console.log(`✓ deleted ${p.name} (${ok})`);
              }),
            ),
            Effect.catchTag("NotFound", () =>
              Effect.sync(() => {
                ok += 1;
                console.log(`✓ already gone ${p.name}`);
              }),
            ),
            Effect.catch((e) =>
              Effect.sync(() => {
                fail += 1;
                console.error(`✗ ${p.name} (${p.id}): ${String(e)}`);
              }),
            ),
          ),
    { concurrency: CONCURRENCY },
  ),
  Stream.runDrain,
  Effect.tap(() =>
    Effect.sync(() =>
      console.log(`→ done: total=${total} deleted=${ok} failed=${fail}`),
    ),
  ),
);

const runtime = Layer.mergeAll(
  CredentialsFromEnv,
  FetchHttpClient.layer,
  Layer.succeed(Retry.Retry, { while: () => false }),
);

Effect.runPromise(program.pipe(Effect.provide(runtime))).catch((error) => {
  console.error(error);
  process.exit(1);
});
