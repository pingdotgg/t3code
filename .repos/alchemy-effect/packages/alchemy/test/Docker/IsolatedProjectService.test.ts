import * as Docker from "@/Docker";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  materializeIsolatedProject,
  removeIsolatedProject,
} from "../IsolatedProject.ts";
import IsolatedProjectService, {
  SERVICE_EXTERNAL_PORT,
  project,
} from "./fixtures/isolated-project-service.ts";
import { ensureDockerSwarm } from "./Runtime.ts";

const { test } = Test.make({ providers: Docker.providers() });

// Proof on the local engine that the Docker.Service bun bootstrap boots when
// the service's `main` lives in an isolated project (see
// test/IsolatedProject.ts) — the bundle `cwd` resolves none of alchemy's
// dependencies, so the bootstrap's `@effect/platform-bun` / `alchemy/*`
// imports must be bundled by the virtual-entry plugin rather than found from
// the project root. With them left external bun dies at module load and the
// swarm task never listens.
test.provider(
  "service bundled from an isolated project serves HTTP",
  (stack) =>
    Effect.gen(function* () {
      yield* ensureDockerSwarm;
      yield* materializeIsolatedProject(project);
      yield* stack.destroy();

      try {
        const service = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* IsolatedProjectService;
          }),
        );
        expect(service.replicas).toBe(1);

        const base = `http://localhost:${SERVICE_EXTERNAL_PORT}`;
        const health = yield* HttpClient.get(`${base}/health`).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : Effect.fail(new Error(`/health returned ${res.status}`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
        );
        expect(health).toEqual({ ok: true });

        yield* stack.destroy();
      } finally {
        yield* removeIsolatedProject(project);
      }
    }),
  { timeout: 420_000 },
);
