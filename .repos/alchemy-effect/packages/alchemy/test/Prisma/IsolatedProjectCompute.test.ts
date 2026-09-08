import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  materializeIsolatedProject,
  removeIsolatedProject,
} from "../IsolatedProject.ts";
import IsolatedProjectCompute, {
  project,
} from "./fixtures/isolated-project-compute.ts";

const { test } = Test.make({ providers: Prisma.providers() });

// Same live gating as Compute.live.test.ts.
const wantsLive = process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS === "true";
const hasLiveCredentials =
  !!process.env.PRISMA_SERVICE_TOKEN?.trim() ||
  !!process.env.PRISMA_API_TOKEN?.trim() ||
  process.env.ALCHEMY_RUN_LIVE_PRISMA_WITH_PROFILE === "true";
const runLive = wantsLive && hasLiveCredentials;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Live proof that the Prisma Compute bun bootstrap boots when the app's
// `main` lives in an isolated project (see test/IsolatedProject.ts) — the
// bundle `cwd` resolves none of alchemy's dependencies, so the bootstrap's
// `@effect/platform-bun` / `alchemy/*` imports must be bundled by the
// virtual-entry plugin rather than found from the project root. With them
// left external bun dies at module load and the app never answers.
test.provider.skipIf(!runLive)(
  "app bundled from an isolated project serves HTTP",
  (stack) =>
    Effect.gen(function* () {
      yield* materializeIsolatedProject(project);
      yield* stack.destroy();

      try {
        const app = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* IsolatedProjectCompute;
          }),
        );
        expect(app.url).toBeTruthy();

        const health = yield* HttpClient.get(new URL("/health", app.url)).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : Effect.fail(new Error(`/health returned ${res.status}`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
        );
        expect(health).toEqual({ ok: true });
      } finally {
        yield* stack.destroy().pipe(Effect.ignore);
        yield* removeIsolatedProject(project);
      }
    }).pipe(logLevel),
  // One Prisma Compute deploy alone can take the full 600s.
  { timeout: 1_200_000 },
);
