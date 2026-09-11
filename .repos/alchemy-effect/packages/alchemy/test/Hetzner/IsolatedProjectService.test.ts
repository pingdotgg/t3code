import * as Hetzner from "@/Hetzner";
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
import IsolatedProjectApi, {
  project,
} from "./fixtures/isolated-project-service.ts";

const { test } = Test.make({ providers: Hetzner.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

// Live proof that the Hetzner bun bootstrap boots when the service's `main`
// lives in an isolated project (see test/IsolatedProject.ts) — the bundle
// `cwd` resolves none of alchemy's dependencies, so the bootstrap's
// `@effect/platform-bun` / `alchemy/*` imports must be bundled by the
// virtual-entry plugin rather than found from the project root. With them
// left external bun dies at module load under systemd and the port never
// answers.
test.provider.skipIf(!hasHetznerCreds)(
  "service bundled from an isolated project serves HTTP",
  (stack) =>
    Effect.gen(function* () {
      yield* materializeIsolatedProject(project);
      yield* stack.destroy();

      try {
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* IsolatedProjectApi;
          }),
        );
        expect(deployed.url).toBeTruthy();

        const health = yield* HttpClient.get(
          new URL("/health", deployed.url!),
        ).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : Effect.fail(new Error(`/health returned ${res.status}`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }),
        );
        expect(health).toEqual({ ok: true });

        yield* stack.destroy();
      } finally {
        yield* removeIsolatedProject(project);
      }
    }).pipe(logLevel),
  { timeout: 180_000, exclusive: true },
);
