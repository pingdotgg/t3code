import { spawn } from "node:child_process";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectResponse } from "../Utils/Http.ts";
import { expectWorkerExists, waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

// Prisma on a `Website.Vite` Worker, mirroring `@cloudflare/vite-plugin`'s
// `prisma` playground: a Prisma 7 client generated for `workerd` queries D1
// through `@prisma/adapter-d1`, deployed and under `alchemy dev`.

const { test } = Test.make({ providers: Cloudflare.providers() });
const { test: devTest } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureDir = pathe.resolve(import.meta.dirname, "vite-prisma-fixture");
const prismaCli = pathe.resolve(
  import.meta.dirname,
  "../../../node_modules/prisma7/build/index.js",
);

// `prisma generate`, as the playground's `postinstall`. Spawned async: the
// suite shares one bun process.
const prismaGenerate = (cwd: string) =>
  Effect.tryPromise(
    () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn("node", [prismaCli, "generate"], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`prisma generate exited ${code}:\n${output}`)),
        );
      }),
  );

describe("Website.Vite Prisma", () => {
  for (const mode of ["live", "dev"] as const) {
    const id = `VitePrisma${mode}`;
    (mode === "live" ? test : devTest).provider(
      `Vite prisma: queries D1 through Prisma's D1 adapter${mode === "dev" ? " (dev)" : ""}`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const rootDir = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-vite-prisma-",
            tempRoot,
            entries: ["package.json", "prisma", "migrations", "seed.sql", "src"],
          });
          yield* prismaGenerate(rootDir);
          const devLog = yield* Test.captureResourceLog(id);
          const site = yield* stack.deploy(
            Cloudflare.Website.Vite(id, {
              rootDir,
              main: "./src/index.ts",
              workersDev: true,
              compatibility: { date: "2024-12-30" },
              memo: { include: ["**/*"] },
              env: {
                DB: Cloudflare.D1.Database(`${id}DB`, {
                  migrations: pathe.join(rootDir, "migrations"),
                  importFiles: [pathe.join(rootDir, "seed.sql")],
                }),
              },
              ...(mode === "dev" ? { dev: { port: 0 } } : {}),
            }),
          );
          const url = site.url!.replace(/\/$/, "");
          const { accountId } = yield* yield* CloudflareEnvironment;
          if (mode === "live") yield* expectWorkerExists(site.workerName, accountId);
          yield* expectResponse(url, (res) => {
            if (res.status !== 200) return `status ${res.status} ${res.body.slice(0, 600)}`;
            try {
              expect(JSON.parse(res.body)).toEqual([
                { id: 1, email: "jane@prisma.io", name: "Jane Doe (Local)" },
              ]);
              return undefined;
            } catch {
              return `json ${res.body.slice(0, 300)}`;
            }
          });
          if (mode === "dev") {
            // Prisma's dependencies are pre-bundled before the first request.
            const log = yield* devLog;
            expect(log).not.toContain("optimized dependencies changed. reloading");
            expect(log).not.toContain("[vite] program reload");
          } else {
            yield* stack.destroy();
            yield* waitForWorkerToBeDeleted(site.workerName, accountId);
          }
        }).pipe(Effect.scoped, Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
      {
        tags: [
          "provider:cloudflare:d1",
          "provider:cloudflare:worker",
          mode === "dev" ? "local" : "live",
        ],
        timeout: 300_000,
      },
    );
  }
});
