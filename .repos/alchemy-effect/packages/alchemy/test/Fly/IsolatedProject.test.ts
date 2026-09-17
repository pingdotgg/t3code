import * as Fly from "@/Fly";
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
  IsolatedSite,
  project as serviceProject,
} from "./fixtures/isolated-project-service.ts";
import IsolatedProjectBox, {
  project as spriteProject,
} from "./fixtures/isolated-project-sprite.ts";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const healthOk = (url: string) =>
  HttpClient.get(new URL("/health", url)).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json
        : Effect.fail(new Error(`/health returned ${res.status}`)),
    ),
    Effect.retry({ schedule: Schedule.spaced("4 seconds"), times: 15 }),
  );

// Live proof that the Fly bun bootstrap (shared by Service and Sprite) boots
// when `main` lives in an isolated project (see test/IsolatedProject.ts) —
// the bundle `cwd` resolves none of alchemy's dependencies, so the
// bootstrap's `@effect/platform-bun` / `alchemy/*` imports must be bundled
// by the virtual-entry plugin rather than found from the project root. With
// them left external bun dies at module load and the app never answers.
test.provider(
  "service bundled from an isolated project serves HTTP",
  (stack) =>
    Effect.gen(function* () {
      yield* materializeIsolatedProject(serviceProject);
      yield* stack.destroy();

      try {
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const app = yield* IsolatedSite;
            yield* Fly.IpAssignment("IsolatedProjectShared", {
              app,
              type: "shared_v4",
            });
            return yield* IsolatedProjectApi;
          }),
        );
        expect(deployed.state).toEqual("started");
        expect(deployed.url).toBeTruthy();

        expect(yield* healthOk(deployed.url!)).toEqual({ ok: true });

        yield* stack.destroy();
      } finally {
        yield* removeIsolatedProject(serviceProject);
      }
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "sprite bundled from an isolated project serves HTTP",
  (stack) =>
    Effect.gen(function* () {
      yield* materializeIsolatedProject(spriteProject);
      yield* stack.destroy();

      try {
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* IsolatedProjectBox;
          }),
        );
        expect(deployed.url).toContain("sprites.app");

        expect(yield* healthOk(deployed.url)).toEqual({ ok: true });

        yield* stack.destroy();
      } finally {
        yield* removeIsolatedProject(spriteProject);
      }
    }).pipe(logLevel),
  { timeout: 180_000 },
);
